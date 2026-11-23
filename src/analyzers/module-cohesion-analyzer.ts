import * as O from "fp-ts/lib/Option.js";
import * as Ord from "fp-ts/lib/Ord.js";
import * as P from "fp-ts/lib/Predicate.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as S from "fp-ts/lib/string.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { normalizeFilePath } from "../lib/source-paths.js";
import { unwrapContainerTsTypes } from "../lib/ts-container-types.js";
import { collectTsNodes } from "../lib/ts-node-traversal.js";
import { resolveTsTypeDeclarationFile } from "../lib/ts-type-declaration.js";
import { resolveTsTypeName } from "../lib/ts-type-name.js";
import {
  extractFileRuntimeExports,
  isBarrelFile,
  resolveCanonicalSymbol,
  RuntimeExport,
  unwrapExpression,
} from "./module-symbol-graph.js";

export type ModuleCohesionOptions = Readonly<
  Record<"ubiquitousTypes" | "primaryDomainTypes", ReadonlyArray<string>>
>;

export type CohesionCluster = Readonly<{
  readonly exports: ReadonlyArray<string>;
  readonly sharedReasons: ReadonlyArray<string>;
}>;

export type FileCohesionResult = Readonly<
  Record<"fileName", string> &
    Record<"isBarrel" | "isCohesive", true | false> &
    Record<"exportCount", number> & {
      readonly clusters: ReadonlyArray<CohesionCluster>;
    }
>;

export const DEFAULT_UBIQUITOUS_TYPES = [
  "Context",
  "Logger",
  "Config",
  "Request",
  "Response",
] as const satisfies ReadonlyArray<string>;

const PRIMITIVE_FLAGS =
  ts.TypeFlags.String |
  ts.TypeFlags.StringLiteral |
  ts.TypeFlags.Number |
  ts.TypeFlags.NumberLiteral |
  ts.TypeFlags.Boolean |
  ts.TypeFlags.BooleanLiteral |
  ts.TypeFlags.BigInt |
  ts.TypeFlags.BigIntLiteral |
  ts.TypeFlags.ESSymbol |
  ts.TypeFlags.UniqueESSymbol |
  ts.TypeFlags.Void |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Null |
  ts.TypeFlags.Never |
  ts.TypeFlags.Any |
  ts.TypeFlags.Unknown |
  ts.TypeFlags.NonPrimitive;

const STDLIB_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "Map",
  "ReadonlyMap",
  "WeakMap",
  "Set",
  "ReadonlySet",
  "WeakSet",
  "Promise",
  "Array",
  "ReadonlyArray",
  "Record",
  "ReadonlyRecord",
  "Readonly",
  "Partial",
  "Required",
  "Pick",
  "Omit",
  "Exclude",
  "Extract",
  "NonNullable",
  "ReturnType",
  "Parameters",
  "Awaited",
  "Function",
  "Object",
  "URL",
  "URLSearchParams",
  "Buffer",
  "ArrayBuffer",
  "Uint8Array",
  "Iterable",
  "AsyncIterable",
  "Iterator",
  "Generator",
]);

type DomainTypeScope = Readonly<
  Record<"sfPath", string> & {
    readonly checker: ts.TypeChecker;
    readonly ubiquitousSet: ReadonlySet<string>;
    readonly primarySet: ReadonlySet<string>;
  }
>;

type TypeWalkAcc = Readonly<{
  readonly visited: ReadonlySet<ts.Type>;
  readonly names: ReadonlyArray<string>;
}>;

type UnexportedLocalBinding = Readonly<
  Record<"name", string> & {
    readonly sym: ts.Symbol;
    readonly node: ts.Node;
  }
>;

type LocalRefGraph = Readonly<{
  readonly exportSymbolToName: ReadonlyMap<ts.Symbol, string>;
  readonly localBySym: ReadonlyMap<ts.Symbol, UnexportedLocalBinding>;
  readonly localDirectRefs: ReadonlyMap<ts.Symbol, ReadonlySet<ts.Symbol>>;
}>;

type TransitiveWalkState = Readonly<{
  readonly frontier: ReadonlyArray<ts.Symbol>;
  readonly visitedLocals: ReadonlySet<ts.Symbol>;
  readonly reachedExports: ReadonlySet<string>;
}>;

type ExportProfile = Readonly<
  Record<"name", string> & {
    readonly reachedExports: ReadonlySet<string>;
    readonly usedLocals: ReadonlySet<ts.Symbol>;
    readonly domainTypes: ReadonlySet<string>;
  }
>;

type CohesionNeighbor = Readonly<Record<"target" | "reason", string>>;
type CohesionAdjacency = Readonly<Record<string, ReadonlyArray<CohesionNeighbor>>>;

