import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServices,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { normalizeFilePath } from "./program-cache.js";
import { isCalleeOfCallExpression } from "./type-helpers.js";

type FpTsImports = Readonly<{
  namespaces: ReadonlySet<string>;
  locals: ReadonlySet<string>;
}>;

type CheckerContext = Readonly<{
  services: ParserServicesWithTypeInformation;
  checker: ts.TypeChecker;
}>;

type ExportCheckContext = Readonly<{
  exportName: "chain" | "pipe";
  checkerCtx: O.Option<CheckerContext>;
  imports: FpTsImports;
}>;

const FP_TS_SOURCE_RE = /^fp-ts(?:\/|$)/;
const FP_TS_FILE_RE = /(?:^|\/)node_modules\/fp-ts\//;

const EXCLUDED_IDENT_PARENT_TYPES: ReadonlySet<string> = new Set([
  AST_NODE_TYPES.ImportSpecifier,
  AST_NODE_TYPES.ImportDefaultSpecifier,
  AST_NODE_TYPES.ImportNamespaceSpecifier,
  AST_NODE_TYPES.ExportSpecifier,
  AST_NODE_TYPES.TSTypeQuery,
  AST_NODE_TYPES.TSTypeReference,
  AST_NODE_TYPES.TSQualifiedName,
  AST_NODE_TYPES.TSPropertySignature,
]);

const isFpTsImportSource = (source: string) => FP_TS_SOURCE_RE.test(source);

const getDeclFileName = (decl: ts.Declaration) => decl.getSourceFile().fileName;

const isFpTsDeclaration = flow(
  getDeclFileName,
  normalizeFilePath,
  (filePath) => FP_TS_FILE_RE.test(filePath),
);

const resolveSymbol = (symbol: ts.Symbol, checker: ts.TypeChecker) =>
  symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

const hasFpTsDeclaration = (resolved: ts.Symbol) =>
  flow(
    (r: ts.Symbol) => r.getDeclarations(),
    O.fromNullable,
    O.exists(RA.some(isFpTsDeclaration)),
  )(resolved);

const isFpTsExportSymbol = (symbol: ts.Symbol, checker: ts.TypeChecker, exportName: string) => {
  const resolved = resolveSymbol(symbol, checker);
  return resolved.name === exportName && hasFpTsDeclaration(resolved);
};

const hasTypeInfo = (services: ParserServices): services is ParserServicesWithTypeInformation =>
  Boolean(services.program);

const toCheckerContext = (services: ParserServices) =>
  hasTypeInfo(services)
    ? O.some<CheckerContext>({ services, checker: services.program.getTypeChecker() })
    : O.none;

const lookupSymbol = (tsNode: ts.Node, checker: ts.TypeChecker) =>
  O.fromNullable(checker.getSymbolAtLocation(tsNode));

const isNodeFpTsExportByType = (node: TSESTree.Node, ctx: CheckerContext, exportName: string) =>
  flow(
    (n: TSESTree.Node) => ctx.services.esTreeNodeToTSNodeMap.get(n),
    O.fromNullable,
    O.flatMap((tsNode) => lookupSymbol(tsNode, ctx.checker)),
    O.exists((sym) => isFpTsExportSymbol(sym, ctx.checker, exportName)),
  )(node);

const isValueFpTsImport = (stmt: TSESTree.ProgramStatement): stmt is TSESTree.ImportDeclaration =>
  stmt.type === AST_NODE_TYPES.ImportDeclaration &&
  stmt.importKind === "value" &&
  isFpTsImportSource(stmt.source.value);

const getNamespaceImportName = (spec: TSESTree.ImportClause) =>
  spec.type === AST_NODE_TYPES.ImportNamespaceSpecifier ? O.some(spec.local.name) : O.none;

const getLocalExportImportName = (exportName: string) => (spec: TSESTree.ImportClause) =>
  spec.type === AST_NODE_TYPES.ImportSpecifier &&
  spec.importKind !== "type" &&
  spec.imported.type === AST_NODE_TYPES.Identifier &&
  spec.imported.name === exportName
    ? O.some(spec.local.name)
    : O.none;

const collectSpecifiers = (
  imports: ReadonlyArray<TSESTree.ImportDeclaration>,
  extract: (spec: TSESTree.ImportClause) => O.Option<string>,
) =>
  flow(
    RA.flatMap((decl: TSESTree.ImportDeclaration) => decl.specifiers),
    RA.filterMap(extract),
    (names) => new Set(names),
  )(imports);

const collectFpTsImports = (body: ReadonlyArray<TSESTree.ProgramStatement>, exportName: string) =>
  flow(
    RA.filter(isValueFpTsImport),
    (fpImports) => ({
      namespaces: collectSpecifiers(fpImports, getNamespaceImportName),
      locals: collectSpecifiers(fpImports, getLocalExportImportName(exportName)),
    }),
  )(body);

const isStaticExportMember = (
  node: TSESTree.MemberExpression,
  namespaces: ReadonlySet<string>,
  exportName: string,
) =>
  !node.computed &&
  node.object.type === AST_NODE_TYPES.Identifier &&
  namespaces.has(node.object.name) &&
  node.property.type === AST_NODE_TYPES.Identifier &&
  node.property.name === exportName;

