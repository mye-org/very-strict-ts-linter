import { createRule } from "../lib/rule-factory.js";

type MessageIds = "noFpTsChain";

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
import { normalizeFilePath } from "../lib/source-paths.js";

type FpTsImports = Readonly<{
  namespaces: ReadonlySet<string>;
  locals: ReadonlySet<string>;
}>;

type CheckerContext = Readonly<{
  services: ParserServicesWithTypeInformation;
  checker: ts.TypeChecker;
}>;

type BannedExportName = "chain" | "pipe";

type ExportCheckContext = Readonly<{
  targetExport: BannedExportName;
  typeCheckerCtx: O.Option<CheckerContext>;
  imports: FpTsImports;
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

const isMatchingFpTsSymbol = (resolved: ts.Symbol, targetName: string) =>
  resolved.name === targetName && hasFpTsDeclaration(resolved);

const isFpTsExportSymbol = ({ targetSymbol, checker, targetName }: SymbolCheckInput) =>
  isMatchingFpTsSymbol(resolveSymbol(targetSymbol, checker), targetName);

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

const isNodeFpTsExportByType = (
  node: TSESTree.Node,
  opts: Readonly<{ readonly checkerCtx: CheckerContext; readonly targetName: BannedExportName }>,
) =>
  O.exists((targetSymbol: ts.Symbol) =>
    isFpTsExportSymbol({ targetSymbol, checker: opts.checkerCtx.checker, targetName: opts.targetName }),
  )(resolveSymbolForNode(node, opts.checkerCtx));

const isValueFpTsImport = (node: TSESTree.Node): node is TSESTree.ImportDeclaration =>
  node.type === AST_NODE_TYPES.ImportDeclaration &&
  node.importKind === "value" &&
  isFpTsImportSource(node.source.value);

const resolveNamespaceImportName = (spec: TSESTree.ImportClause) =>
  spec.type === AST_NODE_TYPES.ImportNamespaceSpecifier ? O.some(spec.local.name) : O.none;

const resolveLocalExportImportName =
  (targetName: BannedExportName) => (spec: TSESTree.ImportClause) =>
    match(spec)
      .with(
        {
          type: AST_NODE_TYPES.ImportSpecifier,
          imported: { type: AST_NODE_TYPES.Identifier, name: targetName },
        },
        (s) => (s.importKind !== "type" ? O.some(s.local.name) : O.none),
      )
      .with(P._, () => O.none)
      .exhaustive();

const collectSpecifiers = (extract: (spec: TSESTree.ImportClause) => O.Option<string>) =>
  flow(
    RA.flatMap((decl: TSESTree.ImportDeclaration) => decl.specifiers),
    RA.filterMap(extract),
    (names) => new Set(names),
  );

const collectFpTsImports = (
  sourceCode: Readonly<TSESLint.SourceCode>,
  targetName: BannedExportName,
) => {
  const fpImports = RA.filter(isValueFpTsImport)(sourceCode.ast.body);
  return {
    namespaces: collectSpecifiers(resolveNamespaceImportName)(fpImports),
    locals: collectSpecifiers(resolveLocalExportImportName(targetName))(fpImports),
  };
};

const isStaticExportMember = (
  node: TSESTree.MemberExpression,
  opts: Readonly<{ readonly namespaces: ReadonlySet<string>; readonly targetName: BannedExportName }>,
) =>
  match(node)
    .with(
      {
        computed: false,
        object: { type: AST_NODE_TYPES.Identifier },
        property: { type: AST_NODE_TYPES.Identifier, name: opts.targetName },
      },
      (m) => opts.namespaces.has(m.object.name),
    )
    .with(P._, () => false)
    .exhaustive();

const isNodeFpTsExportByAst = (node: TSESTree.Node, ctx: ExportCheckContext) =>
  match(node)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => ctx.imports.locals.has(id.name))
    .with({ type: AST_NODE_TYPES.MemberExpression }, (mem) =>
      isStaticExportMember(mem, { namespaces: ctx.imports.namespaces, targetName: ctx.targetExport }),
    )
    .with(P._, () => false)
    .exhaustive();

const isNodeFpTsExport = (node: TSESTree.Node, ctx: ExportCheckContext) =>
  match(ctx)
    .with({ typeCheckerCtx: { _tag: "None" } }, (matched) => isNodeFpTsExportByAst(node, matched))
    .with({ typeCheckerCtx: { _tag: "Some" } }, (matched) =>
      isNodeFpTsExportByType(node, { checkerCtx: matched.typeCheckerCtx.value, targetName: matched.targetExport }),
    )
    .exhaustive();

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
  isExcludedParentNode(node, node.parent);