type ClusterWalkState = Readonly<{
  readonly pendingNodes: ReadonlyArray<string>;
  readonly seenNodes: ReadonlySet<string>;
  readonly clusterExports: ReadonlyArray<string>;
  readonly collectedReasons: ReadonlyArray<string>;
}>;

type ClusterPartitionAcc = Readonly<{
  readonly visited: ReadonlySet<string>;
  readonly clusters: ReadonlyArray<CohesionCluster>;
}>;

type ProfileBuildContext = Readonly<{
  readonly sf: ts.SourceFile;
  readonly scope: DomainTypeScope;
  readonly refGraph: LocalRefGraph;
}>;

type ProfilePairContext = Readonly<{
  readonly sourceProfile: ExportProfile;
  readonly targetProfile: ExportProfile;
  readonly localBySym: ReadonlyMap<ts.Symbol, UnexportedLocalBinding>;
}>;

type CohesionGraphInput = Readonly<{
  readonly profiles: ReadonlyArray<ExportProfile>;
  readonly localBySym: ReadonlyMap<ts.Symbol, UnexportedLocalBinding>;
}>;

type MultiExportContext = Readonly<{
  readonly sf: ts.SourceFile;
  readonly runtimeExports: ReadonlyArray<RuntimeExport>;
  readonly scope: DomainTypeScope;
}>;

type ExtractedTargetTypes = Readonly<{
  readonly types: ReadonlyArray<ts.Type>;
  readonly typeNodes: ReadonlyArray<ts.TypeNode>;
}>;

const EMPTY_TARGET_TYPES: ExtractedTargetTypes = {
  types: [],
  typeNodes: [],
};

const isNormalizedStdlibPath = (normPath: string) =>
  (normPath.includes("/typescript/lib/lib.") && normPath.endsWith(".d.ts")) ||
  normPath.includes("/node_modules/@types/node/");

const isStdlibDeclFile = flow(normalizeFilePath, isNormalizedStdlibPath);

const isPrimitiveTsType = (type: ts.Type) => (type.flags & PRIMITIVE_FLAGS) !== 0;

const isExcludedTypeName = (name: string, scope: DomainTypeScope) =>
  STDLIB_TYPE_NAMES.has(name) || scope.ubiquitousSet.has(name);

const isDeclInSameFile = (declPathOpt: O.Option<string>, currentFilePath: string) =>
  O.exists((file: string) => normalizeFilePath(file) === currentFilePath)(declPathOpt);

const isQualifyingDecl = (name: string, declFile: O.Option<string>, scope: DomainTypeScope) =>
  !O.exists(isStdlibDeclFile)(declFile) &&
  (isDeclInSameFile(declFile, scope.sfPath) || scope.primarySet.has(name));

const resolveQualifyingDomainType = (type: ts.Type, scope: DomainTypeScope) =>
  isPrimitiveTsType(type)
    ? O.none
    : flow(
        resolveTsTypeName,
        O.filter((name) => !isExcludedTypeName(name, scope)),
        O.map((name) => ({ name, declFile: resolveTsTypeDeclarationFile(type) })),
        O.filter(({ name, declFile }) => isQualifyingDecl(name, declFile, scope)),
        O.map(({ name }) => name),
      )(type);

const expandUnwrappedMember = (unwrapped: ts.Type) =>
  unwrapped.isIntersection() ? [unwrapped, ...unwrapped.types] : [unwrapped];

const collectChildTypes = (rootType: ts.Type, checker: ts.TypeChecker) =>
  flow(
    (t: ts.Type) => unwrapContainerTsTypes(t, checker),
    RA.flatMap(expandUnwrappedMember),
    RA.filter((child) => child !== rootType),
  )(rootType);

const appendOptionalName = (nameOpt: O.Option<string>, names: ReadonlyArray<string>) =>
  O.match(
    () => names,
    (name: string) => RA.append(name)(names),
  )(nameOpt);

const walkTypeDomainNames = (
  acc: TypeWalkAcc,
  rootType: ts.Type,
  scope: DomainTypeScope,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive type expansion
): TypeWalkAcc =>
  acc.visited.has(rootType)
    ? acc
    : RA.reduce<ts.Type, TypeWalkAcc>(
        {
          visited: new Set([...acc.visited, rootType]),
          names: appendOptionalName(resolveQualifyingDomainType(rootType, scope), acc.names),
        },
        (nextAcc, child) => walkTypeDomainNames(nextAcc, child, scope),
      )(collectChildTypes(rootType, scope.checker));

