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
import { flow, pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../utils/create-rule.js";
import { normalizeFilePath } from "../utils/program-cache.js";
import { isCalleeOfCallExpression } from "../utils/type-helpers.js";

type MessageIds = "noFpTsChain";

type FpTsImports = Readonly<{
  namespaces: ReadonlySet<string>;
  chainLocals: ReadonlySet<string>;
}>;

type CheckerContext = Readonly<{
  services: ParserServicesWithTypeInformation;
  checker: ts.TypeChecker;
}>;

type ChainCheckContext = Readonly<{
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
  pipe(
    O.fromNullable(resolved.getDeclarations()),
    O.exists(RA.some(isFpTsDeclaration)),
  );

const isFpTsChainSymbol = (symbol: ts.Symbol, checker: ts.TypeChecker) =>
  pipe(
    resolveSymbol(symbol, checker),
    (resolved) => resolved.name === "chain" && hasFpTsDeclaration(resolved),
  );

const hasTypeInfo = (services: ParserServices): services is ParserServicesWithTypeInformation =>
  Boolean(services.program);

const toCheckerContext = (services: ParserServices) =>
  hasTypeInfo(services)
    ? O.some<CheckerContext>({ services, checker: services.program.getTypeChecker() })
    : O.none;

const lookupSymbol = (tsNode: ts.Node, checker: ts.TypeChecker) =>
  O.fromNullable(checker.getSymbolAtLocation(tsNode));

const isNodeFpTsChainByType = (node: TSESTree.Node, ctx: CheckerContext) =>
  pipe(
    O.fromNullable(ctx.services.esTreeNodeToTSNodeMap.get(node)),
    O.flatMap((tsNode) => lookupSymbol(tsNode, ctx.checker)),
    O.exists((sym) => isFpTsChainSymbol(sym, ctx.checker)),
  );

const isValueFpTsImport = (stmt: TSESTree.ProgramStatement): stmt is TSESTree.ImportDeclaration =>
  stmt.type === AST_NODE_TYPES.ImportDeclaration &&
  stmt.importKind === "value" &&
  isFpTsImportSource(stmt.source.value);

const getNamespaceImportName = (spec: TSESTree.ImportClause) =>
  spec.type === AST_NODE_TYPES.ImportNamespaceSpecifier ? O.some(spec.local.name) : O.none;

const getChainLocalImportName = (spec: TSESTree.ImportClause) =>
  spec.type === AST_NODE_TYPES.ImportSpecifier &&
  spec.importKind !== "type" &&
  spec.imported.type === AST_NODE_TYPES.Identifier &&
  spec.imported.name === "chain"
    ? O.some(spec.local.name)
    : O.none;

const collectSpecifiers = (
  imports: ReadonlyArray<TSESTree.ImportDeclaration>,
  extract: (spec: TSESTree.ImportClause) => O.Option<string>,
) =>
  pipe(
    imports,
    RA.flatMap((decl) => decl.specifiers),
    RA.filterMap(extract),
    (names) => new Set(names),
  );

const collectFpTsImports = (body: ReadonlyArray<TSESTree.ProgramStatement>) =>
  pipe(body, RA.filter(isValueFpTsImport), (fpImports) => ({
    namespaces: collectSpecifiers(fpImports, getNamespaceImportName),
    chainLocals: collectSpecifiers(fpImports, getChainLocalImportName),
  }));

const isStaticChainMember = (node: TSESTree.MemberExpression, namespaces: ReadonlySet<string>) =>
  !node.computed &&
  node.object.type === AST_NODE_TYPES.Identifier &&
  namespaces.has(node.object.name) &&
  node.property.type === AST_NODE_TYPES.Identifier &&
  node.property.name === "chain";

const isNodeFpTsChainByAst = (node: TSESTree.Node, imports: FpTsImports) =>
  match(node)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => imports.chainLocals.has(id.name))
    .with({ type: AST_NODE_TYPES.MemberExpression }, (mem) => isStaticChainMember(mem, imports.namespaces))
    .with(P._, () => false)
    .exhaustive();

const isNodeFpTsChain = (node: TSESTree.Node, ctx: ChainCheckContext) =>
  (O.isNone(ctx.checkerCtx) && isNodeFpTsChainByAst(node, ctx.imports)) ||
  pipe(ctx.checkerCtx, O.exists((c) => isNodeFpTsChainByType(node, c)));

const isTypeQueryParent = (node: TSESTree.Node) =>
  node.parent?.type === AST_NODE_TYPES.TSTypeQuery;

const isDeclOrMemberKeyIdent = (node: TSESTree.Identifier, parent: TSESTree.Node) =>
  (parent.type === AST_NODE_TYPES.MemberExpression && !parent.computed && parent.property === node) ||
  (parent.type === AST_NODE_TYPES.Property && parent.key === node && !parent.shorthand) ||
  (parent.type === AST_NODE_TYPES.VariableDeclarator && parent.id === node) ||
  ((parent.type === AST_NODE_TYPES.FunctionDeclaration || parent.type === AST_NODE_TYPES.FunctionExpression) &&
    parent.id === node);

const isExcludedIdentifierParent = (node: TSESTree.Identifier) =>
  pipe(
    O.fromNullable(node.parent),
    O.exists((parent) => EXCLUDED_IDENT_PARENT_TYPES.has(parent.type) || isDeclOrMemberKeyIdent(node, parent)),
  );

const hasZeroReadRefs = (variable: TSESLint.Scope.Variable) =>
  pipe(variable.references, RA.filter((ref) => ref.isRead())).length === 0;

const hasNoReadReferences = (
  spec: TSESTree.ImportSpecifier,
  sourceCode: Readonly<TSESLint.SourceCode>,
) =>
  pipe(
    O.fromNullable(sourceCode.getDeclaredVariables(spec)[0]),
    O.exists(hasZeroReadRefs),
  );

const isUnusedFpTsChainImport = (
  spec: TSESTree.ImportSpecifier,
  sourceCode: Readonly<TSESLint.SourceCode>,
) =>
  spec.importKind !== "type" &&
  spec.parent.type === AST_NODE_TYPES.ImportDeclaration &&
  spec.parent.importKind === "value" &&
  isFpTsImportSource(spec.parent.source.value) &&
  spec.imported.type === AST_NODE_TYPES.Identifier &&
  spec.imported.name === "chain" &&
  hasNoReadReferences(spec, sourceCode);

const isFpTsChainReExport = (spec: TSESTree.ExportSpecifier, ctx: ChainCheckContext) =>
  spec.exportKind === "value" &&
  spec.parent.exportKind === "value" &&
  (spec.parent.source
    ? isFpTsImportSource(spec.parent.source.value) &&
      spec.local.type === AST_NODE_TYPES.Identifier &&
      spec.local.name === "chain"
    : isNodeFpTsChain(spec.local, ctx));

const reportWhen = <N extends TSESTree.Node>(
  node: N,
  predicate: Pred.Predicate<N>,
  onMatch: (n: N) => void,
) => {
  pipe(O.some(node), O.filter(predicate), O.map(onMatch));
};

const isMemberChainRef = (node: TSESTree.MemberExpression, ctx: ChainCheckContext) =>
  !isCalleeOfCallExpression(node) && !isTypeQueryParent(node) && isNodeFpTsChain(node, ctx);

const isIdentChainRef = (node: TSESTree.Identifier, ctx: ChainCheckContext) =>
  !isCalleeOfCallExpression(node) && !isExcludedIdentifierParent(node) && isNodeFpTsChain(node, ctx);

const buildListeners = (
  ctx: ChainCheckContext,
  sourceCode: Readonly<TSESLint.SourceCode>,
  report: (node: TSESTree.Node) => void,
) =>
  ({
    CallExpression: (n) => { reportWhen(n, (c) => isNodeFpTsChain(c.callee, ctx), report); },
    MemberExpression: (n) => { reportWhen(n, (m) => isMemberChainRef(m, ctx), report); },
    Identifier: (n) => { reportWhen(n, (id) => isIdentChainRef(id, ctx), report); },
    ImportSpecifier: (n) => { reportWhen(n, (s) => isUnusedFpTsChainImport(s, sourceCode), report); },
    ExportSpecifier: (n) => { reportWhen(n, (s) => isFpTsChainReExport(s, ctx), report); },
  }) satisfies TSESLint.RuleListener;

const createChainListeners = (context: Readonly<TSESLint.RuleContext<MessageIds, []>>) =>
  buildListeners(
    {
      checkerCtx: toCheckerContext(ESLintUtils.getParserServices(context, true)),
      imports: collectFpTsImports(context.sourceCode.ast.body),
    },
    context.sourceCode,
    (node) => { context.report({ node, messageId: "noFpTsChain" }); },
  );

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
  create: createChainListeners,
});
