import * as O from "fp-ts/lib/Option.js";
import * as Ord from "fp-ts/lib/Ord.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
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

const isExcludedTypeName = (scope: DomainTypeScope) => (name: string) =>
  STDLIB_TYPE_NAMES.has(name) || scope.ubiquitousSet.has(name);

const isDeclInSameFile = (currentFilePath: string) => (declPathOpt: O.Option<string>) =>
  O.exists((file: string) => normalizeFilePath(file) === currentFilePath)(declPathOpt);

const isQualifyingDecl =
  ({ declFile, scope }: Readonly<{ declFile: O.Option<string>; scope: DomainTypeScope }>) =>
  (name: string) =>
    !O.exists(isStdlibDeclFile)(declFile) &&
    (isDeclInSameFile(scope.sfPath)(declFile) || scope.primarySet.has(name));

const resolveQualifyingDomainType = (scope: DomainTypeScope) => (type: ts.Type) =>
  isPrimitiveTsType(type)
    ? O.none
    : O.filter(
        (name: string) =>
          !isExcludedTypeName(scope)(name) &&
          isQualifyingDecl({ declFile: resolveTsTypeDeclarationFile(type), scope })(name),
      )(resolveTsTypeName(type));

const expandUnwrappedMember = (unwrapped: ts.Type) =>
  unwrapped.isIntersection() ? [unwrapped, ...unwrapped.types] : [unwrapped];

const filterChildTypes = (checker: ts.TypeChecker) => (rootType: ts.Type) =>
  flow(
    unwrapContainerTsTypes(checker),
    RA.flatMap(expandUnwrappedMember),
    RA.filter((child: ts.Type) => child !== rootType),
  );

const collectChildTypes = (checker: ts.TypeChecker) => (rootType: ts.Type) =>
  filterChildTypes(checker)(rootType)(rootType);

const appendOptionalName = (names: ReadonlyArray<string>) => (nameOpt: O.Option<string>) =>
  O.match(
    () => names,
    (name: string) => RA.append(name)(names),
  )(nameOpt);

const walkTypeDomainNames =
  (scope: DomainTypeScope) =>
  (
    acc: TypeWalkAcc,
    rootType: ts.Type,
    // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive type expansion
  ): TypeWalkAcc =>
    acc.visited.has(rootType)
      ? acc
      : RA.reduce<ts.Type, TypeWalkAcc>(
          {
            visited: new Set([...acc.visited, rootType]),
            names: appendOptionalName(acc.names)(resolveQualifyingDomainType(scope)(rootType)),
          },
          walkTypeDomainNames(scope),
        )(collectChildTypes(scope.checker)(rootType));

const collectTypesDomainNames = (scope: DomainTypeScope) => (types: ReadonlyArray<ts.Type>) =>
  RA.reduce<ts.Type, TypeWalkAcc>(
    { visited: new Set<ts.Type>(), names: [] },
    walkTypeDomainNames(scope),
  )(types).names;

const readDeclFileName = (decl: ts.Declaration) => decl.getSourceFile().fileName;
const readNormalizedDeclPath = flow(readDeclFileName, normalizeFilePath);

const resolveFirstDeclFile = flow(
  (sym: ts.Symbol) => O.fromNullable(sym.declarations),
  O.flatMap(RA.head),
  O.map(readNormalizedDeclPath),
);

const resolveCanonicalAtNode = (checker: ts.TypeChecker) =>
  flow(
    (node: ts.Node) => checker.getSymbolAtLocation(node),
    O.fromNullable,
    O.map((raw: ts.Symbol) => resolveCanonicalSymbol(raw, checker)),
  );

const resolveCanonicalSymbolAtNode = (checker: ts.TypeChecker) => (node: ts.Node) =>
  resolveCanonicalAtNode(checker)(node);

const isQualifyingTypeRefSymbol = (scope: DomainTypeScope) => (canonical: ts.Symbol) =>
  !isExcludedTypeName(scope)(canonical.name) &&
  isQualifyingDecl({ declFile: resolveFirstDeclFile(canonical), scope })(canonical.name);