const collectTypesDomainNames = (types: ReadonlyArray<ts.Type>, scope: DomainTypeScope) =>
  RA.reduce<ts.Type, TypeWalkAcc>(
    { visited: new Set<ts.Type>(), names: [] },
    (acc, t) => walkTypeDomainNames(acc, t, scope),
  )(types).names;

const readDeclFileName = (decl: ts.Declaration) => decl.getSourceFile().fileName;
const readNormalizedDeclPath = flow(readDeclFileName, normalizeFilePath);

const resolveFirstDeclFile = (canonical: ts.Symbol) =>
  flow(
    (sym: ts.Symbol) => O.fromNullable(sym.declarations),
    O.flatMap(RA.head),
    O.map(readNormalizedDeclPath),
  )(canonical);

const resolveCanonicalSymbolAtNode = (node: ts.Node, checker: ts.TypeChecker) =>
  flow(
    (target: ts.Node) => checker.getSymbolAtLocation(target),
    O.fromNullable,
    O.map((raw) => resolveCanonicalSymbol(raw, checker)),
  )(node);

const resolveFilteredSymbol = <T>(
  node: ts.Node,
  checker: ts.TypeChecker,
  predicate: P.Predicate<ts.Symbol>,
  project: (canonical: ts.Symbol) => T,
) =>
  flow(
    (target: ts.Node) => resolveCanonicalSymbolAtNode(target, checker),
    O.filter(predicate),
    O.map(project),
  )(node);

const isQualifyingTypeRefSymbol = (canonical: ts.Symbol, scope: DomainTypeScope) =>
  !isExcludedTypeName(canonical.name, scope) &&
  isQualifyingDecl(canonical.name, resolveFirstDeclFile(canonical), scope);

const resolveTypeRefDomainName = (node: ts.Node, scope: DomainTypeScope) =>
  ts.isTypeReferenceNode(node)
    ? resolveFilteredSymbol(
        node.typeName,
        scope.checker,
        (canonical) => isQualifyingTypeRefSymbol(canonical, scope),
        (canonical) => canonical.name,
      )
    : O.none;

const pairNodeWithSourceFile = (root: ts.Node) => ({
  root,
  sf: root.getSourceFile(),
});

const collectSubtreeNodes = flow(pairNodeWithSourceFile, ({ root, sf }) =>
  collectTsNodes(root, sf),
);

const collectAnnotationTypeRefs = (node: ts.Node, scope: DomainTypeScope) =>
  flow(
    collectSubtreeNodes,
    RA.filterMap((curr) => resolveTypeRefDomainName(curr, scope)),
    RA.uniq(S.Eq),
  )(node);

const resolveSymbolFirstDecl = flow(
  (s: ts.Symbol) => s.declarations,
  O.fromNullable,
  O.flatMap(RA.head),
);

const resolveSymbolDeclaration = (sym: ts.Symbol) =>
  flow(
    (s: ts.Symbol) => s.valueDeclaration,
    O.fromNullable,
    O.alt(() => resolveSymbolFirstDecl(sym)),
  )(sym);

const resolveExportSymbolNode = (exp: RuntimeExport) =>
  flow(
    O.flatMap(resolveSymbolDeclaration),
    O.getOrElse(() => exp.declaration),
  )(exp.symbol);

const resolveUnwrappedExportExpr = (expr: ts.Expression, exp: RuntimeExport) => {
  const unwrapped = unwrapExpression(expr);
  return ts.isIdentifier(unwrapped)
    ? O.match(
        () => unwrapped as ts.Node,
        () => resolveExportSymbolNode(exp),
      )(exp.symbol)
    : unwrapped;
};

const resolveExportTargetNode = (exp: RuntimeExport) =>
  match(exp.declaration)
    .when(ts.isShorthandPropertyAssignment, () => resolveExportSymbolNode(exp))
    .when(ts.isPropertyAssignment, (decl) => resolveUnwrappedExportExpr(decl.initializer, exp))
    .when(ts.isExportAssignment, (decl) => resolveUnwrappedExportExpr(decl.expression, exp))
    .otherwise((decl) => decl);

const resolveParamType = (param: ts.Symbol, checker: ts.TypeChecker) =>
  flow(
    resolveSymbolDeclaration,
    O.map((decl) => checker.getTypeOfSymbolAtLocation(param, decl)),
  )(param);

const collectSignatureTypes = (sig: ts.Signature, checker: ts.TypeChecker) => [
  checker.getReturnTypeOfSignature(sig),
  ...RA.filterMap((param: ts.Symbol) => resolveParamType(param, checker))(sig.getParameters()),
];

