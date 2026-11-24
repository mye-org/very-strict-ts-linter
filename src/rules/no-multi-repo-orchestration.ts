import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as S from "fp-ts/lib/string.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { collectEstreeChildNodes } from "../lib/estree-children.js";
import { isEsTreeFunctionNode } from "../lib/estree-function-nodes.js";
import { createRule } from "../lib/rule-factory.js";
import { resolveTsTypeName } from "../lib/ts-type-name.js";

type Options = [Readonly<{ readonly persistenceMethods: ReadonlyArray<string> }>];
type MessageIds = "multiRepoOrchestration";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

const EMPTY_CALL_EXPRS: ReadonlyArray<TSESTree.CallExpression> = [];

const DEFAULT_PERSISTENCE_METHODS = ["save", "update", "insert", "upsert", "delete", "remove", "persist"];
const REPO_SUFFIXES = ["repo", "repository", "store", "dao"];
const STANDALONE_PERSIST_PREFIXES = ["save", "update", "insert", "upsert", "delete", "persist"];

const isRepoLikeName = (name: string) =>
  RA.some((suffix: string) => name.toLowerCase().endsWith(suffix))(REPO_SUFFIXES);

const extractStandaloneEntity = (name: string) =>
  RA.findFirstMap((prefix: string) => {
    const ch = name.charAt(prefix.length);
    return name.startsWith(prefix) && ch >= "A" && ch <= "Z"
      ? O.some(`${name.slice(prefix.length)}Repository`)
      : O.none;
  })(STANDALONE_PERSIST_PREFIXES);

const collectCallsInBody = (
  node: TSESTree.Node,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST scan
): ReadonlyArray<TSESTree.CallExpression> =>
  isEsTreeFunctionNode(node)
    ? []
    : [
        ...(node.type === AST_NODE_TYPES.CallExpression ? [node] : []),
        ...RA.flatMap((child: TSESTree.Node) => collectCallsInBody(child, visitorKeys))(
          collectEstreeChildNodes(node, visitorKeys),
        ),
      ];

const extractMemberPropName = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.MemberExpression && expr.property.type === AST_NODE_TYPES.Identifier
    ? O.some(expr.property.name)
    : O.none;

const extractReceiverName = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.Identifier ? O.some(expr.name) : extractMemberPropName(expr);

const resolveExprTsType = (
  expr: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
) =>
  services.program.getTypeChecker().getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(expr));

const resolveExprRepoType = (
  expr: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
) => resolveTsTypeName(resolveExprTsType(expr, services));

const hasRepoType = (
  expr: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
) => O.exists(isRepoLikeName)(resolveExprRepoType(expr, services));

const extractMemberRepoKey = (
  methodSet: ReadonlySet<string>,
  services: ParserServicesWithTypeInformation,
) => (member: TSESTree.MemberExpression) =>
  member.property.type === AST_NODE_TYPES.Identifier && methodSet.has(member.property.name)
    ? O.filter((name: string) => isRepoLikeName(name) || hasRepoType(member.object, services))(
        extractReceiverName(member.object),
      )
    : O.none;

const extractIdentRepoKey = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.Identifier ? extractStandaloneEntity(callee.name) : O.none;

const extractRepoKey = (
  methodSet: ReadonlySet<string>,
  services: ParserServicesWithTypeInformation,
) => (call: TSESTree.CallExpression) =>
  call.callee.type === AST_NODE_TYPES.MemberExpression
    ? extractMemberRepoKey(methodSet, services)(call.callee)
    : extractIdentRepoKey(call.callee);

type MultiRepoContext = Readonly<{
  readonly methodSet: ReadonlySet<string>;
  readonly visitorKeys: TSESLint.SourceCode["visitorKeys"];
}>;

type MultiRepoEnv = Readonly<{
  readonly repoCtx: MultiRepoContext;
  readonly services: ParserServicesWithTypeInformation;
  readonly report: (d: TSESLint.ReportDescriptor<MessageIds>) => void;
}>;

const collectBlockBodyCalls = (
  fn: FunctionNode,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) =>
  fn.body.type === AST_NODE_TYPES.BlockStatement
    ? RA.flatMap((s: TSESTree.Statement) => collectCallsInBody(s, visitorKeys))(fn.body.body)
    : EMPTY_CALL_EXPRS;

const extractBodyRepoKeys = (
  repoCtx: MultiRepoContext,
  services: ParserServicesWithTypeInformation,
) =>
  flow(
    (fn: FunctionNode) => collectBlockBodyCalls(fn, repoCtx.visitorKeys),
    RA.filterMap<TSESTree.CallExpression, string>(extractRepoKey(repoCtx.methodSet, services)),
  );

const collectDistinctRepos = (
  repoCtx: MultiRepoContext,
  services: ParserServicesWithTypeInformation,
) => flow(extractBodyRepoKeys(repoCtx, services), RA.uniq(S.Eq));

const formatMultiRepoPayload = (repos: ReadonlyArray<string>) => ({
  count: String(repos.length),
  repos: repos.join(", "),
});

const checkFunctionRepos = (env: MultiRepoEnv) => (fn: FunctionNode) => {
  const repos = collectDistinctRepos(env.repoCtx, env.services)(fn);
  match(repos.length >= 2)
    .with(true, () => {
      env.report({ node: fn, messageId: "multiRepoOrchestration", data: formatMultiRepoPayload(repos) });
    })
    .with(false, () => {})
    .exhaustive();
};

const buildMultiRepoListeners = (env: MultiRepoEnv) => {
  const check = checkFunctionRepos(env);
  return {
    FunctionDeclaration: check,
    FunctionExpression: check,
    ArrowFunctionExpression: check,
  };
};

export const noMultiRepoOrchestration = createRule<Options, MessageIds>({
  name: "no-multi-repo-orchestration",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag functions that persist or update 2+ distinct repositories in the same block; suggests merging into a single Aggregate or decoupling with Domain Events.",
    },
    messages: {
      multiRepoOrchestration:
        "Function orchestrates writes across {{count}} distinct repositories ({{repos}}). Merge into one Aggregate or decouple via Domain Events + Process Manager.",
    },
    schema: [
      {
        type: "object",
        properties: {
          persistenceMethods: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ persistenceMethods: DEFAULT_PERSISTENCE_METHODS }],
  },
  create: (context, [options]) =>
    buildMultiRepoListeners({
      repoCtx: {
        methodSet: new Set(options.persistenceMethods),
        visitorKeys: context.sourceCode.visitorKeys,
      },
      services: ESLintUtils.getParserServices(context),
      report: (d) => { context.report(d); },
    }),
});