const isNodeFpTsExportByAst = (
  node: TSESTree.Node,
  imports: FpTsImports,
  exportName: string,
) =>
  match(node)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => imports.locals.has(id.name))
    .with({ type: AST_NODE_TYPES.MemberExpression }, (mem) =>
      isStaticExportMember(mem, imports.namespaces, exportName),
    )
    .with(P._, () => false)
    .exhaustive();

const isNodeFpTsExport = (node: TSESTree.Node, ctx: ExportCheckContext) =>
  (O.isNone(ctx.checkerCtx) && isNodeFpTsExportByAst(node, ctx.imports, ctx.exportName)) ||
  O.exists((c: CheckerContext) => isNodeFpTsExportByType(node, c, ctx.exportName))(ctx.checkerCtx);

const isTypeQueryParent = (node: TSESTree.Node) =>
  node.parent?.type === AST_NODE_TYPES.TSTypeQuery;

const isDeclOrMemberKeyIdent = (node: TSESTree.Identifier, parent: TSESTree.Node) =>
  (parent.type === AST_NODE_TYPES.MemberExpression && !parent.computed && parent.property === node) ||
  (parent.type === AST_NODE_TYPES.Property && parent.key === node && !parent.shorthand) ||
  (parent.type === AST_NODE_TYPES.VariableDeclarator && parent.id === node) ||
  ((parent.type === AST_NODE_TYPES.FunctionDeclaration || parent.type === AST_NODE_TYPES.FunctionExpression) &&
    parent.id === node);

const isExcludedIdentifierParent = (node: TSESTree.Identifier) =>
  flow(
    (n: TSESTree.Identifier) => O.fromNullable(n.parent),
    O.exists((parent: TSESTree.Node) =>
      EXCLUDED_IDENT_PARENT_TYPES.has(parent.type) || isDeclOrMemberKeyIdent(node, parent),
    ),
  )(node);

const hasZeroReadRefs = (variable: TSESLint.Scope.Variable) =>
  RA.filter((ref: TSESLint.Scope.Reference) => ref.isRead())(variable.references).length === 0;

const hasNoReadReferences = (
  spec: TSESTree.ImportSpecifier,
  sourceCode: Readonly<TSESLint.SourceCode>,
) =>
  flow(
    (s: TSESTree.ImportSpecifier) => O.fromNullable(sourceCode.getDeclaredVariables(s)[0]),
    O.exists(hasZeroReadRefs),
  )(spec);

const isUnusedFpTsExportImport = (
  spec: TSESTree.ImportSpecifier,
  sourceCode: Readonly<TSESLint.SourceCode>,
  exportName: string,
) =>
  spec.importKind !== "type" &&
  spec.parent.type === AST_NODE_TYPES.ImportDeclaration &&
  spec.parent.importKind === "value" &&
  isFpTsImportSource(spec.parent.source.value) &&
  spec.imported.type === AST_NODE_TYPES.Identifier &&
  spec.imported.name === exportName &&
  hasNoReadReferences(spec, sourceCode);

const isFpTsExportReExport = (spec: TSESTree.ExportSpecifier, ctx: ExportCheckContext) =>
  spec.exportKind === "value" &&
  spec.parent.exportKind === "value" &&
  (spec.parent.source
    ? isFpTsImportSource(spec.parent.source.value) &&
      spec.local.type === AST_NODE_TYPES.Identifier &&
      spec.local.name === ctx.exportName
    : isNodeFpTsExport(spec.local, ctx));

const reportWhen = <N extends TSESTree.Node>(
  node: N,
  predicate: Pred.Predicate<N>,
  onMatch: (n: N) => void,
) => {
  flow(O.some<N>, O.filter(predicate), O.map(onMatch))(node);
};

const isMemberExportRef = (node: TSESTree.MemberExpression, ctx: ExportCheckContext) =>
  !isCalleeOfCallExpression(node) && !isTypeQueryParent(node) && isNodeFpTsExport(node, ctx);

const isIdentExportRef = (node: TSESTree.Identifier, ctx: ExportCheckContext) =>
  !isCalleeOfCallExpression(node) && !isExcludedIdentifierParent(node) && isNodeFpTsExport(node, ctx);

const buildListeners = (
  ctx: ExportCheckContext,
  sourceCode: Readonly<TSESLint.SourceCode>,
  report: (node: TSESTree.Node) => void,
) =>
  ({
    CallExpression: (n) => { reportWhen(n, (c) => isNodeFpTsExport(c.callee, ctx), report); },
    MemberExpression: (n) => { reportWhen(n, (m) => isMemberExportRef(m, ctx), report); },
    Identifier: (n) => { reportWhen(n, (id) => isIdentExportRef(id, ctx), report); },
    ImportSpecifier: (n) => {
      reportWhen(n, (s) => isUnusedFpTsExportImport(s, sourceCode, ctx.exportName), report);
    },
    ExportSpecifier: (n) => { reportWhen(n, (s) => isFpTsExportReExport(s, ctx), report); },
  }) satisfies TSESLint.RuleListener;

export const createBannedFpTsExportListeners = <MessageIds extends string>(
  exportName: "chain" | "pipe",
  messageId: MessageIds,
) => (context: Readonly<TSESLint.RuleContext<MessageIds, []>>) =>
  buildListeners(
    {
      exportName,
      checkerCtx: toCheckerContext(ESLintUtils.getParserServices(context, true)),
      imports: collectFpTsImports(context.sourceCode.ast.body, exportName),
    },
    context.sourceCode,
    (node) => { context.report({ node, messageId }); },
  );
