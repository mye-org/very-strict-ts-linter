import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as S from "fp-ts/lib/string.js";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import { getEstreeChildNodes, getTsTypeName, isEsTreeFunctionNode } from "../utils/type-helpers.js";

type Options = [Readonly<{ readonly persistenceMethods: ReadonlyArray<string> }>];
type MessageIds = "multiRepoOrchestration";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

const DEFAULT_PERSISTENCE_METHODS = ["save", "update", "insert", "upsert", "delete", "remove", "persist"];
const REPO_SUFFIXES = ["repo", "repository", "store", "dao"];
const STANDALONE_PERSIST_PREFIXES = ["save", "update", "insert", "upsert", "delete", "persist"];

const isRepoLikeName = (name: string) =>
  pipe(REPO_SUFFIXES, RA.some((suffix) => name.toLowerCase().endsWith(suffix)));

const extractStandaloneEntity = (name: string) =>
  pipe(
    STANDALONE_PERSIST_PREFIXES,
    RA.findFirst((prefix) => {
      const ch = name.charAt(prefix.length);
      return name.startsWith(prefix) && ch >= "A" && ch <= "Z";
    }),
    O.map((prefix) => `${name.slice(prefix.length)}Repository`),
  );

const collectCallsInBody = (
  node: TSESTree.Node,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST scan
): ReadonlyArray<TSESTree.CallExpression> =>
  isEsTreeFunctionNode(node)
    ? []
    : [
        ...(node.type === AST_NODE_TYPES.CallExpression ? [node] : []),
        ...pipe(
          getEstreeChildNodes(node, visitorKeys),
          RA.flatMap((child) => collectCallsInBody(child, visitorKeys)),
        ),
      ];

const getMemberPropName = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.MemberExpression && expr.property.type === AST_NODE_TYPES.Identifier
    ? O.some(expr.property.name)
    : O.none;

const getReceiverName = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.Identifier ? O.some(expr.name) : getMemberPropName(expr);

const isRepoReceiver = (
  expr: TSESTree.Expression,
  receiverName: string,
  services: ParserServicesWithTypeInformation,
) =>
  isRepoLikeName(receiverName) ||
  pipe(
    services.program.getTypeChecker().getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(expr)),
    getTsTypeName,
    O.exists(isRepoLikeName),
  );

const extractMemberRepoKey = (
  member: TSESTree.MemberExpression,
  methodSet: ReadonlySet<string>,
  services: ParserServicesWithTypeInformation,
) =>
  member.property.type === AST_NODE_TYPES.Identifier && methodSet.has(member.property.name)
    ? pipe(getReceiverName(member.object), O.filter((name) => isRepoReceiver(member.object, name, services)))
    : O.none;

const extractIdentRepoKey = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.Identifier ? extractStandaloneEntity(callee.name) : O.none;

const extractRepoKey = (
  call: TSESTree.CallExpression,
  methodSet: ReadonlySet<string>,
  services: ParserServicesWithTypeInformation,
) =>
  call.callee.type === AST_NODE_TYPES.MemberExpression
    ? extractMemberRepoKey(call.callee, methodSet, services)
    : extractIdentRepoKey(call.callee);

type MultiRepoContext = Readonly<{
  readonly methodSet: ReadonlySet<string>;
  readonly visitorKeys: TSESLint.SourceCode["visitorKeys"];
}>;

const collectBlockBodyCalls = (
  body: FunctionNode["body"],
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) =>
  body.type === AST_NODE_TYPES.BlockStatement
    ? pipe(body.body, RA.flatMap((s) => collectCallsInBody(s, visitorKeys)))
    : ([] as ReadonlyArray<TSESTree.CallExpression>);

const collectDistinctRepos = (
  fn: FunctionNode,
  { methodSet, visitorKeys }: MultiRepoContext,
  services: ParserServicesWithTypeInformation,
) =>
  pipe(
    collectBlockBodyCalls(fn.body, visitorKeys),
    RA.filterMap((call) => extractRepoKey(call, methodSet, services)),
    RA.uniq(S.Eq),
  );

const checkFunctionRepos = (
  fn: FunctionNode,
  repoCtx: MultiRepoContext,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  const repos = collectDistinctRepos(fn, repoCtx, services);
  match(repos.length >= 2)
    .with(true, () => {
      report({ node: fn, messageId: "multiRepoOrchestration", data: { count: String(repos.length), repos: repos.join(", ") } });
    })
    .with(false, () => {})
    .exhaustive();
};

const createMultiRepoListeners = (
  repoCtx: MultiRepoContext,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  const check = (fn: FunctionNode) => {
    checkFunctionRepos(fn, repoCtx, services, report);
  };
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
    createMultiRepoListeners(
      {
        methodSet: new Set(options.persistenceMethods),
        visitorKeys: context.sourceCode.visitorKeys,
      },
      ESLintUtils.getParserServices(context),
      (d) => { context.report(d); },
    ),
});
