import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import * as S from "fp-ts/lib/string.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import {
  collectProjectSourceFiles,
  isMatchingAnyPattern,
  normalizeFilePath,
} from "../lib/source-paths.js";
import { makeLocationKey, resolveTsNodeLocation } from "../lib/ts-node-location.js";

export type RuntimeExportKind = "function" | "class" | "value";

export type RuntimeExport = Readonly<
  Record<"key" | "exportName" | "localName" | "fileName" | "locationKey", string> &
    Record<"line", number> & {
      readonly kind: RuntimeExportKind;
      readonly declaration: ts.Node;
    } & Record<"symbol", O.Option<ts.Symbol>> &
    Record<"defaultBagProperty", O.Option<string>>
>;

export type ModuleConsumerRecord = Readonly<
  Record<"exportKey", string> & {
    readonly prodConsumers: ReadonlyArray<string>;
    readonly testConsumers: ReadonlyArray<string>;
  }
>;

export type FileModuleGraph = Readonly<
  Record<"fileName", string> &
    Record<"isBarrel" | "isTest" | "isEntryPoint", true | false> &
    Record<"lineCount", number> & {
      readonly runtimeExports: ReadonlyArray<RuntimeExport>;
      readonly consumersByExport: Readonly<Record<string, ModuleConsumerRecord>>;
      readonly prodImportsByConsumer: Readonly<Record<string, ReadonlyArray<string>>>;
    }
>;

export type ProgramSymbolGraph = Readonly<{
  readonly files: Readonly<Record<string, FileModuleGraph>>;
  readonly publicEntryPointExports: ReadonlySet<string>;
  readonly exportByKey: Readonly<Record<string, RuntimeExport>>;
}>;

export const DEFAULT_TEST_PATTERNS = [
  "**/*.test.ts",
  "**/*.spec.ts",
  "**/*.test.tsx",
  "**/*.spec.tsx",
  "**/__tests__/**",
] as const satisfies ReadonlyArray<string>;

const UNKNOWN_SYMBOL_NAMES: ReadonlySet<string> = new Set(["unknown"]);
const DEFAULT_EXPORT_NAMES: ReadonlySet<string> = new Set(["default"]);

const RUNTIME_SYMBOL_FLAGS =
  ts.SymbolFlags.Value |
  ts.SymbolFlags.Function |
  ts.SymbolFlags.Class |
  ts.SymbolFlags.RegularEnum |
  ts.SymbolFlags.ConstEnum |
  ts.SymbolFlags.Variable |
  ts.SymbolFlags.ValueModule;

const EMPTY_EDGES = [] as ReadonlyArray<RawImportEdge>;
const EMPTY_STRINGS = [] as ReadonlyArray<string>;

type ExportDescriptor = Readonly<
  Record<"exportName" | "localName", string> & {
    readonly kind: RuntimeExportKind;
    readonly declaration: ts.Node;
  } & Record<"symbol", O.Option<ts.Symbol>> &
    Record<"defaultBagProperty", O.Option<string>>
>;

type RawImportEdge = Readonly<Record<"consumerFile" | "exportKey", string>>;

type FileRole = "barrel" | "module";

type FileCatalogEntry = Readonly<
  Record<"filePath", string> &
    Record<"lineCount", number> & {
      readonly role: FileRole;
      readonly exports: ReadonlyArray<RuntimeExport>;
    }
>;

type CatalogIndex = Readonly<{
  readonly barrelFiles: ReadonlySet<string>;
  readonly exportByKey: Readonly<Record<string, RuntimeExport>>;
}>;

type ProgramSymbolCatalog = Readonly<{
  readonly fileExports: Readonly<Record<string, ReadonlyArray<RuntimeExport>>>;
  readonly barrelFiles: ReadonlySet<string>;
  readonly lineCounts: Readonly<Record<string, number>>;
  readonly exportByKey: Readonly<Record<string, RuntimeExport>>;
  readonly importEdges: ReadonlyArray<RawImportEdge>;
}>;

type SymbolLookup = Readonly<{
  readonly bySymbol: ReadonlyMap<ts.Symbol, RuntimeExport>;
  readonly byFileAndLocal: ReadonlyMap<string, RuntimeExport>;
  readonly byFileDefaultProps: ReadonlyMap<string, ReadonlyMap<string, RuntimeExport>>;
}>;

type SymbolResolutionEnv = Readonly<{
  readonly checker: ts.TypeChecker;
  readonly lookup: SymbolLookup;
}>;

type FileImportEnv = Readonly<
  Record<"consumerFile", string> & {
    readonly sf: ts.SourceFile;
    readonly checker: ts.TypeChecker;
    readonly lookup: SymbolLookup;
  }
>;

type DefaultExportTarget = Readonly<{
  readonly stmt: ts.ExportAssignment;
  readonly unwrapped: ts.Expression;
}>;

type GraphQueryScope = Readonly<{
  readonly entryPointPatterns: ReadonlyArray<string>;
  readonly testFilePatterns: ReadonlyArray<string>;
}>;

type MemberEscapeState = "escapes" | "contained";

type ProdEdgeDetail = Readonly<Record<"consumerFile" | "targetFile" | "exportName", string>>;

type DefaultPropPair = Readonly<
  Record<"filePath" | "propName", string> & { readonly exp: RuntimeExport }
>;

type EdgeIndexBundle = Readonly<{
  readonly prodByKey: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly testByKey: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly prodByTargetFile: Readonly<Record<string, ReadonlyArray<ProdEdgeDetail>>>;
}>;

const formatExportKey = (filePath: string, memberName: string) => `${filePath}#${memberName}`;

const formatDefaultBagName = (propName: string) => `default.${propName}`;

const fromStringEntries = <V>(entries: ReadonlyArray<readonly [string, V]>) =>
  Object.fromEntries(entries) as Readonly<Record<string, V>>;

const extractRecordValues = <V>(rec: Readonly<Record<string, V>>) =>
  Object.values(rec) as ReadonlyArray<V>;

const extractRecordEntries = <V>(rec: Readonly<Record<string, V>>) =>
  Object.entries(rec) as ReadonlyArray<readonly [string, V]>;

const extractMapValues = <V>(map: ReadonlyMap<string, V>) =>
  Array.from(map.values()) as ReadonlyArray<V>;