const resolveTypeRefDomainNameFor = (scope: DomainTypeScope) =>
  flow(
    (node: ts.TypeReferenceNode) => resolveCanonicalSymbolAtNode(scope.checker)(node.typeName),
    O.filter(isQualifyingTypeRefSymbol(scope)),
    O.map((canonical: ts.Symbol) => canonical.name),
  );

const resolveTypeRefDomainName = (scope: DomainTypeScope) => (node: ts.Node) =>
  ts.isTypeReferenceNode(node) ? resolveTypeRefDomainNameFor({ ...scope })(node) : O.none;

const pairNodeWithSourceFile = (root: ts.Node) => ({
  root,
  sf: root.getSourceFile(),
});

const collectSubtreeNodes = flow(pairNodeWithSourceFile, ({ root, sf }) =>
  collectTsNodes(sf)(root),
);

const collectAnnotationTypeRefsFor = (scope: DomainTypeScope) =>
  flow(
    collectSubtreeNodes,
    RA.filterMap(resolveTypeRefDomainName(scope)),
    RA.uniq(S.Eq),
  );

const collectAnnotationTypeRefs = (scope: DomainTypeScope) => (node: ts.Node) =>
  collectAnnotationTypeRefsFor({ ...scope })(node);

const resolveSymbolFirstDecl = flow(
  (s: ts.Symbol) => s.declarations,
  O.fromNullable,
  O.flatMap(RA.head),
);

const resolveSymbolDeclaration = flow(
  (sym: ts.Symbol) => ({ sym, val: O.fromNullable(sym.valueDeclaration) }),
  ({ sym, val }) => O.alt(() => resolveSymbolFirstDecl(sym))(val),
);

const resolveExportSymbolNode = flow(
  (exp: RuntimeExport) => ({ exp, decl: O.flatMap(resolveSymbolDeclaration)(exp.symbol) }),
  ({ exp, decl }) => O.getOrElse(() => exp.declaration)(decl),
);

const resolveUnwrappedExportExpr = (exp: RuntimeExport) => (expr: ts.Expression) => {
  const unwrapped = unwrapExpression(expr);
  return ts.isIdentifier(unwrapped)
    ? O.match(
        () => unwrapped satisfies ts.Node,
        () => resolveExportSymbolNode(exp),
      )(exp.symbol)
    : unwrapped;
};

const isShorthandExport = (e: RuntimeExport) =>
  ts.isShorthandPropertyAssignment(e.declaration);

const isPropertyAssignmentExport = (
  e: RuntimeExport,
): e is RuntimeExport & Readonly<{ readonly declaration: ts.PropertyAssignment }> =>
  ts.isPropertyAssignment(e.declaration);

const isExportAssignmentExport = (
  e: RuntimeExport,
): e is RuntimeExport & Readonly<{ readonly declaration: ts.ExportAssignment }> =>
  ts.isExportAssignment(e.declaration);

const resolveExportTargetNode = (exp: RuntimeExport) =>
  match(exp)
    .when(isShorthandExport, resolveExportSymbolNode)
    .when(isPropertyAssignmentExport, (e) =>
      resolveUnwrappedExportExpr(e)(e.declaration.initializer),
    )
    .when(isExportAssignmentExport, (e) =>
      resolveUnwrappedExportExpr(e)(e.declaration.expression),
    )
    .otherwise((e) => e.declaration);

const resolveParamType = (checker: ts.TypeChecker) => (param: ts.Symbol) =>
  O.map((decl: ts.Declaration) => checker.getTypeOfSymbolAtLocation(param, decl))(
    resolveSymbolDeclaration(param),
  );

const collectSignatureTypes = (checker: ts.TypeChecker) => (sig: ts.Signature) => [
  checker.getReturnTypeOfSignature(sig),
  ...RA.filterMap(resolveParamType(checker))(sig.getParameters()),
];

const collectSignaturesTypes =
  (checker: ts.TypeChecker) => (sigs: ReadonlyArray<ts.Signature>) =>
    RA.flatMap(collectSignatureTypes(checker))(sigs);

const collectSignatureTypesOpt = (checker: ts.TypeChecker) =>
  flow(
    (decl: ts.SignatureDeclaration) => checker.getSignatureFromDeclaration(decl),
    O.fromNullable,
    O.match(
      () => [] satisfies ReadonlyArray<ts.Type>,
      collectSignatureTypes(checker),
    ),
  );

