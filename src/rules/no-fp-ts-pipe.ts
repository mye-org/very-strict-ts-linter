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
import { isCalleeOfCallExpression } from "../lib/call-callee.js";
import { createRule } from "../lib/rule-factory.js";
import { normalizeFilePath } from "../lib/source-paths.js";

type MessageIds = "noFpTsPipe" | "immediatelyInvokedFlow";

type FpTsImports = Readonly<{
  namespaces: ReadonlySet<string>;
  locals: ReadonlySet<string>;
}>;

type CheckerContext = Readonly<{
  services: ParserServicesWithTypeInformation;
  checker: ts.TypeChecker;
}>;

type ExportContext = Readonly<{
  targetExport: "pipe" | "flow";
  checkerCtx: O.Option<CheckerContext>;
  fpTsImports: FpTsImports;
}>;

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

const isFpTsImportSource = (source: string) =>
  source === "fp-ts" || source.startsWith("fp-ts/");

const resolveDeclFileName = (decl: ts.Declaration) => decl.getSourceFile().fileName;

const isFpTsFilePath = (filePath: string) =>
  filePath.includes("/node_modules/fp-ts/") || filePath.startsWith("node_modules/fp-ts/");

const isFpTsDeclaration = flow(resolveDeclFileName, normalizeFilePath, isFpTsFilePath);

const resolveSymbol = (symbol: ts.Symbol, checker: ts.TypeChecker) =>
  symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

const hasFpTsDeclaration = flow(
  (sym: ts.Symbol) => sym.getDeclarations(),
  O.fromNullable,
  O.exists(RA.some(isFpTsDeclaration)),
);

const isFpTsExportSymbol = (targetSymbol: ts.Symbol, checker: ts.TypeChecker, targetName: string) => {
  const resolved = resolveSymbol(targetSymbol, checker);
  return match({ nameMatches: resolved.name === targetName, isFpTs: hasFpTsDeclaration(resolved) })
    .with({ nameMatches: true, isFpTs: true }, () => true)
    .otherwise(() => false);
};

const hasTypeProgram = (services: ParserServices): services is ParserServicesWithTypeInformation =>
  Boolean(services.program);

const toCheckerContext = (services: ParserServices) =>
  hasTypeProgram(services)
    ? O.some<CheckerContext>({ services, checker: services.program.getTypeChecker() })
    : O.none;

const lookupTsNode = (node: TSESTree.Node, ctx: CheckerContext) =>
  O.fromNullable(ctx.services.esTreeNodeToTSNodeMap.get(node));

const lookupTsSymbol = (ctx: CheckerContext) =>
  flow((tsNode: ts.Node) => ctx.checker.getSymbolAtLocation(tsNode), O.fromNullable);

const resolveSymbolForNode = (node: TSESTree.Node, ctx: CheckerContext) =>
  O.flatMap(lookupTsSymbol(ctx))(lookupTsNode(node, ctx));

const isNodeFpTsExportByType = (node: TSESTree.Node, ctx: CheckerContext, targetExport: string) =>
  O.exists((targetSymbol: ts.Symbol) =>
    isFpTsExportSymbol(targetSymbol, ctx.checker, targetExport),
  )(resolveSymbolForNode(node, ctx));

const isValueImportDecl = (node: TSESTree.Node): node is TSESTree.ImportDeclaration =>
  node.type === AST_NODE_TYPES.ImportDeclaration && node.importKind === "value";

const isValueFpTsImport = (node: TSESTree.Node): node is TSESTree.ImportDeclaration =>
  isValueImportDecl(node) && isFpTsImportSource(node.source.value);

const resolveNamespaceImportName = (spec: TSESTree.ImportClause) =>
  spec.type === AST_NODE_TYPES.ImportNamespaceSpecifier ? O.some(spec.local.name) : O.none;

const isValueImportSpecifier = (spec: TSESTree.ImportClause): spec is TSESTree.ImportSpecifier =>
  spec.type === AST_NODE_TYPES.ImportSpecifier && spec.importKind !== "type";

const isMatchingExportedIdentName = (
  imported: TSESTree.Identifier | TSESTree.StringLiteral,
  targetExport: string,
) => imported.type === AST_NODE_TYPES.Identifier && imported.name === targetExport;

const resolveLocalExportImportName = (targetExport: string) => (spec: TSESTree.ImportClause) =>
  isValueImportSpecifier(spec) && isMatchingExportedIdentName(spec.imported, targetExport)
    ? O.some(spec.local.name)
    : O.none;

const collectSpecifiers = (extract: (spec: TSESTree.ImportClause) => O.Option<string>) =>
  flow(
    RA.flatMap((decl: TSESTree.ImportDeclaration) => decl.specifiers),
    RA.filterMap(extract),
    (names) => new Set(names),
  );