const hasModifierKind = (node: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(node) &&
  RA.some((m: ts.Modifier) => m.kind === kind)(ts.getModifiers(node) ?? []);

const isExportedStmt = (node: ts.Node) => hasModifierKind(node, ts.SyntaxKind.ExportKeyword);
const isDefaultStmt = (node: ts.Node) => hasModifierKind(node, ts.SyntaxKind.DefaultKeyword);
const isAmbientStmt = (node: ts.Node) => hasModifierKind(node, ts.SyntaxKind.DeclareKeyword);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive expression unwrap
export const unwrapExpression = (expr: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expr) ||
  ts.isAsExpression(expr) ||
  ts.isSatisfiesExpression(expr) ||
  ts.isTypeAssertionExpression(expr) ||
  ts.isNonNullExpression(expr)
    ? unwrapExpression(expr.expression)
    : expr;

const isFunctionExpressionNode = (
  node: ts.Node,
): node is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node);

const isFunctionExpressionLike = flow(unwrapExpression, isFunctionExpressionNode);

const classifyUnwrappedExpression = (expr: ts.Expression) =>
  match(expr)
    .when(isFunctionExpressionNode, () => "function" as const)
    .when(ts.isClassExpression, () => "class" as const)
    .otherwise(() => "value" as const);

const classifyExpressionKind = flow(unwrapExpression, classifyUnwrappedExpression);

const classifyInitializerKind = flow(
  O.map(classifyExpressionKind),
  O.getOrElseW(() => "value" as const),
);

const isBarrelAllowedStatement = (stmt: ts.Statement) =>
  ts.isExportDeclaration(stmt) ||
  ts.isImportDeclaration(stmt) ||
  ts.isTypeAliasDeclaration(stmt) ||
  ts.isInterfaceDeclaration(stmt) ||
  ts.isEmptyStatement(stmt);

const isValueExportDeclaration = (stmt: ts.Statement) =>
  ts.isExportDeclaration(stmt) && !stmt.isTypeOnly;

export const isBarrelFile = (sf: ts.SourceFile) =>
  sf.statements.length > 0 &&
  RA.some(isValueExportDeclaration)(sf.statements) &&
  RA.every(isBarrelAllowedStatement)(sf.statements);

const resolveAliasedStep = (symbol: ts.Symbol, checker: ts.TypeChecker) =>
  E.tryCatch(
    () => checker.getAliasedSymbol(symbol),
    () => symbol,
  );

const isFollowableAlias = (aliased: ts.Symbol, current: ts.Symbol) =>
  aliased !== current && !UNKNOWN_SYMBOL_NAMES.has(aliased.name);

const continueAliasWalk = (
  aliased: ts.Symbol,
  current: ts.Symbol,
  visited: ReadonlySet<ts.Symbol>,
  checker: ts.TypeChecker,
) =>
  isFollowableAlias(aliased, current)
    ? walkCanonicalSymbol(aliased, new Set([...visited, current]), checker)
    : current;

const walkCanonicalSymbol = (
  current: ts.Symbol,
  visited: ReadonlySet<ts.Symbol>,
  checker: ts.TypeChecker,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive alias resolution
): ts.Symbol =>
  (current.flags & ts.SymbolFlags.Alias) === 0 || visited.has(current)
    ? current
    : flow(
        (sym: ts.Symbol) => resolveAliasedStep(sym, checker),
        E.match(
          () => current,
          (aliased) => continueAliasWalk(aliased, current, visited, checker),
        ),
      )(current);

export const resolveCanonicalSymbol = (symbol: ts.Symbol, checker: ts.TypeChecker) =>
  walkCanonicalSymbol(symbol, new Set<ts.Symbol>(), checker);

const extractPropertyNameText = (name: ts.PropertyName | ts.BindingName) =>
  match(name)
    .when(ts.isIdentifier, (id) => O.some(id.text))
    .when(ts.isStringLiteral, (lit) => O.some(lit.text))
    .with(P._, () => O.none)
    .exhaustive();

const extractPrimaryDeclaration = (sym: ts.Symbol) =>
  O.fromNullable(sym.valueDeclaration ?? sym.declarations?.[0]);

const extractNodeFilePath = (decl: ts.Node) => normalizeFilePath(decl.getSourceFile().fileName);

const resolveSymbolFilePath = flow(extractPrimaryDeclaration, O.map(extractNodeFilePath));

const buildExportLocationFields = (sf: ts.SourceFile, decl: ts.Node, exportName: string) => {
  const fileName = normalizeFilePath(sf.fileName);
  const loc = resolveTsNodeLocation(decl, sf);
  return {
    key: formatExportKey(fileName, exportName),
    fileName,
    line: loc.line,
    locationKey: makeLocationKey(loc),
  };
};

const buildRuntimeExport = (sf: ts.SourceFile, descriptor: ExportDescriptor) =>
  ({
    ...buildExportLocationFields(sf, descriptor.declaration, descriptor.exportName),
    exportName: descriptor.exportName,
    localName: descriptor.localName,
    kind: descriptor.kind,
    declaration: descriptor.declaration,
    symbol: descriptor.symbol,
    defaultBagProperty: descriptor.defaultBagProperty,
  }) as RuntimeExport;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive binding walk
const collectBindingIdentifiers = (name: ts.BindingName): ReadonlyArray<ts.Identifier> =>
  ts.isIdentifier(name)
    ? [name]
    : RA.flatMap((el: ts.ArrayBindingElement | ts.BindingElement) =>
        ts.isOmittedExpression(el) ? [] : collectBindingIdentifiers(el.name),
      )(name.elements);