const collectDeclSignatureTypes =
  (checker: ts.TypeChecker) => (decl: ts.SignatureDeclaration) =>
    collectSignatureTypesOpt(checker)(decl);

const collectOptionalTypeNode = O.match(
  () => [] satisfies ReadonlyArray<ts.TypeNode>,
  (typeNode: ts.TypeNode) => [typeNode],
);

const extractFunctionLikeTypes =
  (checker: ts.TypeChecker) => (fn: ts.SignatureDeclaration) => ({
    types: collectDeclSignatureTypes(checker)(fn),
    typeNodes: [
      ...RA.filterMap((param: ts.ParameterDeclaration) => O.fromNullable(param.type))(
        fn.parameters,
      ),
      ...collectOptionalTypeNode(O.fromNullable(fn.type)),
    ],
  });

const extractValueNodeTypes = (checker: ts.TypeChecker) => (node: ts.Node) => {
  const nodeType = checker.getTypeAtLocation(node);
  const callSigs = nodeType.getCallSignatures();
  return {
    types: callSigs.length > 0 ? collectSignaturesTypes(checker)(callSigs) : [nodeType],
    typeNodes: [] satisfies ReadonlyArray<ts.TypeNode>,
  };
};

const extractNonFunctionVarTypes =
  (checker: ts.TypeChecker) => (decl: ts.VariableDeclaration) => ({
    types: extractValueNodeTypes(checker)(decl).types,
    typeNodes: collectOptionalTypeNode(O.fromNullable(decl.type)),
  });

const extractVarInitializerTypes =
  (checker: ts.TypeChecker) => (decl: ts.VariableDeclaration) =>
    flow(
      O.map(unwrapExpression),
      O.filter(
        (expr: ts.Expression): expr is ts.ArrowFunction | ts.FunctionExpression =>
          ts.isArrowFunction(expr) || ts.isFunctionExpression(expr),
      ),
      O.match(
        () => extractNonFunctionVarTypes(checker)(decl),
        extractFunctionLikeTypes(checker),
      ),
    );

const extractVariableTypes = (checker: ts.TypeChecker) => (decl: ts.VariableDeclaration) =>
  extractVarInitializerTypes(checker)(decl)(O.fromNullable(decl.initializer));

const extractClassMemberTypes = (checker: ts.TypeChecker) => (member: ts.ClassElement) =>
  match(member)
    .when(
      (m) => ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m),
      (m) => ({
        types: collectDeclSignatureTypes(checker)(m),
        typeNodes: [] satisfies ReadonlyArray<ts.TypeNode>,
      }),
    )
    .when(ts.isPropertyDeclaration, (prop) => ({
      types: [] satisfies ReadonlyArray<ts.Type>,
      typeNodes: collectOptionalTypeNode(O.fromNullable(prop.type)),
    }))
    .otherwise(() => EMPTY_TARGET_TYPES);

const extractClassTypes = (checker: ts.TypeChecker) => (cls: ts.ClassLikeDeclaration) => {
  const memberParts = RA.map(extractClassMemberTypes(checker))(cls.members);
  return {
    types: [
      ...collectSignaturesTypes(checker)(
        checker.getTypeAtLocation(cls).getConstructSignatures(),
      ),
      ...RA.flatMap((part: ExtractedTargetTypes) => part.types)(memberParts),
    ],
    typeNodes: RA.flatMap((part: ExtractedTargetTypes) => part.typeNodes)(memberParts),
  };
};

const extractTargetTypes = (checker: ts.TypeChecker) => (targetNode: ts.Node) =>
  match(targetNode)
    .when(ts.isFunctionLike, extractFunctionLikeTypes(checker))
    .when(ts.isVariableDeclaration, extractVariableTypes(checker))
    .when(ts.isClassLike, extractClassTypes(checker))
    .otherwise(extractValueNodeTypes(checker));

const resolveExportExtractedTypes = (checker: ts.TypeChecker) =>
  flow(resolveExportTargetNode, extractTargetTypes(checker));