const collectSignaturesTypes = (sigs: ReadonlyArray<ts.Signature>, checker: ts.TypeChecker) =>
  RA.flatMap((sig: ts.Signature) => collectSignatureTypes(sig, checker))(sigs);

const collectDeclSignatureTypes = (decl: ts.SignatureDeclaration, checker: ts.TypeChecker) =>
  flow(
    (d: ts.SignatureDeclaration) => checker.getSignatureFromDeclaration(d),
    O.fromNullable,
    O.match(
      () => [] as ReadonlyArray<ts.Type>,
      (sig: ts.Signature) => collectSignatureTypes(sig, checker),
    ),
  )(decl);

const collectOptionalTypeNode = O.match(
  () => [] as ReadonlyArray<ts.TypeNode>,
  (typeNode: ts.TypeNode) => [typeNode],
);

const extractFunctionLikeTypes = (
  fn: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
) => ({
  types: collectDeclSignatureTypes(fn, checker),
  typeNodes: [
    ...RA.filterMap((param: ts.ParameterDeclaration) => O.fromNullable(param.type))(
      fn.parameters,
    ),
    ...collectOptionalTypeNode(O.fromNullable(fn.type)),
  ],
});

const extractValueNodeTypes = (node: ts.Node, checker: ts.TypeChecker) => {
  const nodeType = checker.getTypeAtLocation(node);
  const callSigs = nodeType.getCallSignatures();
  return {
    types: callSigs.length > 0 ? collectSignaturesTypes(callSigs, checker) : [nodeType],
    typeNodes: [] as ReadonlyArray<ts.TypeNode>,
  };
};

const extractNonFunctionVarTypes = (decl: ts.VariableDeclaration, checker: ts.TypeChecker) => ({
  types: extractValueNodeTypes(decl, checker).types,
  typeNodes: collectOptionalTypeNode(O.fromNullable(decl.type)),
});

const extractVariableTypes = (decl: ts.VariableDeclaration, checker: ts.TypeChecker) =>
  flow(
    O.map(unwrapExpression),
    O.filter(ts.isFunctionLike),
    O.match(
      () => extractNonFunctionVarTypes(decl, checker),
      (fn) => extractFunctionLikeTypes(fn, checker),
    ),
  )(O.fromNullable(decl.initializer));

const extractClassMemberTypes = (member: ts.ClassElement, checker: ts.TypeChecker) =>
  match(member)
    .when(
      (m) => ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m),
      (m) => ({
        types: collectDeclSignatureTypes(m, checker),
        typeNodes: [] as ReadonlyArray<ts.TypeNode>,
      }),
    )
    .when(ts.isPropertyDeclaration, (prop) => ({
      types: [] as ReadonlyArray<ts.Type>,
      typeNodes: collectOptionalTypeNode(O.fromNullable(prop.type)),
    }))
    .otherwise(() => EMPTY_TARGET_TYPES);

const extractClassTypes = (cls: ts.ClassLikeDeclaration, checker: ts.TypeChecker) => {
  const memberParts = RA.map((member: ts.ClassElement) =>
    extractClassMemberTypes(member, checker),
  )(cls.members);
  return {
    types: [
      ...collectSignaturesTypes(
        checker.getTypeAtLocation(cls).getConstructSignatures(),
        checker,
      ),
      ...RA.flatMap((part: ExtractedTargetTypes) => part.types)(memberParts),
    ],
    typeNodes: RA.flatMap((part: ExtractedTargetTypes) => part.typeNodes)(memberParts),
  };
};

const extractTargetTypes = (targetNode: ts.Node, checker: ts.TypeChecker) =>
  match(targetNode)
    .when(ts.isFunctionLike, (fn) => extractFunctionLikeTypes(fn, checker))
    .when(ts.isVariableDeclaration, (decl) => extractVariableTypes(decl, checker))
    .when(ts.isClassLike, (cls) => extractClassTypes(cls, checker))
    .otherwise((node) => extractValueNodeTypes(node, checker));

const collectExtractedDomainNames = (
  extracted: ExtractedTargetTypes,
  scope: DomainTypeScope,
) =>
  RA.uniq(S.Eq)([
    ...collectTypesDomainNames(extracted.types, scope),
    ...RA.flatMap((typeNode: ts.TypeNode) => collectAnnotationTypeRefs(typeNode, scope))(
      extracted.typeNodes,
    ),
  ]);

const collectSignatureDomainTypes = (exp: RuntimeExport, scope: DomainTypeScope) =>
  flow(
    resolveExportTargetNode,
    (targetNode) => extractTargetTypes(targetNode, scope.checker),
    (extracted) => collectExtractedDomainNames(extracted, scope),
  )(exp);