const collectFpTsImports = (
  statements: ReadonlyArray<TSESTree.ProgramStatement>,
  targetExport: string,
) => {
  const fpImports = RA.filter(isValueFpTsImport)(statements);
  return {
    namespaces: collectSpecifiers(resolveNamespaceImportName)(fpImports),
    locals: collectSpecifiers(resolveLocalExportImportName(targetExport))(fpImports),
  };
};

const hasNamespaceObject = (node: TSESTree.MemberExpression, namespaces: ReadonlySet<string>) =>
  !node.computed &&
  node.object.type === AST_NODE_TYPES.Identifier &&
  namespaces.has(node.object.name);

const hasExportProperty = (node: TSESTree.MemberExpression, targetExport: string) =>
  node.property.type === AST_NODE_TYPES.Identifier && node.property.name === targetExport;

const isStaticExportMember = (
  node: TSESTree.MemberExpression,
  namespaces: ReadonlySet<string>,
  targetExport: string,
) => hasNamespaceObject(node, namespaces) && hasExportProperty(node, targetExport);

const isNodeFpTsExportByAst = (
  node: TSESTree.Node,
  fpTsImports: FpTsImports,
  targetExport: string,
) =>
  match(node)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => fpTsImports.locals.has(id.name))
    .with({ type: AST_NODE_TYPES.MemberExpression }, (mem) =>
      isStaticExportMember(mem, fpTsImports.namespaces, targetExport),
    )
    .with(P._, () => false)
    .exhaustive();

const isNodeFpTsExport = (node: TSESTree.Node, ctx: ExportContext) =>
  match(ctx.checkerCtx)
    .with({ _tag: "None" }, () => isNodeFpTsExportByAst(node, ctx.fpTsImports, ctx.targetExport))
    .with({ _tag: "Some" }, ({ value }) => isNodeFpTsExportByType(node, value, ctx.targetExport))
    .exhaustive();

const isTypeQueryParent = (node: TSESTree.Node) =>
  node.parent?.type === AST_NODE_TYPES.TSTypeQuery;

const isDeclOrMemberKeyIdent = (node: TSESTree.Identifier, parent: TSESTree.Node) =>
  match(parent)
    .with({ type: AST_NODE_TYPES.MemberExpression, computed: false }, (m) => m.property === node)
    .with({ type: AST_NODE_TYPES.Property }, (p) => p.key === node)
    .with({ type: AST_NODE_TYPES.VariableDeclarator }, (v) => v.id === node)
    .with(
      { type: AST_NODE_TYPES.FunctionDeclaration },
      { type: AST_NODE_TYPES.FunctionExpression },
      (f) => f.id === node,
    )
    .with(P._, () => false)
    .exhaustive();

const isExcludedParentNode = (node: TSESTree.Identifier, parent: TSESTree.Node) =>
  match(EXCLUDED_IDENT_PARENT_TYPES.has(parent.type))
    .with(true, () => true)
    .with(false, () => isDeclOrMemberKeyIdent(node, parent))
    .exhaustive();

const isExcludedIdentifierParent = (node: TSESTree.Identifier) =>
  isExcludedParentNode(node, node.parent);

const hasZeroReadRefs = (variable: TSESLint.Scope.Variable) =>
  RA.filter((ref: TSESLint.Scope.Reference) => ref.isRead())(variable.references).length === 0;

const hasNoReadReferences = O.exists(hasZeroReadRefs);

const isMatchingImportedIdent = (spec: TSESTree.ImportSpecifier, targetExport: string) =>
  match(spec)
    .with(
      {
        importKind: P.not("type"),
        imported: { type: AST_NODE_TYPES.Identifier, name: targetExport },
      },
      () => true,
    )
    .otherwise(() => false);

const isUnusedFpTsExportImport = (
  spec: TSESTree.ImportSpecifier,
  sourceCode: Readonly<TSESLint.SourceCode>,
  ctx: ExportContext,
) =>
  match({
    matchingIdent: isMatchingImportedIdent(spec, ctx.targetExport),
    valueFpTsImport: isValueFpTsImport(spec.parent),
    noReads: hasNoReadReferences(O.fromNullable(sourceCode.getDeclaredVariables(spec)[0])),
  })
    .with({ matchingIdent: true, valueFpTsImport: true, noReads: true }, () => true)
    .otherwise(() => false);