const collectSignatureDomainTypes = (scope: DomainTypeScope) => (exp: RuntimeExport) => {
  const extracted = resolveExportExtractedTypes(scope.checker)(exp);
  return RA.uniq(S.Eq)([
    ...collectTypesDomainNames(scope)(extracted.types),
    ...RA.flatMap(collectAnnotationTypeRefs(scope))(extracted.typeNodes),
  ]);
};

const isExportModifier = (m: ts.Modifier) => m.kind === ts.SyntaxKind.ExportKeyword;

const hasExportModifier = flow(
  ts.getModifiers,
  O.fromNullable,
  O.exists(RA.some(isExportModifier)),
);

const hasExportKeyword = (node: ts.Node) =>
  ts.canHaveModifiers(node) && hasExportModifier(node);

const isPrivateLocalTypeDecl =
  (ubiquitousSet: ReadonlySet<string>) =>
  (stmt: ts.TypeAliasDeclaration | ts.InterfaceDeclaration) =>
    !hasExportKeyword(stmt) && !ubiquitousSet.has(stmt.name.text);

const extractDeclWithOptionalName = flow(
  (decl: ts.FunctionDeclaration | ts.ClassDeclaration) => ({
    decl,
    nameOpt: O.fromNullable(decl.name),
  }),
  ({ decl, nameOpt }) =>
    O.match(
      () => [] satisfies ReadonlyArray<readonly [ts.Identifier, ts.Node]>,
      (id: ts.Identifier) => [[id, decl] as const],
    )(nameOpt),
);

const extractVariableDeclEntries = (stmt: ts.VariableStatement) =>
  RA.filterMap((decl: ts.VariableDeclaration) =>
    ts.isIdentifier(decl.name) ? O.some([decl.name, decl] as const) : O.none,
  )(stmt.declarationList.declarations);

const toDeclEntry = (id: ts.Identifier) => (node: ts.Node) => [id, node] as const;

const extractStatementDeclEntries =
  (ubiquitousSet: ReadonlySet<string>) => (stmt: ts.Statement) =>
    match(stmt)
      .when(ts.isFunctionDeclaration, extractDeclWithOptionalName)
      .when(ts.isClassDeclaration, extractDeclWithOptionalName)
      .when(ts.isEnumDeclaration, (en) => [toDeclEntry(en.name)(en)])
      .when(
        (s) => ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s),
        (decl) =>
          isPrivateLocalTypeDecl(ubiquitousSet)(decl)
            ? ([toDeclEntry(decl.name)(decl)] satisfies ReadonlyArray<
                readonly [ts.Identifier, ts.Node]
              >)
            : ([] satisfies ReadonlyArray<readonly [ts.Identifier, ts.Node]>),
      )
      .when(ts.isVariableStatement, extractVariableDeclEntries)
      .otherwise(() => [] satisfies ReadonlyArray<readonly [ts.Identifier, ts.Node]>);

const resolveUnexportedSym =
  (checker: ts.TypeChecker) => (exportedSymbols: ReadonlySet<ts.Symbol>) =>
    flow(
      resolveCanonicalSymbolAtNode(checker),
      O.filter((canonical: ts.Symbol) => !exportedSymbols.has(canonical)),
    );

const buildUnexportedBinding =
  (entry: readonly [ts.Identifier, ts.Node]) => (canonical: ts.Symbol) => ({
    sym: canonical,
    name: entry[0].text,
    node: entry[1],
  });

const resolveUnexportedBinding =
  (checker: ts.TypeChecker) => (exportedSymbols: ReadonlySet<ts.Symbol>) =>
    flow(
      (entry: readonly [ts.Identifier, ts.Node]) => ({
        entry,
        sym: resolveUnexportedSym(checker)(exportedSymbols)(entry[0]),
      }),
      ({ entry, sym }) => O.map(buildUnexportedBinding(entry))(sym),
    );

const collectUnexportedLocals =
  (ctx: MultiExportContext) => (exportedSymbols: ReadonlySet<ts.Symbol>) =>
    RA.filterMap(resolveUnexportedBinding(ctx.scope.checker)(exportedSymbols))(
      RA.flatMap(extractStatementDeclEntries(ctx.scope.ubiquitousSet))(ctx.sf.statements),
    );