const hasExportKeyword = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  RA.some((m: ts.Modifier) => m.kind === ts.SyntaxKind.ExportKeyword)(
    ts.getModifiers(node) ?? [],
  );

const isPrivateLocalTypeDecl = (
  stmt: ts.TypeAliasDeclaration | ts.InterfaceDeclaration,
  ubiquitousSet: ReadonlySet<string>,
) => !hasExportKeyword(stmt) && !ubiquitousSet.has(stmt.name.text);

const extractDeclWithOptionalName = (
  decl: ts.FunctionDeclaration | ts.ClassDeclaration,
) =>
  flow(
    (d: ts.FunctionDeclaration | ts.ClassDeclaration) => d.name,
    O.fromNullable,
    O.match(
      () => [] as ReadonlyArray<readonly [ts.Identifier, ts.Node]>,
      (id: ts.Identifier) => [[id, decl] as const],
    ),
  )(decl);

const extractVariableDeclEntries = (stmt: ts.VariableStatement) =>
  RA.filterMap((decl: ts.VariableDeclaration) =>
    ts.isIdentifier(decl.name) ? O.some([decl.name, decl] as const) : O.none,
  )(stmt.declarationList.declarations);

const extractStatementDeclEntries = (
  stmt: ts.Statement,
  ubiquitousSet: ReadonlySet<string>,
) =>
  match(stmt)
    .when(ts.isFunctionDeclaration, extractDeclWithOptionalName)
    .when(ts.isClassDeclaration, extractDeclWithOptionalName)
    .when(ts.isEnumDeclaration, (en) => [[en.name, en] as const])
    .when(
      (s) => ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s),
      (decl) =>
        isPrivateLocalTypeDecl(decl, ubiquitousSet)
          ? ([[decl.name, decl] as const] as ReadonlyArray<readonly [ts.Identifier, ts.Node]>)
          : ([] as ReadonlyArray<readonly [ts.Identifier, ts.Node]>),
    )
    .when(ts.isVariableStatement, extractVariableDeclEntries)
    .otherwise(() => [] as ReadonlyArray<readonly [ts.Identifier, ts.Node]>);

const resolveUnexportedBinding = (
  entry: readonly [ts.Identifier, ts.Node],
  checker: ts.TypeChecker,
  exportedSymbols: ReadonlySet<ts.Symbol>,
) =>
  resolveFilteredSymbol(
    entry[0],
    checker,
    (canonical) => !exportedSymbols.has(canonical),
    (canonical) => ({
      sym: canonical,
      name: entry[0].text,
      node: entry[1],
    }),
  );

const collectUnexportedLocals = (
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  exportedSymbols: ReadonlySet<ts.Symbol>,
  ubiquitousSet: ReadonlySet<string>,
) =>
  flow(
    RA.flatMap((stmt: ts.Statement) => extractStatementDeclEntries(stmt, ubiquitousSet)),
    RA.filterMap((entry) => resolveUnexportedBinding(entry, checker, exportedSymbols)),
  )(sf.statements);

