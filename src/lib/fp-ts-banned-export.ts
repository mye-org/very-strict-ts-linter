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
import { isCalleeOfCallExpression } from "./call-callee.js";
import { normalizeFilePath } from "./source-paths.js";

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

const resolveDeclFileName = (decl: ts.Declaration) => decl.getSourceFile().fileName;

const isFpTsFilePath = (filePath: string) => FP_TS_FILE_RE.test(filePath);

const isFpTsDeclaration = flow(resolveDeclFileName, normalizeFilePath, isFpTsFilePath);

const resolveSymbol = (symbol: ts.Symbol, checker: ts.TypeChecker) =>
  symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

const hasFpTsDeclaration = flow(
  (r: ts.Symbol) => r.getDeclarations(),
  O.fromNullable,
  O.exists(RA.some(isFpTsDeclaration)),
);

type SymbolCheckInput = Readonly<
  Record<"targetName", string> & {
    readonly targetSymbol: ts.Symbol;
    readonly checker: ts.TypeChecker;
  }
>;

const isFpTsExportSymbol = ({ targetSymbol, checker, targetName }: SymbolCheckInput) => {
  const resolved = resolveSymbol(targetSymbol, checker);
  return resolved.name === targetName && hasFpTsDeclaration(resolved);
};

const hasTypeProgram = (services: ParserServices): services is ParserServicesWithTypeInformation =>
  Boolean(services.program);

const toCheckerContext = (services: ParserServices) =>
  hasTypeProgram(services)
    ? O.some<CheckerContext>({ services, checker: services.program.getTypeChecker() })
    : O.none;

const lookupTsSymbol = (node: TSESTree.Node, ctx: CheckerContext) =>
  O.fromNullable(ctx.services.esTreeNodeToTSNodeMap.get(node));

const lookupSymbolAtTsNode = (ctx: CheckerContext) =>
  flow((tsNode: ts.Node) => ctx.checker.getSymbolAtLocation(tsNode), O.fromNullable);

const resolveSymbolForNode = (node: TSESTree.Node, ctx: CheckerContext) =>
  O.flatMap(lookupSymbolAtTsNode(ctx))(lookupTsSymbol(node, ctx));

const isNodeFpTsExportByType = (node: TSESTree.Node, ctx: CheckerContext, exportName: string) =>
  O.exists((targetSymbol: ts.Symbol) =>
    isFpTsExportSymbol({ targetSymbol, checker: ctx.checker, targetName: exportName }),
  )(resolveSymbolForNode(node, ctx));

const isValueFpTsImport = (node: TSESTree.Node): node is TSESTree.ImportDeclaration =>
  node.type === AST_NODE_TYPES.ImportDeclaration &&
  node.importKind === "value" &&
  isFpTsImportSource(node.source.value);

const resolveNamespaceImportName = (spec: TSESTree.ImportClause) =>
  spec.type === AST_NODE_TYPES.ImportNamespaceSpecifier ? O.some(spec.local.name) : O.none;

const resolveLocalExportImportName = (exportName: string) => (spec: TSESTree.ImportClause) =>
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
      namespaces: collectSpecifiers(fpImports, resolveNamespaceImportName),
      locals: collectSpecifiers(fpImports, resolveLocalExportImportName(exportName)),
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
  (parent.type === AST_NODE_TYPES.Property && parent.key === node) ||
  (parent.type === AST_NODE_TYPES.VariableDeclarator && parent.id === node) ||
  ((parent.type === AST_NODE_TYPES.FunctionDeclaration || parent.type === AST_NODE_TYPES.FunctionExpression) &&
    parent.id === node);

const isExcludedParentNode = (node: TSESTree.Identifier, parent: TSESTree.Node) =>
  EXCLUDED_IDENT_PARENT_TYPES.has(parent.type) || isDeclOrMemberKeyIdent(node, parent);

const isExcludedIdentifierParent = (node: TSESTree.Identifier) =>
  flow(
    (id: TSESTree.Identifier) => id.parent,
    O.fromNullable,
    O.exists((parent: TSESTree.Node) => isExcludedParentNode(node, parent)),
  )(node);

const hasZeroReadRefs = (variable: TSESLint.Scope.Variable) =>
  RA.filter((ref: TSESLint.Scope.Reference) => ref.isRead())(variable.references).length === 0;

const hasNoReadReferences = (
  spec: TSESTree.ImportSpecifier,
  sourceCode: Readonly<TSESLint.SourceCode>,
) => O.exists(hasZeroReadRefs)(O.fromNullable(sourceCode.getDeclaredVariables(spec)[0]));

const isMatchingImportedIdent = (spec: TSESTree.ImportSpecifier, targetName: string) =>
  spec.importKind !== "type" &&
  spec.imported.type === AST_NODE_TYPES.Identifier &&
  spec.imported.name === targetName;

const isUnusedFpTsExportImport = (
  spec: TSESTree.ImportSpecifier,
  sourceCode: Readonly<TSESLint.SourceCode>,
  ctx: ExportCheckContext,
) =>
  isMatchingImportedIdent(spec, ctx.exportName) &&
  isValueFpTsImport(spec.parent) &&
  hasNoReadReferences(spec, sourceCode);

const isMatchingReExportSource = (
  source: TSESTree.StringLiteral,
  spec: TSESTree.ExportSpecifier,
  targetName: "chain" | "pipe",
) =>
  isFpTsImportSource(source.value) &&
  spec.local.type === AST_NODE_TYPES.Identifier &&
  spec.local.name === targetName;

const resolveParentSource = (spec: TSESTree.ExportSpecifier) => spec.parent.source;

const isSourceExportMatch = (spec: TSESTree.ExportSpecifier, ctx: ExportCheckContext) => {
  const source = resolveParentSource(spec);
  return source
    ? isMatchingReExportSource(source, spec, ctx.exportName)
    : isNodeFpTsExport(spec.local, ctx);
};

const isFpTsExportReExport = (spec: TSESTree.ExportSpecifier, ctx: ExportCheckContext) =>
  spec.exportKind === "value" &&
  spec.parent.exportKind === "value" &&
  isSourceExportMatch(spec, ctx);

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
      reportWhen(n, (s) => isUnusedFpTsExportImport(s, sourceCode, ctx), report);
    },
    ExportSpecifier: (n) => { reportWhen(n, (s) => isFpTsExportReExport(s, ctx), report); },
  }) satisfies TSESLint.RuleListener;

const extractProgramStatements = (sourceCode: Readonly<TSESLint.SourceCode>) =>
  sourceCode.ast.body;

export const buildBannedFpTsExportListeners = <MessageIds extends string>(
  exportName: "chain" | "pipe",
  messageId: MessageIds,
) => (context: Readonly<TSESLint.RuleContext<MessageIds, []>>) =>
  buildListeners(
    {
      exportName,
      checkerCtx: toCheckerContext(ESLintUtils.getParserServices(context, true)),
      imports: collectFpTsImports(extractProgramStatements(context.sourceCode), exportName),
    },
    context.sourceCode,
    (node) => { context.report({ node, messageId }); },
  );