const isDirectNamedDeclaration = (parent: ts.Node) => (node: ts.Identifier) =>
  (ts.isVariableDeclaration(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isClassDeclaration(parent)) &&
  parent.name === node;

const isParamOrPropertyName = (parent: ts.Node) => (node: ts.Identifier) =>
  (ts.isParameter(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyAccessExpression(parent)) &&
  parent.name === node;

const isDeclarationNamePosition = (node: ts.Identifier) =>
  isDirectNamedDeclaration(node.parent)(node) || isParamOrPropertyName(node.parent)(node);

const resolveReferencedIdentifierSymbol = (checker: ts.TypeChecker) => (node: ts.Node) =>
  ts.isIdentifier(node) && !isDeclarationNamePosition(node)
    ? resolveCanonicalSymbolAtNode(checker)(node)
    : O.none;

type FileCheckerEnv = Readonly<{
  sf: ts.SourceFile;
  checker: ts.TypeChecker;
}>;

const collectReferencedSymbolsInNode =
  ({ sf, checker }: FileCheckerEnv) =>
  (root: ts.Node) =>
    new Set(RA.filterMap(resolveReferencedIdentifierSymbol(checker))(collectTsNodes(sf)(root)));

const lookupExportNameForSymbol = (refGraph: LocalRefGraph) =>
  flow((sym: ts.Symbol) => refGraph.exportSymbolToName.get(sym), O.fromNullable);

const advanceTransitiveState =
  (refGraph: LocalRefGraph) =>
  (state: TransitiveWalkState) =>
  (candidateSymbols: ReadonlyArray<ts.Symbol>) => {
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

const lookupDirectRefs = (
  localDirectRefs: ReadonlyMap<ts.Symbol, ReadonlySet<ts.Symbol>>,
) =>
  flow(
    (curr: ts.Symbol) => localDirectRefs.get(curr),
    O.fromNullable,
    O.map((refs) => [...refs]),
    O.getOrElseW(() => []),
  );

const stepTransitiveFrontier = (refGraph: LocalRefGraph) => (state: TransitiveWalkState) =>
  advanceTransitiveState(refGraph)(state)(
    RA.flatMap(lookupDirectRefs(refGraph.localDirectRefs))(state.frontier),
  );

const walkTransitiveRefs =
  (refGraph: LocalRefGraph) =>
  (
    state: TransitiveWalkState,
    // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive reachability walk
  ): TransitiveWalkState =>
    state.frontier.length === 0
      ? state
      : walkTransitiveRefs(refGraph)(stepTransitiveFrontier(refGraph)(state));

const expandTransitiveRefs =
  (refGraph: LocalRefGraph) => (initialRefs: ReadonlySet<ts.Symbol>) =>
    walkTransitiveRefs(refGraph)(
      advanceTransitiveState(refGraph)({
        frontier: [],
        visitedLocals: new Set(),
        reachedExports: new Set(),
      })([...initialRefs]),
    );

const excludeSelfExport = (selfName: string) => (reached: ReadonlySet<string>) =>
  new Set(RA.filter((name: string) => name !== selfName)([...reached]));

const collectExportTargetSymbols = (ctx: ProfileBuildContext) =>
  flow(
    resolveExportTargetNode,
    collectReferencedSymbolsInNode({ sf: ctx.sf, checker: ctx.scope.checker }),
  );

const collectExpandedExportRefs = (ctx: ProfileBuildContext) => (exp: RuntimeExport) =>
  expandTransitiveRefs(ctx.refGraph)(collectExportTargetSymbols(ctx)(exp));

const buildExportProfile = (ctx: ProfileBuildContext) => (exp: RuntimeExport) => {
  const expanded = collectExpandedExportRefs(ctx)(exp);
  return {
    name: exp.exportName,
    reachedExports: excludeSelfExport(exp.exportName)(expanded.reachedExports),
    usedLocals: expanded.visitedLocals,
    domainTypes: new Set(collectSignatureDomainTypes(ctx.scope)(exp)),
  };
};

const hasUsedLocal = (profile: ExportProfile) => (sym: ts.Symbol) => profile.usedLocals.has(sym);
const hasDomainType = (profile: ExportProfile) => (dt: string) => profile.domainTypes.has(dt);
const hasReachedExport = (caller: ExportProfile) => (callee: ExportProfile) =>
  caller.reachedExports.has(callee.name);

const resolveLocalBindingName = (localBySym: ReadonlyMap<ts.Symbol, UnexportedLocalBinding>) =>
  flow(
    (sym: ts.Symbol) => localBySym.get(sym),
    O.fromNullable,
    O.map((binding: UnexportedLocalBinding) => binding.name),
  );

const lookupSharedLocalName = (pairCtx: ProfilePairContext) =>
  flow(
    RA.findFirst(hasUsedLocal(pairCtx.targetProfile)),
    O.flatMap(resolveLocalBindingName(pairCtx.localBySym)),
  );

const findSharedLocalName = (pairCtx: ProfilePairContext) =>
  lookupSharedLocalName(pairCtx)([...pairCtx.sourceProfile.usedLocals]);

const findSharedDomainType = (pairCtx: ProfilePairContext) =>
  RA.findFirst(hasDomainType(pairCtx.targetProfile))([
    ...pairCtx.sourceProfile.domainTypes,
  ]);

const formatCallReason = (caller: string) => (callee: string) => `${caller} calls ${callee}`;
const formatSharedLocalReason = (name: string) => `shared helper '${name}'`;
const formatSharedTypeReason = (name: string) => `shared type '${name}'`;

const resolveCallEdgeReason = (pairCtx: ProfilePairContext) =>
  match({
    sourceCallsTarget: hasReachedExport(pairCtx.sourceProfile)(pairCtx.targetProfile),
    targetCallsSource: hasReachedExport(pairCtx.targetProfile)(pairCtx.sourceProfile),
  })
    .with({ sourceCallsTarget: true }, () =>
      O.some(formatCallReason(pairCtx.sourceProfile.name)(pairCtx.targetProfile.name)),
    )
    .with({ targetCallsSource: true }, () =>
      O.some(formatCallReason(pairCtx.targetProfile.name)(pairCtx.sourceProfile.name)),
    )
    .otherwise(() => O.none);

const resolveSharedLocalEdgeReason = flow(findSharedLocalName, O.map(formatSharedLocalReason));
const resolveSharedTypeEdgeReason = flow(findSharedDomainType, O.map(formatSharedTypeReason));

const resolveFallbackEdgeReason = (pairCtx: ProfilePairContext) =>
  flow(
    O.alt(() => resolveSharedLocalEdgeReason(pairCtx)),
    O.alt(() => resolveSharedTypeEdgeReason(pairCtx)),
  );

const resolveProfileEdgeReason = flow(
  (pairCtx: ProfilePairContext) => ({ pairCtx, callReason: resolveCallEdgeReason(pairCtx) }),
  ({ pairCtx, callReason }) => resolveFallbackEdgeReason(pairCtx)(callReason),
);

const buildPairDirectedEdges = flow(
  (pairCtx: ProfilePairContext) => ({ pairCtx, reasonOpt: resolveProfileEdgeReason(pairCtx) }),
  ({ pairCtx, reasonOpt }) =>
    O.match(
      () => [] satisfies ReadonlyArray<readonly [string, CohesionNeighbor]>,
      (reason: string) => [
        [pairCtx.sourceProfile.name, { target: pairCtx.targetProfile.name, reason }] as const,
        [pairCtx.targetProfile.name, { target: pairCtx.sourceProfile.name, reason }] as const,
      ],
    )(reasonOpt),
);

const dropLeadingProfiles =
  (count: number) => (profiles: ReadonlyArray<ExportProfile>) =>
    RA.dropLeft(count)(profiles);

const pairProfileWithLater =
  (graphInput: CohesionGraphInput) => (idx: number, sourceProfile: ExportProfile) =>
    RA.flatMap((targetProfile: ExportProfile) =>
      buildPairDirectedEdges({
        sourceProfile,
        targetProfile,
        localBySym: graphInput.localBySym,
      }),
    )(dropLeadingProfiles(idx + 1)(graphInput.profiles));

const collectPairwiseCohesionEdges = flow(
  (graphInput: CohesionGraphInput) =>
    RA.mapWithIndex(pairProfileWithLater(graphInput))(graphInput.profiles),
  RA.flatten,
);

const lookupAdjacencyNeighbors = (adjacency: CohesionAdjacency) => (key: string) =>
  O.getOrElseW(() => [])(RR.lookup(key, adjacency));

const addCohesionEdge = (
  acc: CohesionAdjacency,
  edge: readonly [string, CohesionNeighbor],
) => ({
  ...acc,
  [edge[0]]: RA.append(edge[1])(lookupAdjacencyNeighbors(acc)(edge[0])),
});

const buildCohesionAdjacency = flow(
  collectPairwiseCohesionEdges,
  RA.reduce<readonly [string, CohesionNeighbor], CohesionAdjacency>({}, addCohesionEdge),
);

const filterUnseenTargets = (seenNodes: ReadonlySet<string>) =>
  flow(
    RA.map((edge: CohesionNeighbor) => edge.target),
    RA.filter((target: string) => !seenNodes.has(target)),
    RA.uniq(S.Eq),
  );

const collectNextClusterFrontier =
  (seenNodes: ReadonlySet<string>) => (neighborEdges: ReadonlyArray<CohesionNeighbor>) =>
    filterUnseenTargets(seenNodes)(neighborEdges);

const stepClusterFrontier = (adjacency: CohesionAdjacency) => (state: ClusterWalkState) => {
  const neighborEdges = RA.flatMap(lookupAdjacencyNeighbors(adjacency))(state.pendingNodes);
  const nextPending = collectNextClusterFrontier(state.seenNodes)(neighborEdges);
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

const walkClusterFrontier =
  (adjacency: CohesionAdjacency) =>
  (
    state: ClusterWalkState,
    // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive cluster BFS
  ): ClusterWalkState =>
    state.pendingNodes.length === 0
      ? state
      : walkClusterFrontier(adjacency)(stepClusterFrontier(adjacency)(state));

const buildCohesionCluster = (walked: ClusterWalkState) => ({
  exports: RA.sort(S.Ord)(walked.clusterExports),
  sharedReasons: RA.sort(S.Ord)(RA.uniq(S.Eq)(walked.collectedReasons)),
});

const seedClusterWalkState = (visited: ReadonlySet<string>) => (seed: string) => ({
  pendingNodes: [seed],
  seenNodes: new Set([...visited, seed]),
  clusterExports: [] satisfies ReadonlyArray<string>,
  collectedReasons: [] satisfies ReadonlyArray<string>,
});

const appendSeededCluster =
  (adjacency: CohesionAdjacency) => (acc: ClusterPartitionAcc, seed: string) => {
    const walked = walkClusterFrontier(adjacency)(seedClusterWalkState(acc.visited)(seed));
    return {
      visited: walked.seenNodes,
      clusters: RA.append(buildCohesionCluster(walked))(acc.clusters),
    };
  };

const readFirstClusterExport = flow(
  (cluster: CohesionCluster) => cluster.exports,
  RA.head,
  O.getOrElse(() => ""),
);

const compareClusterByFirstExport = Ord.contramap(readFirstClusterExport)(S.Ord);

const partitionCohesionClusters =
  (adjacency: CohesionAdjacency) => (profiles: ReadonlyArray<ExportProfile>) =>
    RA.sort(compareClusterByFirstExport)(
      RA.reduce<ExportProfile, ClusterPartitionAcc>(
        { visited: new Set<string>(), clusters: [] },
        (acc, profile) =>
          acc.visited.has(profile.name)
            ? acc
            : appendSeededCluster(adjacency)(acc, profile.name),
      )(profiles).clusters,
    );

const buildExportSymbolEntries =
  (checker: ts.TypeChecker) => (runtimeExports: ReadonlyArray<RuntimeExport>) =>
    RA.filterMap((exp: RuntimeExport) =>
      O.map((sym: ts.Symbol) => [resolveCanonicalSymbol(sym, checker), exp.exportName] as const)(
        exp.symbol,
      ),
    )(runtimeExports);

const collectExportedSymbolSet = (
  symbolEntries: ReadonlyArray<readonly [ts.Symbol, string]>,
) => new Set(RA.map((entry: readonly [ts.Symbol, string]) => entry[0])(symbolEntries));

const buildLocalDirectRefsMap =
  (env: FileCheckerEnv) => (locals: ReadonlyArray<UnexportedLocalBinding>) =>
    new Map(
      RA.map((l: UnexportedLocalBinding) => [
        l.sym,
        collectReferencedSymbolsInNode(env)(l.node),
      ] as const)(locals),
    );

const buildLocalRefGraph = (ctx: MultiExportContext) => {
  const symbolEntries = buildExportSymbolEntries(ctx.scope.checker)(ctx.runtimeExports);
  const locals = collectUnexportedLocals(ctx)(collectExportedSymbolSet(symbolEntries));
  return {
    exportSymbolToName: new Map(symbolEntries),
    localBySym: new Map(RA.map((l: UnexportedLocalBinding) => [l.sym, l] as const)(locals)),
    localDirectRefs: buildLocalDirectRefsMap({ sf: ctx.sf, checker: ctx.scope.checker })(
      locals,
    ),
  };
};

const buildExportProfiles = (ctx: MultiExportContext) => (refGraph: LocalRefGraph) =>
  RA.map(buildExportProfile({ sf: ctx.sf, scope: ctx.scope, refGraph }))(ctx.runtimeExports);

const computeCohesionClusters = (ctx: MultiExportContext) => (refGraph: LocalRefGraph) => {
  const profiles = buildExportProfiles(ctx)(refGraph);
  return partitionCohesionClusters(
    buildCohesionAdjacency({ profiles, localBySym: refGraph.localBySym }),
  )(profiles);
};

const analyzeMultiExportCohesion = (ctx: MultiExportContext) => {
  const clusters = computeCohesionClusters(ctx)(buildLocalRefGraph(ctx));
  return {
    fileName: ctx.scope.sfPath,
    isBarrel: false,
    exportCount: ctx.runtimeExports.length,
    clusters,
    isCohesive: clusters.length <= 1,
  };
};

const buildTrivialCohesionResult =
  (sfPath: string) => (runtimeExports: ReadonlyArray<RuntimeExport>) => ({
    fileName: sfPath,
    isBarrel: false,
    exportCount: runtimeExports.length,
    clusters: O.match(
      () => [] satisfies ReadonlyArray<CohesionCluster>,
      (first: RuntimeExport) => [{ exports: [first.exportName], sharedReasons: [] }],
    )(RA.head(runtimeExports)),
    isCohesive: true,
  });

export type CohesionAnalysisConfig = Readonly<{
  checker: ts.TypeChecker;
  options: O.Option<ModuleCohesionOptions>;
}>;

const DEFAULT_COHESION_OPTIONS: ModuleCohesionOptions = {
  ubiquitousTypes: DEFAULT_UBIQUITOUS_TYPES,
  primaryDomainTypes: [],
};

const analyzeNonBarrelCohesion =
  (sf: ts.SourceFile) =>
  ({
    checker,
    options,
  }: Readonly<{ checker: ts.TypeChecker; options: ModuleCohesionOptions }>) => {
    const sfPath = normalizeFilePath(sf.fileName);
    const runtimeExports = extractFileRuntimeExports(sf, checker);
    return runtimeExports.length <= 1
      ? buildTrivialCohesionResult(sfPath)(runtimeExports)
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

export const analyzeFileCohesion = ((sf: ts.SourceFile) =>
  (config: CohesionAnalysisConfig) =>
    isBarrelFile(sf)
      ? {
          fileName: normalizeFilePath(sf.fileName),
          isBarrel: true,
          exportCount: 0,
          clusters: [] satisfies ReadonlyArray<CohesionCluster>,
          isCohesive: true,
        }
      : analyzeNonBarrelCohesion(sf)({
          checker: config.checker,
          options: O.getOrElse(() => DEFAULT_COHESION_OPTIONS)(config.options),
        })) satisfies (sf: ts.SourceFile) => (config: CohesionAnalysisConfig) => FileCohesionResult;