const hasZeroReadRefs = (variable: TSESLint.Scope.Variable) =>
  RA.filter((ref: TSESLint.Scope.Reference) => ref.isRead())(variable.references).length === 0;

const hasNoReadReferences = O.exists(hasZeroReadRefs);

const isMatchingImportedIdent = (spec: TSESTree.ImportSpecifier, targetName: string) =>
  spec.importKind !== "type" &&
  spec.imported.type === AST_NODE_TYPES.Identifier &&
  spec.imported.name === targetName;

const isUnusedFpTsExportImport = (
  spec: TSESTree.ImportSpecifier,
  importCtx: Readonly<{ readonly sourceCode: Readonly<TSESLint.SourceCode>; readonly ctx: ExportCheckContext }>,
) =>
  isMatchingImportedIdent(spec, importCtx.ctx.targetExport) &&
  isValueFpTsImport(spec.parent) &&
  hasNoReadReferences(O.fromNullable(importCtx.sourceCode.getDeclaredVariables(spec)[0]));

const isMatchingReExportSource = (
  spec: TSESTree.ExportSpecifier,
  reExportCtx: Readonly<{ readonly source: TSESTree.StringLiteral; readonly targetName: BannedExportName }>,
) =>
  isFpTsImportSource(reExportCtx.source.value) &&
  spec.local.type === AST_NODE_TYPES.Identifier &&
  spec.local.name === reExportCtx.targetName;

const resolveParentSource = (spec: TSESTree.ExportSpecifier) => spec.parent.source;

const isSourceExportMatch = (spec: TSESTree.ExportSpecifier, ctx: ExportCheckContext) => {
  const source = resolveParentSource(spec);
  return source
    ? isMatchingReExportSource(spec, { source, targetName: ctx.targetExport })
    : isNodeFpTsExport(spec.local, ctx);
};

const isFpTsExportReExport = (spec: TSESTree.ExportSpecifier, ctx: ExportCheckContext) =>
  spec.exportKind === "value" &&
  spec.parent.exportKind === "value" &&
  isSourceExportMatch(spec, ctx);

const reportWhen = <N extends TSESTree.Node>(
  predicate: Pred.Predicate<N>,
  onMatch: (n: N) => void,
) => (node: N) => {
  O.map(onMatch)(O.fromPredicate(predicate)(node));
};

const isMemberExportRef = (node: TSESTree.MemberExpression, ctx: ExportCheckContext) =>
  !isCalleeOfCallExpression(node) && !isTypeQueryParent(node) && isNodeFpTsExport(node, ctx);

const isIdentExportRef = (node: TSESTree.Identifier, ctx: ExportCheckContext) =>
  !isCalleeOfCallExpression(node) && !isExcludedIdentifierParent(node) && isNodeFpTsExport(node, ctx);

const buildListeners = (
  ctx: ExportCheckContext,
  sourceCode: Readonly<TSESLint.SourceCode>,
) => (report: (node: TSESTree.Node) => void) =>
  ({
    CallExpression: reportWhen((c: TSESTree.CallExpression) => isNodeFpTsExport(c.callee, ctx), report),
    MemberExpression: reportWhen((m: TSESTree.MemberExpression) => isMemberExportRef(m, ctx), report),
    Identifier: reportWhen((id: TSESTree.Identifier) => isIdentExportRef(id, ctx), report),
    ImportSpecifier: reportWhen((s: TSESTree.ImportSpecifier) => isUnusedFpTsExportImport(s, { sourceCode, ctx }), report),
    ExportSpecifier: reportWhen((s: TSESTree.ExportSpecifier) => isFpTsExportReExport(s, ctx), report),
  }) satisfies TSESLint.RuleListener;

const buildBannedFpTsExportListeners = <MessageIds extends string>(
  targetExport: BannedExportName,
  messageId: MessageIds,
) =>
(context: Readonly<TSESLint.RuleContext<MessageIds, []>>) =>
  buildListeners(
    {
      targetExport,
      typeCheckerCtx: toCheckerContext(ESLintUtils.getParserServices(context, true)),
      imports: collectFpTsImports(context.sourceCode, targetExport),
    },
    context.sourceCode,
  )((node) => { context.report({ node, messageId }); });

export const noFpTsChain = createRule<[], MessageIds>({
  name: "no-fp-ts-chain",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow `fp-ts` `chain` function; use `flatMap` or `Do`-notation (`Do`, `bind`, `apS`) instead.",
    },
    messages: {
      noFpTsChain:
        "Avoid `fp-ts` `chain`. Use `flatMap` or `Do`-notation (`Do`, `bind`, `apS`) instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: buildBannedFpTsExportListeners("chain", "noFpTsChain"),
});