const buildIdentifierVariableExport = (
  decl: ts.VariableDeclaration,
  id: ts.Identifier,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  buildRuntimeExport(sf, {
    exportName: id.text,
    localName: id.text,
    kind: classifyInitializerKind(O.fromNullable(decl.initializer)),
    declaration: decl,
    symbol: O.fromNullable(checker.getSymbolAtLocation(id)),
    defaultBagProperty: O.none,
  });

const buildDestructuredExport = (
  decl: ts.VariableDeclaration,
  id: ts.Identifier,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  buildRuntimeExport(sf, {
    exportName: id.text,
    localName: id.text,
    kind: "value",
    declaration: decl,
    symbol: O.fromNullable(checker.getSymbolAtLocation(id)),
    defaultBagProperty: O.none,
  });

const extractVariableDeclExports = (
  decl: ts.VariableDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  ts.isIdentifier(decl.name)
    ? [buildIdentifierVariableExport(decl, decl.name, sf, checker)]
    : RA.map((id: ts.Identifier) => buildDestructuredExport(decl, id, sf, checker))(
        collectBindingIdentifiers(decl.name),
      );

const extractVariableExports = (
  stmt: ts.VariableStatement,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  RA.flatMap((decl: ts.VariableDeclaration) => extractVariableDeclExports(decl, sf, checker))(
    stmt.declarationList.declarations,
  );

const isRuntimeSymbol = (sym: ts.Symbol) => (sym.flags & RUNTIME_SYMBOL_FLAGS) !== 0;

const classifyVarDeclInitializer = flow(
  (v: ts.VariableDeclaration) => O.fromNullable(v.initializer),
  classifyInitializerKind,
);

const classifyDeclarationNode = (decl: ts.Node) =>
  match(decl)
    .when(ts.isFunctionDeclaration, () => "function" as const)
    .when(ts.isMethodDeclaration, () => "function" as const)
    .when(ts.isClassDeclaration, () => "class" as const)
    .when(ts.isVariableDeclaration, classifyVarDeclInitializer)
    .otherwise(() => "value" as const);

const resolveSpecifierSymbol = (spec: ts.ExportSpecifier, checker: ts.TypeChecker) =>
  O.fromNullable(
    checker.getSymbolAtLocation(spec.propertyName ?? spec.name) ??
      checker.getSymbolAtLocation(spec.name),
  );

const resolveSameFileDecl = (canonical: ts.Symbol, sf: ts.SourceFile) =>
  flow(
    extractPrimaryDeclaration,
    O.filter((decl) => extractNodeFilePath(decl) === normalizeFilePath(sf.fileName)),
  )(canonical);

const buildReExportFromDecl = (
  spec: ts.ExportSpecifier,
  canonical: ts.Symbol,
  decl: ts.Declaration,
  sf: ts.SourceFile,
) =>
  buildRuntimeExport(sf, {
    exportName: spec.name.text,
    localName: (spec.propertyName ?? spec.name).text,
    kind: classifyDeclarationNode(decl),
    declaration: decl,
    symbol: O.some(canonical),
    defaultBagProperty: O.none,
  });

const buildSameFileReExport = (
  spec: ts.ExportSpecifier,
  canonical: ts.Symbol,
  sf: ts.SourceFile,
) =>
  O.map((decl: ts.Declaration) => buildReExportFromDecl(spec, canonical, decl, sf))(
    resolveSameFileDecl(canonical, sf),
  );

const extractSingleReExportSpecifier = (
  spec: ts.ExportSpecifier,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  flow(
    (s: ts.ExportSpecifier) => resolveSpecifierSymbol(s, checker),
    O.map((raw) => resolveCanonicalSymbol(raw, checker)),
    O.filter(isRuntimeSymbol),
    O.flatMap((canonical) => buildSameFileReExport(spec, canonical, sf)),
  )(spec);

const isLocalNamedExportDecl = (stmt: ts.ExportDeclaration) =>
  !stmt.isTypeOnly && !stmt.moduleSpecifier && Boolean(stmt.exportClause);

const extractNamedReExportSpecifiers = (
  stmt: ts.ExportDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  isLocalNamedExportDecl(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)
    ? flow(
        RA.filter((spec: ts.ExportSpecifier) => !spec.isTypeOnly),
        RA.filterMap((spec) => extractSingleReExportSpecifier(spec, sf, checker)),
      )(stmt.exportClause.elements)
    : [];

const resolveShorthandKind = (
  canonical: O.Option<ts.Symbol>,
  prop: ts.ShorthandPropertyAssignment,
) =>
  flow(
    O.flatMap(extractPrimaryDeclaration),
    O.getOrElse(() => prop as ts.Node),
    classifyDeclarationNode,
  )(canonical);

const buildShorthandBagExport = (
  prop: ts.ShorthandPropertyAssignment,
  canonical: O.Option<ts.Symbol>,
  sf: ts.SourceFile,
) =>
  buildRuntimeExport(sf, {
    exportName: formatDefaultBagName(prop.name.text),
    localName: prop.name.text,
    kind: resolveShorthandKind(canonical, prop),
    declaration: prop,
    symbol: canonical,
    defaultBagProperty: O.some(prop.name.text),
  });

const lookupNodeSymbol = (checker: ts.TypeChecker) =>
  flow((node: ts.Node) => checker.getSymbolAtLocation(node), O.fromNullable);

const lookupShorthandSymbol = (checker: ts.TypeChecker) =>
  flow(
    (prop: ts.ShorthandPropertyAssignment) => checker.getShorthandAssignmentValueSymbol(prop),
    O.fromNullable,
  );

const resolveCanonicalAtNode = (node: ts.Node, checker: ts.TypeChecker) =>
  flow(
    lookupNodeSymbol(checker),
    O.map((raw) => resolveCanonicalSymbol(raw, checker)),
  )(node);

const resolveShorthandCanonical = (
  prop: ts.ShorthandPropertyAssignment,
  checker: ts.TypeChecker,
) =>
  flow(
    lookupShorthandSymbol(checker),
    O.map((raw) => resolveCanonicalSymbol(raw, checker)),
  )(prop);

const extractShorthandBagProperty = (
  prop: ts.ShorthandPropertyAssignment,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  flow(
    (p: ts.ShorthandPropertyAssignment) => resolveShorthandCanonical(p, checker),
    (canonical) => buildShorthandBagExport(prop, canonical, sf),
    O.some,
  )(prop);

const resolvePropAssignmentSymbol = (
  prop: ts.PropertyAssignment,
  unwrappedInit: ts.Expression,
  checker: ts.TypeChecker,
) =>
  ts.isIdentifier(unwrappedInit)
    ? resolveCanonicalAtNode(unwrappedInit, checker)
    : O.fromNullable(checker.getSymbolAtLocation(prop.name));

const classifyAssignedTargetKind = (
  unwrapped: ts.Expression,
  targetSym: O.Option<ts.Symbol>,
  fallbackExpr: ts.Expression,
) =>
  ts.isIdentifier(unwrapped)
    ? flow(
        O.flatMap((sym: ts.Symbol) => O.fromNullable(sym.valueDeclaration)),
        O.map(classifyDeclarationNode),
        O.getOrElse(() => classifyInitializerKind(O.some(fallbackExpr))),
      )(targetSym)
    : classifyInitializerKind(O.some(fallbackExpr));

const buildPropertyAssignmentBagExport = (
  prop: ts.PropertyAssignment,
  propName: string,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) => {
  const unwrappedInit = unwrapExpression(prop.initializer);
  const targetSym = resolvePropAssignmentSymbol(prop, unwrappedInit, checker);
  return buildRuntimeExport(sf, {
    exportName: formatDefaultBagName(propName),
    localName: propName,
    kind: classifyAssignedTargetKind(unwrappedInit, targetSym, prop.initializer),
    declaration: prop,
    symbol: targetSym,
    defaultBagProperty: O.some(propName),
  });
};

const extractPropertyAssignmentBag = (
  prop: ts.PropertyAssignment,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  O.map((propName: string) => buildPropertyAssignmentBagExport(prop, propName, sf, checker))(
    extractPropertyNameText(prop.name),
  );

const extractMethodBagProperty = (
  prop: ts.MethodDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  O.map((propName: string) =>
    buildRuntimeExport(sf, {
      exportName: formatDefaultBagName(propName),
      localName: propName,
      kind: "function",
      declaration: prop,
      symbol: O.fromNullable(checker.getSymbolAtLocation(prop.name)),
      defaultBagProperty: O.some(propName),
    }),
  )(extractPropertyNameText(prop.name));

const extractDefaultBagProperty = (
  prop: ts.ObjectLiteralElementLike,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  match(prop)
    .when(ts.isShorthandPropertyAssignment, (p) => extractShorthandBagProperty(p, sf, checker))
    .when(ts.isPropertyAssignment, (p) => extractPropertyAssignmentBag(p, sf, checker))
    .when(ts.isMethodDeclaration, (p) => extractMethodBagProperty(p, sf, checker))
    .with(P._, () => O.none)
    .exhaustive();

const resolveDefaultTargetSymbol = (target: DefaultExportTarget, checker: ts.TypeChecker) =>
  ts.isIdentifier(target.unwrapped)
    ? resolveCanonicalAtNode(target.unwrapped, checker)
    : O.fromNullable(checker.getSymbolAtLocation(target.stmt));

const buildSingleDefaultExport = (
  target: DefaultExportTarget,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) => {
  const targetSym = resolveDefaultTargetSymbol(target, checker);
  return [
    buildRuntimeExport(sf, {
      exportName: "default",
      localName: ts.isIdentifier(target.unwrapped) ? target.unwrapped.text : "default",
      kind: classifyAssignedTargetKind(target.unwrapped, targetSym, target.unwrapped),
      declaration: target.stmt,
      symbol: targetSym,
      defaultBagProperty: O.none,
    }),
  ];
};

const extractDefaultBagExports = (
  obj: ts.ObjectLiteralExpression,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  obj.properties.length >= 2
    ? RA.filterMap((prop: ts.ObjectLiteralElementLike) =>
        extractDefaultBagProperty(prop, sf, checker),
      )(obj.properties)
    : [];

const extractDefaultAssignmentTarget = (
  target: DefaultExportTarget,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) => {
  const bagProps = ts.isObjectLiteralExpression(target.unwrapped)
    ? extractDefaultBagExports(target.unwrapped, sf, checker)
    : [];
  return bagProps.length >= 2 ? bagProps : buildSingleDefaultExport(target, sf, checker);
};

const extractDefaultAssignment = (
  stmt: ts.ExportAssignment,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  stmt.isExportEquals
    ? []
    : extractDefaultAssignmentTarget(
        { stmt, unwrapped: unwrapExpression(stmt.expression) },
        sf,
        checker,
      );

const resolveNamedDeclSymbol = (
  stmt: ts.FunctionDeclaration | ts.ClassDeclaration,
  checker: ts.TypeChecker,
) =>
  stmt.name
    ? O.fromNullable(checker.getSymbolAtLocation(stmt.name))
    : O.fromNullable(checker.getSymbolAtLocation(stmt));

const extractExportedFunctionOrClass = (
  stmt: ts.FunctionDeclaration | ts.ClassDeclaration,
  kind: "function" | "class",
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) => [
  buildRuntimeExport(sf, {
    exportName: isDefaultStmt(stmt) ? "default" : stmt.name?.text ?? "default",
    localName: stmt.name?.text ?? "default",
    kind,
    declaration: stmt,
    symbol: resolveNamedDeclSymbol(stmt, checker),
    defaultBagProperty: O.none,
  }),
];

const extractExportedFunctionDecl = (
  stmt: ts.FunctionDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  stmt.body && isExportedStmt(stmt)
    ? extractExportedFunctionOrClass(stmt, "function", sf, checker)
    : [];

const extractExportedClassDecl = (
  stmt: ts.ClassDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) => (isExportedStmt(stmt) ? extractExportedFunctionOrClass(stmt, "class", sf, checker) : []);

const extractExportedEnumDecl = (
  stmt: ts.EnumDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  isExportedStmt(stmt)
    ? [
        buildRuntimeExport(sf, {
          exportName: stmt.name.text,
          localName: stmt.name.text,
          kind: "value",
          declaration: stmt,
          symbol: O.fromNullable(checker.getSymbolAtLocation(stmt.name)),
          defaultBagProperty: O.none,
        }),
      ]
    : [];

const extractStatementExports = (
  stmt: ts.Statement,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  isAmbientStmt(stmt)
    ? []
    : match(stmt)
        .when(ts.isFunctionDeclaration, (s) => extractExportedFunctionDecl(s, sf, checker))
        .when(ts.isClassDeclaration, (s) => extractExportedClassDecl(s, sf, checker))
        .when(ts.isEnumDeclaration, (s) => extractExportedEnumDecl(s, sf, checker))
        .when(ts.isVariableStatement, (s) =>
          isExportedStmt(s) ? extractVariableExports(s, sf, checker) : [],
        )
        .when(ts.isExportDeclaration, (s) => extractNamedReExportSpecifiers(s, sf, checker))
        .when(ts.isExportAssignment, (s) => extractDefaultAssignment(s, sf, checker))
        .otherwise(() => []);

const deduplicateByExportName = (exports: ReadonlyArray<RuntimeExport>) =>
  RA.reduce(
    { seen: new Set<string>(), items: [] as ReadonlyArray<RuntimeExport> },
    (acc, exp: RuntimeExport) =>
      acc.seen.has(exp.exportName)
        ? acc
        : {
            seen: new Set([...acc.seen, exp.exportName]),
            items: RA.append(exp)(acc.items),
          },
  )(exports).items;

export const extractFileRuntimeExports = (sf: ts.SourceFile, checker: ts.TypeChecker) =>
  isBarrelFile(sf)
    ? []
    : flow(
        RA.flatMap((stmt: ts.Statement) => extractStatementExports(stmt, sf, checker)),
        deduplicateByExportName,
      )(sf.statements);

const isFunctionVariableDecl = (node: ts.Node) =>
  ts.isVariableDeclaration(node) &&
  O.exists(isFunctionExpressionLike)(O.fromNullable(node.initializer));

export const isRuntimeFunctionNode = (node: ts.Node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  isFunctionExpressionNode(node) ||
  isFunctionVariableDecl(node);

const toSymbolEntry = (exp: RuntimeExport) =>
  O.map((sym: ts.Symbol) => [sym, exp] as const)(exp.symbol);

const toFileAndLocalEntries = (exp: RuntimeExport) => [
  [formatExportKey(exp.fileName, exp.localName), exp] as const,
  [formatExportKey(exp.fileName, exp.exportName), exp] as const,
];

const toDefaultPropPair = (exp: RuntimeExport) =>
  O.map((propName: string) => ({ filePath: exp.fileName, propName, exp }))(exp.defaultBagProperty);

const groupDefaultPropsByFile = RA.reduce<
  DefaultPropPair,
  Readonly<Record<string, ReadonlyArray<readonly [string, RuntimeExport]>>>
>({}, (acc, item) => ({
  ...acc,
  [item.filePath]: RA.append([item.propName, item.exp] as const)(acc[item.filePath] ?? []),
}));

const buildDefaultPropsMap = (exports: ReadonlyArray<RuntimeExport>) =>
  new Map(
    flow(
      RA.filterMap(toDefaultPropPair),
      groupDefaultPropsByFile,
      extractRecordEntries,
      RA.map(([filePath, pairs]) => [filePath, new Map(pairs)] as const),
    )(exports),
  );

const buildSymbolLookup = (exportByKey: Readonly<Record<string, RuntimeExport>>) => {
  const allExports = extractRecordValues(exportByKey);
  return {
    bySymbol: new Map(RA.filterMap(toSymbolEntry)(allExports)),
    byFileAndLocal: new Map(RA.flatMap(toFileAndLocalEntries)(allExports)),
    byFileDefaultProps: buildDefaultPropsMap(allExports),
  } as SymbolLookup;
};

const lookupInStringMap = <V>(map: ReadonlyMap<string, V>) =>
  flow((key: string) => map.get(key), O.fromNullable);

const lookupFileExportByKey = (
  byFileAndLocal: ReadonlyMap<string, RuntimeExport>,
  declFile: string,
  memberName: string,
) => flow(formatExportKey, lookupInStringMap(byFileAndLocal))(declFile, memberName);

const lookupByFileAndSymbol = (
  canonical: ts.Symbol,
  declFile: string,
  byFileAndLocal: ReadonlyMap<string, RuntimeExport>,
) =>
  O.alt(() =>
    DEFAULT_EXPORT_NAMES.has(canonical.name)
      ? lookupFileExportByKey(byFileAndLocal, declFile, "default")
      : O.none,
  )(lookupFileExportByKey(byFileAndLocal, declFile, canonical.name));

const lookupByCanonicalFile = (
  canonical: ts.Symbol,
  byFileAndLocal: ReadonlyMap<string, RuntimeExport>,
) =>
  flow(
    resolveSymbolFilePath,
    O.flatMap((declFile) => lookupByFileAndSymbol(canonical, declFile, byFileAndLocal)),
  )(canonical);

const lookupDirectSymbol = (
  canonical: ts.Symbol,
  bySymbol: ReadonlyMap<ts.Symbol, RuntimeExport>,
) => O.fromNullable(bySymbol.get(canonical));

const matchSymbolToExport = (sym: ts.Symbol, { checker, lookup }: SymbolResolutionEnv) => {
  const canonical = resolveCanonicalSymbol(sym, checker);
  return O.alt(() => lookupByCanonicalFile(canonical, lookup.byFileAndLocal))(
    lookupDirectSymbol(canonical, lookup.bySymbol),
  );
};

const extractBindingPropName = (el: ts.BindingElement) =>
  extractPropertyNameText(el.propertyName ?? el.name);

const extractBindingPropNames = (pattern: ts.ObjectBindingPattern) =>
  RA.filterMap(extractBindingPropName)(pattern.elements);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const collectAstNodes = (root: ts.Node, sf: ts.SourceFile): ReadonlyArray<ts.Node> =>
  ts.isJSDoc(root)
    ? []
    : [
        root,
        ...RA.flatMap((child: ts.Node) => collectAstNodes(child, sf))(root.getChildren(sf)),
      ];

const hasMatchingSymbol = (expr: ts.Expression, targetSym: ts.Symbol, checker: ts.TypeChecker) =>
  ts.isIdentifier(expr) && checker.getSymbolAtLocation(expr) === targetSym;

const extractPropAccessTarget = (
  node: ts.PropertyAccessExpression,
  targetSym: ts.Symbol,
  checker: ts.TypeChecker,
) => (hasMatchingSymbol(node.expression, targetSym, checker) ? [node.name.text] : []);

const extractElementAccessTarget = (
  node: ts.ElementAccessExpression,
  targetSym: ts.Symbol,
  checker: ts.TypeChecker,
) =>
  ts.isStringLiteral(node.argumentExpression) &&
  hasMatchingSymbol(node.expression, targetSym, checker)
    ? [node.argumentExpression.text]
    : [];

const extractDestructureTarget = (
  node: ts.VariableDeclaration,
  targetSym: ts.Symbol,
  checker: ts.TypeChecker,
) =>
  node.initializer &&
  ts.isObjectBindingPattern(node.name) &&
  hasMatchingSymbol(node.initializer, targetSym, checker)
    ? extractBindingPropNames(node.name)
    : [];

const isImportBindingIdent = (node: ts.Identifier, parent: ts.Node) =>
  (ts.isNamespaceImport(parent) && parent.name === node) ||
  (ts.isImportClause(parent) && parent.name === node);

const isMemberAccessBase = (node: ts.Identifier, parent: ts.Node) =>
  (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
  (ts.isElementAccessExpression(parent) && parent.expression === node) ||
  (ts.isVariableDeclaration(parent) &&
    parent.initializer === node &&
    ts.isObjectBindingPattern(parent.name));

const isEscapingIdentifier = (node: ts.Node, targetSym: ts.Symbol, checker: ts.TypeChecker) =>
  ts.isIdentifier(node) &&
  checker.getSymbolAtLocation(node) === targetSym &&
  !isImportBindingIdent(node, node.parent) &&
  !isMemberAccessBase(node, node.parent);

const extractAccessedNamesFromNode = (
  node: ts.Node,
  targetSym: ts.Symbol,
  checker: ts.TypeChecker,
) =>
  match(node)
    .when(ts.isPropertyAccessExpression, (n) => extractPropAccessTarget(n, targetSym, checker))
    .when(ts.isElementAccessExpression, (n) => extractElementAccessTarget(n, targetSym, checker))
    .when(ts.isVariableDeclaration, (n) => extractDestructureTarget(n, targetSym, checker))
    .otherwise(() => []);

const collectIdentifierMemberAccesses = (
  sf: ts.SourceFile,
  targetSym: ts.Symbol,
  checker: ts.TypeChecker,
) => {
  const nodes = collectAstNodes(sf, sf);
  return {
    accessedNames: flow(
      RA.flatMap((node: ts.Node) => extractAccessedNamesFromNode(node, targetSym, checker)),
      RA.uniq(S.Eq),
    )(nodes),
    escapeState: RA.some((node: ts.Node) => isEscapingIdentifier(node, targetSym, checker))(nodes)
      ? ("escapes" as const)
      : ("contained" as const),
  };
};

const resolveModuleExportByName = (
  moduleSym: ts.Symbol,
  exportName: string,
  env: SymbolResolutionEnv,
) =>
  flow(
    RA.findFirst((e: ts.Symbol) => e.name === exportName),
    O.flatMap((found) => matchSymbolToExport(found, env)),
  )(env.checker.getExportsOfModule(moduleSym));

const resolveAllModuleExports = (moduleSym: ts.Symbol, env: SymbolResolutionEnv) =>
  RA.filterMap((sym: ts.Symbol) => matchSymbolToExport(sym, env))(
    env.checker.getExportsOfModule(moduleSym),
  );

const toRawEdge = (consumerFile: string) => (exp: RuntimeExport) =>
  ({ consumerFile, exportKey: exp.key }) as RawImportEdge;

const isUnusedWholeEscape = (state: MemberEscapeState, count: number) =>
  state === "escapes" && count === 0;

const resolveDefaultBagUsageEdges =
  (rawSym: ts.Symbol, bagProps: ReadonlyMap<string, RuntimeExport>) =>
  (fileEnv: FileImportEnv) => {
    const usage = collectIdentifierMemberAccesses(fileEnv.sf, rawSym, fileEnv.checker);
    return isUnusedWholeEscape(usage.escapeState, usage.accessedNames.length)
      ? RA.map(toRawEdge(fileEnv.consumerFile))(extractMapValues(bagProps))
      : flow(
          RA.filterMap(lookupInStringMap(bagProps)),
          RA.map(toRawEdge(fileEnv.consumerFile)),
        )(usage.accessedNames);
  };

type DefaultImportRef = Readonly<{
  readonly rawSym: ts.Symbol;
  readonly moduleSpecifier: ts.Expression;
}>;

const collectDefaultBagEdges = (ref: DefaultImportRef) => (fileEnv: FileImportEnv) =>
  flow(
    lookupNodeSymbol(fileEnv.checker),
    O.flatMap(resolveSymbolFilePath),
    O.flatMap(lookupInStringMap(fileEnv.lookup.byFileDefaultProps)),
    O.map((bagProps) => resolveDefaultBagUsageEdges(ref.rawSym, bagProps)(fileEnv)),
    O.getOrElse(() => EMPTY_EDGES),
  )(ref.moduleSpecifier);

const dispatchDefaultSymbolEdges = (ref: DefaultImportRef, fileEnv: FileImportEnv) =>
  O.match(
    () => collectDefaultBagEdges(ref)(fileEnv),
    (direct: RuntimeExport) => [toRawEdge(fileEnv.consumerFile)(direct)],
  )(matchSymbolToExport(ref.rawSym, { checker: fileEnv.checker, lookup: fileEnv.lookup }));

const resolveDefaultSymbolEdges = (ref: DefaultImportRef) => (fileEnv: FileImportEnv) =>
  dispatchDefaultSymbolEdges(ref, fileEnv);

const collectDefaultImportEdges =
  (defaultName: ts.Identifier, moduleSpecifier: ts.Expression) => (fileEnv: FileImportEnv) =>
    flow(
      lookupNodeSymbol(fileEnv.checker),
      O.map((rawSym) => resolveDefaultSymbolEdges({ rawSym, moduleSpecifier })(fileEnv)),
      O.getOrElse(() => EMPTY_EDGES),
    )(defaultName);

const resolveNamespaceUsageEdges =
  (nsSym: ts.Symbol, modSym: ts.Symbol) => (fileEnv: FileImportEnv) => {
    const env: SymbolResolutionEnv = { checker: fileEnv.checker, lookup: fileEnv.lookup };
    const usage = collectIdentifierMemberAccesses(fileEnv.sf, nsSym, fileEnv.checker);
    const accessedEdges = flow(
      RA.filterMap((name: string) => resolveModuleExportByName(modSym, name, env)),
      RA.map(toRawEdge(fileEnv.consumerFile)),
    )(usage.accessedNames);
    return isUnusedWholeEscape(usage.escapeState, accessedEdges.length)
      ? RA.map(toRawEdge(fileEnv.consumerFile))(resolveAllModuleExports(modSym, env))
      : accessedEdges;
  };

const isExternalModulePath = (filePath: string) => filePath.includes("/node_modules/");

const isProjectModuleDeclaration = (decl: ts.Node) =>
  !decl.getSourceFile().isDeclarationFile && !isExternalModulePath(extractNodeFilePath(decl));

const isProjectModuleSymbol = flow(extractPrimaryDeclaration, O.exists(isProjectModuleDeclaration));

const resolveModuleNamespaceEdges =
  (nsSym: ts.Symbol, moduleSpecifier: ts.Expression) => (fileEnv: FileImportEnv) =>
    flow(
      lookupNodeSymbol(fileEnv.checker),
      O.filter(isProjectModuleSymbol),
      O.map((modSym) => resolveNamespaceUsageEdges(nsSym, modSym)(fileEnv)),
    )(moduleSpecifier);

const collectNamespaceImportEdges =
  (nsBinding: ts.NamespaceImport, moduleSpecifier: ts.Expression) => (fileEnv: FileImportEnv) =>
    flow(
      lookupNodeSymbol(fileEnv.checker),
      O.flatMap((nsSym) => resolveModuleNamespaceEdges(nsSym, moduleSpecifier)(fileEnv)),
      O.getOrElse(() => EMPTY_EDGES),
    )(nsBinding.name);

const resolveNamedImportSpecifierEdge = (spec: ts.ImportSpecifier) => (fileEnv: FileImportEnv) =>
  flow(
    lookupNodeSymbol(fileEnv.checker),
    O.flatMap((sym) =>
      matchSymbolToExport(sym, { checker: fileEnv.checker, lookup: fileEnv.lookup }),
    ),
    O.map(toRawEdge(fileEnv.consumerFile)),
  )(spec.name);

const collectNamedImportEdges = (namedBindings: ts.NamedImports) => (fileEnv: FileImportEnv) =>
  flow(
    RA.filter((spec: ts.ImportSpecifier) => !spec.isTypeOnly),
    RA.filterMap((spec) => resolveNamedImportSpecifierEdge(spec)(fileEnv)),
  )(namedBindings.elements);

const isValueImportClause = (clause: ts.ImportClause) =>
  clause.phaseModifier !== ts.SyntaxKind.TypeKeyword;

const collectBindingsEdges =
  (bindings: ts.NamedImportBindings, moduleSpecifier: ts.Expression) => (fileEnv: FileImportEnv) =>
    ts.isNamespaceImport(bindings)
      ? collectNamespaceImportEdges(bindings, moduleSpecifier)(fileEnv)
      : collectNamedImportEdges(bindings)(fileEnv);

const collectImportClauseEdges =
  (clause: ts.ImportClause, moduleSpecifier: ts.Expression) => (fileEnv: FileImportEnv) => [
    ...(clause.name ? collectDefaultImportEdges(clause.name, moduleSpecifier)(fileEnv) : []),
    ...(clause.namedBindings
      ? collectBindingsEdges(clause.namedBindings, moduleSpecifier)(fileEnv)
      : []),
  ];

const collectImportDeclEdges = (decl: ts.ImportDeclaration) => (fileEnv: FileImportEnv) =>
  decl.importClause && isValueImportClause(decl.importClause)
    ? collectImportClauseEdges(decl.importClause, decl.moduleSpecifier)(fileEnv)
    : EMPTY_EDGES;

const collectStatementsImportEdges =
  (statements: ReadonlyArray<ts.Statement>) => (fileEnv: FileImportEnv) =>
    flow(
      RA.filter(ts.isImportDeclaration),
      RA.flatMap((decl) => collectImportDeclEdges(decl)(fileEnv)),
    )(statements);

const collectFileImportEdges = (sf: ts.SourceFile, resolution: SymbolResolutionEnv) =>
  collectStatementsImportEdges(sf.statements)({
    sf,
    consumerFile: normalizeFilePath(sf.fileName),
    checker: resolution.checker,
    lookup: resolution.lookup,
  });

const countSourceFileLines = (sf: ts.SourceFile) =>
  sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1;

const extractFileCatalogEntry = (sf: ts.SourceFile, checker: ts.TypeChecker) =>
  ({
    filePath: normalizeFilePath(sf.fileName),
    lineCount: countSourceFileLines(sf),
    role: isBarrelFile(sf) ? ("barrel" as const) : ("module" as const),
    exports: extractFileRuntimeExports(sf, checker),
  }) as FileCatalogEntry;

const isCrossFileEdge = (
  edge: RawImportEdge,
  exportByKey: Readonly<Record<string, RuntimeExport>>,
) =>
  O.exists((exp: RuntimeExport) => exp.fileName !== edge.consumerFile)(
    O.fromNullable(exportByKey[edge.exportKey]),
  );

const isNonBarrelSourceFile = (sf: ts.SourceFile, barrelFiles: ReadonlySet<string>) =>
  !barrelFiles.has(normalizeFilePath(sf.fileName));

const collectCatalogImportsWithEnv = (
  sourceFiles: ReadonlyArray<ts.SourceFile>,
  catalogIndex: CatalogIndex,
  resolution: SymbolResolutionEnv,
) =>
  flow(
    RA.filter((sf: ts.SourceFile) => isNonBarrelSourceFile(sf, catalogIndex.barrelFiles)),
    RA.flatMap((sf) => collectFileImportEdges(sf, resolution)),
    RA.filter((edge) => isCrossFileEdge(edge, catalogIndex.exportByKey)),
  )(sourceFiles);

const buildCatalogImports = (
  sourceFiles: ReadonlyArray<ts.SourceFile>,
  catalogIndex: CatalogIndex,
  checker: ts.TypeChecker,
) =>
  collectCatalogImportsWithEnv(sourceFiles, catalogIndex, {
    checker,
    lookup: buildSymbolLookup(catalogIndex.exportByKey),
  });

const indexCatalogExports = flow(
  RA.flatMap((e: FileCatalogEntry) =>
    RA.map((exp: RuntimeExport) => [exp.key, exp] as const)(e.exports),
  ),
  fromStringEntries,
);

const indexCatalogFileExports = flow(
  RA.map((e: FileCatalogEntry) => [e.filePath, e.exports] as const),
  fromStringEntries,
);

const indexCatalogLineCounts = flow(
  RA.map((e: FileCatalogEntry) => [e.filePath, e.lineCount] as const),
  fromStringEntries,
);

const collectBarrelPathSet = (entries: ReadonlyArray<FileCatalogEntry>) =>
  new Set(
    RA.filterMap((e: FileCatalogEntry) => (e.role === "barrel" ? O.some(e.filePath) : O.none))(
      entries,
    ),
  );

const assembleProgramCatalog = (
  sourceFiles: ReadonlyArray<ts.SourceFile>,
  entries: ReadonlyArray<FileCatalogEntry>,
  checker: ts.TypeChecker,
) => {
  const catalogIndex: CatalogIndex = {
    barrelFiles: collectBarrelPathSet(entries),
    exportByKey: indexCatalogExports(entries),
  };
  return {
    fileExports: indexCatalogFileExports(entries),
    barrelFiles: catalogIndex.barrelFiles,
    lineCounts: indexCatalogLineCounts(entries),
    exportByKey: catalogIndex.exportByKey,
    importEdges: buildCatalogImports(sourceFiles, catalogIndex, checker),
  } as ProgramSymbolCatalog;
};

const computeProgramSymbolCatalog = (program: ts.Program) => {
  const checker = program.getTypeChecker();
  const sourceFiles = collectProjectSourceFiles(program);
  return assembleProgramCatalog(
    sourceFiles,
    RA.map((sf: ts.SourceFile) => extractFileCatalogEntry(sf, checker))(sourceFiles),
    checker,
  );
};

const extractExportKeys = RA.map((exp: RuntimeExport) => exp.key);

const resolveModuleExportKeys = (resolution: SymbolResolutionEnv) =>
  flow(
    (modSym: ts.Symbol) => resolveAllModuleExports(modSym, resolution),
    extractExportKeys,
  );

const extractModuleExportKeys = (sf: ts.SourceFile, resolution: SymbolResolutionEnv) =>
  flow(
    lookupNodeSymbol(resolution.checker),
    O.map(resolveModuleExportKeys(resolution)),
    O.getOrElse(() => EMPTY_STRINGS),
  )(sf);

const collectEntryPointFileKeys = (
  sf: ts.SourceFile,
  catalog: ProgramSymbolCatalog,
  resolution: SymbolResolutionEnv,
) => [
  ...extractExportKeys(catalog.fileExports[normalizeFilePath(sf.fileName)] ?? []),
  ...extractModuleExportKeys(sf, resolution),
];

const isMatchingEntryPointFile = (sf: ts.SourceFile, patterns: ReadonlyArray<string>) =>
  isMatchingAnyPattern(normalizeFilePath(sf.fileName), patterns);

const collectEntryPointKeysWithEnv = (
  sourceFiles: ReadonlyArray<ts.SourceFile>,
  catalog: ProgramSymbolCatalog,
  patterns: ReadonlyArray<string>,
  resolution: SymbolResolutionEnv,
) =>
  flow(
    RA.filter((sf: ts.SourceFile) => isMatchingEntryPointFile(sf, patterns)),
    RA.flatMap((sf) => collectEntryPointFileKeys(sf, catalog, resolution)),
  )(sourceFiles);

const resolveEntryPointExports = (
  program: ts.Program,
  catalog: ProgramSymbolCatalog,
  entryPointPatterns: ReadonlyArray<string>,
) =>
  entryPointPatterns.length === 0
    ? new Set<string>()
    : new Set(
        collectEntryPointKeysWithEnv(
          collectProjectSourceFiles(program),
          catalog,
          entryPointPatterns,
          {
            checker: program.getTypeChecker(),
            lookup: buildSymbolLookup(catalog.exportByKey),
          },
        ),
      );

const groupStringsByKey = <T>(
  items: ReadonlyArray<T>,
  extractKey: (item: T) => string,
  extractVal: (item: T) => string,
) =>
  flow(
    RNEA.groupBy(extractKey),
    RR.map(RA.map(extractVal)),
  )(items);

const sortUniqueStrings = flow(RA.uniq(S.Eq), RA.sort(S.Ord));

const sortGroupedValues = flow(
  extractRecordEntries<ReadonlyArray<string>>,
  RA.map(([k, vals]) => [k, sortUniqueStrings(vals)] as const),
  fromStringEntries,
);

const groupAndSortStrings = <T>(
  items: ReadonlyArray<T>,
  extractKey: (item: T) => string,
  extractVal: (item: T) => string,
) =>
  flow(
    (xs: ReadonlyArray<T>) => groupStringsByKey(xs, extractKey, extractVal),
    sortGroupedValues,
  )(items);

const toProdEdgeDetail = (
  edge: RawImportEdge,
  exportByKey: Readonly<Record<string, RuntimeExport>>,
) =>
  O.map((exp: RuntimeExport) => ({
    consumerFile: edge.consumerFile,
    targetFile: exp.fileName,
    exportName: exp.exportName,
  }))(O.fromNullable(exportByKey[edge.exportKey]));

const groupProdDetailsByTarget = RNEA.groupBy((detail: ProdEdgeDetail) => detail.targetFile);

const buildFileConsumersByExport = (
  runtimeExports: ReadonlyArray<RuntimeExport>,
  prodByKey: Readonly<Record<string, ReadonlyArray<string>>>,
  testByKey: Readonly<Record<string, ReadonlyArray<string>>>,
) =>
  flow(
    RA.map(
      (exp: RuntimeExport) =>
        [
          exp.exportName,
          {
            exportKey: exp.key,
            prodConsumers: prodByKey[exp.key] ?? [],
            testConsumers: testByKey[exp.key] ?? [],
          },
        ] as const,
    ),
    fromStringEntries,
  )(runtimeExports);

const buildFileProdImportsByConsumer = (details: ReadonlyArray<ProdEdgeDetail>) =>
  groupAndSortStrings(
    details,
    (d) => d.consumerFile,
    (d) => d.exportName,
  );

const groupConsumersByExportKey = (edges: ReadonlyArray<RawImportEdge>) =>
  groupAndSortStrings(
    edges,
    (e) => e.exportKey,
    (e) => e.consumerFile,
  );

const isTestConsumerEdge = (edge: RawImportEdge, patterns: ReadonlyArray<string>) =>
  isMatchingAnyPattern(edge.consumerFile, patterns);

const isProdConsumerEdge = (edge: RawImportEdge, patterns: ReadonlyArray<string>) =>
  !isMatchingAnyPattern(edge.consumerFile, patterns);

const buildEdgeIndexBundle = (
  catalog: ProgramSymbolCatalog,
  testFilePatterns: ReadonlyArray<string>,
) => {
  const prodEdges = RA.filter((e: RawImportEdge) => isProdConsumerEdge(e, testFilePatterns))(
    catalog.importEdges,
  );
  return {
    prodByKey: groupConsumersByExportKey(prodEdges),
    testByKey: groupConsumersByExportKey(
      RA.filter((e: RawImportEdge) => isTestConsumerEdge(e, testFilePatterns))(catalog.importEdges),
    ),
    prodByTargetFile: groupProdDetailsByTarget(
      RA.filterMap((e: RawImportEdge) => toProdEdgeDetail(e, catalog.exportByKey))(prodEdges),
    ),
  } as EdgeIndexBundle;
};

type FileGraphBuildContext = Readonly<{
  readonly catalog: ProgramSymbolCatalog;
  readonly edgeIndex: EdgeIndexBundle;
  readonly scope: GraphQueryScope;
}>;

const buildFileModuleFlags = (filePath: string, { catalog, scope }: FileGraphBuildContext) => ({
  fileName: filePath,
  isBarrel: catalog.barrelFiles.has(filePath),
  isTest: isMatchingAnyPattern(filePath, scope.testFilePatterns),
  isEntryPoint: isMatchingAnyPattern(filePath, scope.entryPointPatterns),
  lineCount: catalog.lineCounts[filePath] ?? 0,
});

const buildFileModuleGraph = (
  filePath: string,
  runtimeExports: ReadonlyArray<RuntimeExport>,
  ctx: FileGraphBuildContext,
) => {
  const { prodByKey, testByKey, prodByTargetFile } = ctx.edgeIndex;
  return {
    ...buildFileModuleFlags(filePath, ctx),
    runtimeExports,
    consumersByExport: buildFileConsumersByExport(runtimeExports, prodByKey, testByKey),
    prodImportsByConsumer: buildFileProdImportsByConsumer(prodByTargetFile[filePath] ?? []),
  };
};

const buildAllFileGraphs = (ctx: FileGraphBuildContext) =>
  flow(
    extractRecordEntries<ReadonlyArray<RuntimeExport>>,
    RA.map(
      ([filePath, runtimeExports]) =>
        [filePath, buildFileModuleGraph(filePath, runtimeExports, ctx)] as const,
    ),
    fromStringEntries,
  )(ctx.catalog.fileExports);

const computeProgramSymbolGraph = (program: ts.Program, scope: GraphQueryScope) => {
  const catalog = computeProgramSymbolCatalog(program);
  return {
    files: buildAllFileGraphs({
      catalog,
      edgeIndex: buildEdgeIndexBundle(catalog, scope.testFilePatterns),
      scope,
    }),
    publicEntryPointExports: resolveEntryPointExports(program, catalog, scope.entryPointPatterns),
    exportByKey: catalog.exportByKey,
  } as ProgramSymbolGraph;
};

export const analyzeModuleSymbolGraph = (
  program: ts.Program,
  entryPointPatterns: ReadonlyArray<string> = [],
  testFilePatterns: ReadonlyArray<string> = DEFAULT_TEST_PATTERNS,
) =>
  computeProgramSymbolGraph(program, {
    entryPointPatterns,
    testFilePatterns,
  });