const isMatchingReExportSource = (
  source: TSESTree.StringLiteral,
  spec: TSESTree.ExportSpecifier,
  targetExport: string,
) =>
  match({
    isFpTs: isFpTsImportSource(source.value),
    local: spec.local,
  })
    .with(
      {
        isFpTs: true,
        local: { type: AST_NODE_TYPES.Identifier, name: targetExport },
      },
      () => true,
    )
    .otherwise(() => false);

const isSourceExportMatch = (spec: TSESTree.ExportSpecifier, ctx: ExportContext) =>
  spec.parent.source
    ? isMatchingReExportSource(spec.parent.source, spec, ctx.targetExport)
    : isNodeFpTsExport(spec.local, ctx);

const isFpTsExportReExport = (spec: TSESTree.ExportSpecifier, ctx: ExportContext) =>
  match({
    specKind: spec.exportKind,
    parentKind: spec.parent.exportKind,
  })
    .with({ specKind: "value", parentKind: "value" }, () => isSourceExportMatch(spec, ctx))
    .otherwise(() => false);

const isMemberExportRef = (node: TSESTree.MemberExpression, ctx: ExportContext) =>
  !isCalleeOfCallExpression(node) && !isTypeQueryParent(node) && isNodeFpTsExport(node, ctx);

const isIdentExportRef = (node: TSESTree.Identifier, ctx: ExportContext) =>
  !isCalleeOfCallExpression(node) && !isExcludedIdentifierParent(node) && isNodeFpTsExport(node, ctx);

const isImmediatelyInvokedFlow = (node: TSESTree.CallExpression, flowCtx: ExportContext) =>
  node.callee.type === AST_NODE_TYPES.CallExpression &&
  isNodeFpTsExport(node.callee.callee, flowCtx);

const reportWhen = <N extends TSESTree.Node>(
  node: N,
  predicate: Pred.Predicate<N>,
  onMatch: (n: N) => void,
) => {
  match(predicate(node))
    .with(true, () => { onMatch(node); })
    .with(false, () => {})
    .exhaustive();
};

const buildExportContext = (
  exportKind: "pipe" | "flow",
  typeChecker: O.Option<CheckerContext>,
  statements: ReadonlyArray<TSESTree.ProgramStatement>,
) =>
  ({
    targetExport: exportKind,
    checkerCtx: typeChecker,
    fpTsImports: collectFpTsImports(statements, exportKind),
  }) satisfies ExportContext;

const extractProgramBody = (sourceCode: Readonly<TSESLint.SourceCode>) => sourceCode.ast.body;

const buildListeners = (
  pipeCtx: ExportContext,
  flowCtx: ExportContext,
  sourceCode: Readonly<TSESLint.SourceCode>,
  report: (node: TSESTree.Node, messageId: MessageIds) => void,
) =>
  ({
    CallExpression: (node) => {
      reportWhen(node, (c) => isNodeFpTsExport(c.callee, pipeCtx), (n) => { report(n, "noFpTsPipe"); });
      reportWhen(node, (c) => isImmediatelyInvokedFlow(c, flowCtx), (n) => { report(n, "immediatelyInvokedFlow"); });
    },
    MemberExpression: (node) => {
      reportWhen(node, (m) => isMemberExportRef(m, pipeCtx), (n) => { report(n, "noFpTsPipe"); });
    },
    Identifier: (node) => {
      reportWhen(node, (id) => isIdentExportRef(id, pipeCtx), (n) => { report(n, "noFpTsPipe"); });
    },
    ImportSpecifier: (node) => {
      reportWhen(node, (s) => isUnusedFpTsExportImport(s, sourceCode, pipeCtx), (n) => { report(n, "noFpTsPipe"); });
    },
    ExportSpecifier: (node) => {
      reportWhen(node, (s) => isFpTsExportReExport(s, pipeCtx), (n) => { report(n, "noFpTsPipe"); });
    },
  }) satisfies TSESLint.RuleListener;

export const noFpTsPipe = createRule<[], MessageIds>({
  name: "no-fp-ts-pipe",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow `fp-ts` `pipe` and immediately invoked `flow(...)(x)`; prefer `flow(...)` composition refactored upward along the call chain.",
    },
    messages: {
      noFpTsPipe:
        "Avoid `fp-ts` `pipe`. Use `flow(...)` composition instead.",
      immediatelyInvokedFlow:
        "Avoid immediately invoked `flow(...)(x)`. Continue composing functions with `flow(...)` and refactor upward along the call chain.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const checkerCtx = toCheckerContext(ESLintUtils.getParserServices(context, true));
    const body = extractProgramBody(context.sourceCode);
    return buildListeners(
      buildExportContext("pipe", checkerCtx, body),
      buildExportContext("flow", checkerCtx, body),
      context.sourceCode,
      (node, messageId) => { context.report({ node, messageId }); },
    );
  },
});