const isDirectNamedDeclaration = (parent: ts.Node, node: ts.Identifier) =>
  (ts.isVariableDeclaration(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isClassDeclaration(parent)) &&
  parent.name === node;

const isParamOrPropertyName = (parent: ts.Node, node: ts.Identifier) =>
  (ts.isParameter(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyAccessExpression(parent)) &&
  parent.name === node;

const isDeclarationNamePosition = (node: ts.Identifier) =>
  isDirectNamedDeclaration(node.parent, node) || isParamOrPropertyName(node.parent, node);

const resolveReferencedIdentifierSymbol = (node: ts.Node, checker: ts.TypeChecker) =>
  ts.isIdentifier(node) && !isDeclarationNamePosition(node)
    ? resolveCanonicalSymbolAtNode(node, checker)
    : O.none;

const collectReferencedSymbolsInNode = (
  root: ts.Node,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  new Set(
    RA.filterMap((node: ts.Node) => resolveReferencedIdentifierSymbol(node, checker))(
      collectTsNodes(root, sf),
    ),
  );

const lookupExportNameForSymbol = (refGraph: LocalRefGraph) =>
  flow((sym: ts.Symbol) => refGraph.exportSymbolToName.get(sym), O.fromNullable);

const advanceTransitiveState = (
  state: TransitiveWalkState,
  candidateSymbols: ReadonlyArray<ts.Symbol>,
  refGraph: LocalRefGraph,
) => {
  const nextFrontier = RA.filter(
    (sym: ts.Symbol) => refGraph.localBySym.has(sym) && !state.visitedLocals.has(sym),
  )(candidateSymbols);
  return {
    frontier: nextFrontier,
    visitedLocals: new Set([...state.visitedLocals, ...nextFrontier]),
    reachedExports: new Set([
      ...state.reachedExports,
      ...RA.filterMap(lookupExportNameForSymbol(refGraph))(candidateSymbols),
    ]),
  };
};

const stepTransitiveFrontier = (state: TransitiveWalkState, refGraph: LocalRefGraph) =>
  flow(
    RA.flatMap((curr: ts.Symbol) => [...(refGraph.localDirectRefs.get(curr) ?? [])]),
    (candidates) => advanceTransitiveState(state, candidates, refGraph),
  )(state.frontier);

const walkTransitiveRefs = (
  state: TransitiveWalkState,
  refGraph: LocalRefGraph,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive reachability walk
): TransitiveWalkState =>
  state.frontier.length === 0
    ? state
    : walkTransitiveRefs(stepTransitiveFrontier(state, refGraph), refGraph);

const expandTransitiveRefs = (
  initialRefs: ReadonlySet<ts.Symbol>,
  refGraph: LocalRefGraph,
) =>
  walkTransitiveRefs(
    advanceTransitiveState(
      { frontier: [], visitedLocals: new Set(), reachedExports: new Set() },
      [...initialRefs],
      refGraph,
    ),
    refGraph,
  );

const excludeSelfExport = (reached: ReadonlySet<string>, selfName: string) =>
  new Set(RA.filter((name: string) => name !== selfName)([...reached]));

const collectExpandedExportRefs = (exp: RuntimeExport, ctx: ProfileBuildContext) =>
  flow(
    resolveExportTargetNode,
    (targetNode) => collectReferencedSymbolsInNode(targetNode, ctx.sf, ctx.scope.checker),
    (refs) => expandTransitiveRefs(refs, ctx.refGraph),
  )(exp);

const buildExportProfile = (exp: RuntimeExport, ctx: ProfileBuildContext) => {
  const expanded = collectExpandedExportRefs(exp, ctx);
  return {
    name: exp.exportName,
    reachedExports: excludeSelfExport(expanded.reachedExports, exp.exportName),
    usedLocals: expanded.visitedLocals,
    domainTypes: new Set(collectSignatureDomainTypes(exp, ctx.scope)),
  };
};

const hasUsedLocal = (profile: ExportProfile, sym: ts.Symbol) => profile.usedLocals.has(sym);
const hasDomainType = (profile: ExportProfile, dt: string) => profile.domainTypes.has(dt);
const hasReachedExport = (caller: ExportProfile, callee: ExportProfile) =>
  caller.reachedExports.has(callee.name);

const findSharedLocalName = (pairCtx: ProfilePairContext) =>
  flow(
    RA.findFirst((sym: ts.Symbol) => hasUsedLocal(pairCtx.targetProfile, sym)),
    O.map((sym) => pairCtx.localBySym.get(sym)),
    O.flatMap(O.fromNullable),
    O.map((binding) => binding.name),
  )([...pairCtx.sourceProfile.usedLocals]);

const findSharedDomainType = (pairCtx: ProfilePairContext) =>
  RA.findFirst((dt: string) => hasDomainType(pairCtx.targetProfile, dt))([
    ...pairCtx.sourceProfile.domainTypes,
  ]);

const formatCallReason = (caller: string, callee: string) => `${caller} calls ${callee}`;
const formatSharedLocalReason = (name: string) => `shared helper '${name}'`;
const formatSharedTypeReason = (name: string) => `shared type '${name}'`;

const resolveCallEdgeReason = (pairCtx: ProfilePairContext) =>
  match({
    sourceCallsTarget: hasReachedExport(pairCtx.sourceProfile, pairCtx.targetProfile),
    targetCallsSource: hasReachedExport(pairCtx.targetProfile, pairCtx.sourceProfile),
  })
    .with({ sourceCallsTarget: true }, () =>
      O.some(formatCallReason(pairCtx.sourceProfile.name, pairCtx.targetProfile.name)),
    )
    .with({ targetCallsSource: true }, () =>
      O.some(formatCallReason(pairCtx.targetProfile.name, pairCtx.sourceProfile.name)),
    )
    .otherwise(() => O.none);

const resolveSharedLocalEdgeReason = flow(findSharedLocalName, O.map(formatSharedLocalReason));
const resolveSharedTypeEdgeReason = flow(findSharedDomainType, O.map(formatSharedTypeReason));

const resolveProfileEdgeReason = (pairCtx: ProfilePairContext) =>
  flow(
    resolveCallEdgeReason,
    O.alt(() => resolveSharedLocalEdgeReason(pairCtx)),
    O.alt(() => resolveSharedTypeEdgeReason(pairCtx)),
  )(pairCtx);

const buildPairDirectedEdges = (pairCtx: ProfilePairContext) =>
  flow(
    resolveProfileEdgeReason,
    O.match(
      () => [] as ReadonlyArray<readonly [string, CohesionNeighbor]>,
      (reason: string) => [
        [pairCtx.sourceProfile.name, { target: pairCtx.targetProfile.name, reason }] as const,
        [pairCtx.targetProfile.name, { target: pairCtx.sourceProfile.name, reason }] as const,
      ],
    ),
  )(pairCtx);

const dropLeadingProfiles =
  (count: number) => (profiles: ReadonlyArray<ExportProfile>) =>
    RA.dropLeft(count)(profiles);

const pairProfileWithLater =
  (graphInput: CohesionGraphInput) => (idx: number, sourceProfile: ExportProfile) =>
    flow(
      dropLeadingProfiles(idx + 1),
      RA.flatMap((targetProfile: ExportProfile) =>
        buildPairDirectedEdges({
          sourceProfile,
          targetProfile,
          localBySym: graphInput.localBySym,
        }),
      ),
    )(graphInput.profiles);

const collectPairwiseCohesionEdges = (graphInput: CohesionGraphInput) =>
  flow(RA.mapWithIndex(pairProfileWithLater(graphInput)), RA.flatten)(graphInput.profiles);

const addCohesionEdge = (
  acc: CohesionAdjacency,
  edge: readonly [string, CohesionNeighbor],
) => ({
  ...acc,
  [edge[0]]: RA.append(edge[1])(acc[edge[0]] ?? []),
});

const buildCohesionAdjacency = flow(
  collectPairwiseCohesionEdges,
  RA.reduce<readonly [string, CohesionNeighbor], CohesionAdjacency>({}, addCohesionEdge),
);

const collectNextClusterFrontier = (
  neighborEdges: ReadonlyArray<CohesionNeighbor>,
  seenNodes: ReadonlySet<string>,
) =>
  flow(
    RA.map((edge: CohesionNeighbor) => edge.target),
    RA.filter((target: string) => !seenNodes.has(target)),
    RA.uniq(S.Eq),
  )(neighborEdges);

const stepClusterFrontier = (
  state: ClusterWalkState,
  adjacency: CohesionAdjacency,
) => {
  const neighborEdges = RA.flatMap((node: string) => adjacency[node] ?? [])(state.pendingNodes);
  const nextPending = collectNextClusterFrontier(neighborEdges, state.seenNodes);
  return {
    pendingNodes: nextPending,
    seenNodes: new Set([...state.seenNodes, ...nextPending]),
    clusterExports: [...state.clusterExports, ...state.pendingNodes],
    collectedReasons: [
      ...state.collectedReasons,
      ...RA.map((edge: CohesionNeighbor) => edge.reason)(neighborEdges),
    ],
  };
};

const walkClusterFrontier = (
  state: ClusterWalkState,
  adjacency: CohesionAdjacency,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive cluster BFS
): ClusterWalkState =>
  state.pendingNodes.length === 0
    ? state
    : walkClusterFrontier(stepClusterFrontier(state, adjacency), adjacency);

const buildCohesionCluster = (walked: ClusterWalkState) => ({
  exports: RA.sort(S.Ord)(walked.clusterExports),
  sharedReasons: flow(RA.uniq(S.Eq), RA.sort(S.Ord))(walked.collectedReasons),
});

const seedClusterWalkState = (seed: string, visited: ReadonlySet<string>) => ({
  pendingNodes: [seed],
  seenNodes: new Set([...visited, seed]),
  clusterExports: [] as ReadonlyArray<string>,
  collectedReasons: [] as ReadonlyArray<string>,
});

const appendSeededCluster = (
  acc: ClusterPartitionAcc,
  seed: string,
  adjacency: CohesionAdjacency,
) =>
  flow(
    (start: string) => seedClusterWalkState(start, acc.visited),
    (initial) => walkClusterFrontier(initial, adjacency),
    (walked) => ({
      visited: walked.seenNodes,
      clusters: RA.append(buildCohesionCluster(walked))(acc.clusters),
    }),
  )(seed);

const compareClusterByFirstExport = Ord.contramap(
  (cluster: CohesionCluster) => cluster.exports[0] ?? "",
)(S.Ord);

const partitionCohesionClusters = (
  profiles: ReadonlyArray<ExportProfile>,
  adjacency: CohesionAdjacency,
) =>
  flow(
    RA.reduce<ExportProfile, ClusterPartitionAcc>(
      { visited: new Set<string>(), clusters: [] },
      (acc, profile) =>
        acc.visited.has(profile.name)
          ? acc
          : appendSeededCluster(acc, profile.name, adjacency),
    ),
    (result) => RA.sort(compareClusterByFirstExport)(result.clusters),
  )(profiles);

const buildExportSymbolEntries = (
  runtimeExports: ReadonlyArray<RuntimeExport>,
  checker: ts.TypeChecker,
) =>
  RA.filterMap((exp: RuntimeExport) =>
    O.map((sym: ts.Symbol) => [resolveCanonicalSymbol(sym, checker), exp.exportName] as const)(
      exp.symbol,
    ),
  )(runtimeExports);

const collectExportedSymbolSet = (
  symbolEntries: ReadonlyArray<readonly [ts.Symbol, string]>,
) => new Set(RA.map((entry: readonly [ts.Symbol, string]) => entry[0])(symbolEntries));

const buildLocalDirectRefsMap = (
  locals: ReadonlyArray<UnexportedLocalBinding>,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  new Map(
    RA.map((l: UnexportedLocalBinding) => [
      l.sym,
      collectReferencedSymbolsInNode(l.node, sf, checker),
    ] as const)(locals),
  );

const buildLocalRefGraph = (ctx: MultiExportContext) => {
  const symbolEntries = buildExportSymbolEntries(ctx.runtimeExports, ctx.scope.checker);
  const locals = collectUnexportedLocals(
    ctx.sf,
    ctx.scope.checker,
    collectExportedSymbolSet(symbolEntries),
    ctx.scope.ubiquitousSet,
  );
  return {
    exportSymbolToName: new Map(symbolEntries),
    localBySym: new Map(RA.map((l: UnexportedLocalBinding) => [l.sym, l] as const)(locals)),
    localDirectRefs: buildLocalDirectRefsMap(locals, ctx.sf, ctx.scope.checker),
  };
};

const buildExportProfiles = (ctx: MultiExportContext, refGraph: LocalRefGraph) =>
  RA.map((exp: RuntimeExport) =>
    buildExportProfile(exp, { sf: ctx.sf, scope: ctx.scope, refGraph }),
  )(ctx.runtimeExports);

const computeCohesionClusters = (ctx: MultiExportContext, refGraph: LocalRefGraph) => {
  const profiles = buildExportProfiles(ctx, refGraph);
  return partitionCohesionClusters(
    profiles,
    buildCohesionAdjacency({ profiles, localBySym: refGraph.localBySym }),
  );
};

const analyzeMultiExportCohesion = (ctx: MultiExportContext) => {
  const clusters = computeCohesionClusters(ctx, buildLocalRefGraph(ctx));
  return {
    fileName: ctx.scope.sfPath,
    isBarrel: false,
    exportCount: ctx.runtimeExports.length,
    clusters,
    isCohesive: clusters.length <= 1,
  };
};

const buildTrivialCohesionResult = (
  sfPath: string,
  runtimeExports: ReadonlyArray<RuntimeExport>,
) => ({
  fileName: sfPath,
  isBarrel: false,
  exportCount: runtimeExports.length,
  clusters: O.match(
    () => [] as ReadonlyArray<CohesionCluster>,
    (first: RuntimeExport) => [{ exports: [first.exportName], sharedReasons: [] }],
  )(RA.head(runtimeExports)),
  isCohesive: true,
});

const analyzeNonBarrelCohesion = (
  sf: ts.SourceFile,
  sfPath: string,
  checker: ts.TypeChecker,
  options: ModuleCohesionOptions,
) => {
  const runtimeExports = extractFileRuntimeExports(sf, checker);
  return runtimeExports.length <= 1
    ? buildTrivialCohesionResult(sfPath, runtimeExports)
    : analyzeMultiExportCohesion({
        sf,
        runtimeExports,
        scope: {
          sfPath,
          checker,
          ubiquitousSet: new Set(options.ubiquitousTypes),
          primarySet: new Set(options.primaryDomainTypes),
        },
      });
};

export const analyzeFileCohesion = (
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  options: ModuleCohesionOptions = {
    ubiquitousTypes: DEFAULT_UBIQUITOUS_TYPES,
    primaryDomainTypes: [],
  },
) => {
  const sfPath = normalizeFilePath(sf.fileName);
  return isBarrelFile(sf)
    ? {
        fileName: sfPath,
        isBarrel: true,
        exportCount: 0,
        clusters: [] as ReadonlyArray<CohesionCluster>,
        isCohesive: true,
      }
    : analyzeNonBarrelCohesion(sf, sfPath, checker, options);
};
