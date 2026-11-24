import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { flow } from "fp-ts/lib/function.js";
import { analyzeGuardClauses, GuardCluster } from "../analyzers/guard-clause-analyzer.js";
import { lazyOnce } from "../lib/lazy-once.js";
import { createRule } from "../lib/rule-factory.js";
import { makeLocationKey, resolveTsNodeOwnLocation } from "../lib/ts-node-location.js";

type Options = [Readonly<Record<"minClauses" | "minOccurrences", number>>];
type MessageIds = "repeatedGuardClause";

const isTopLevelLogical = (node: TSESTree.LogicalExpression) =>
  (node.operator === "&&" || node.operator === "||") &&
  !(
    node.parent.type === AST_NODE_TYPES.LogicalExpression &&
    (node.parent.operator === "&&" || node.parent.operator === "||")
  );

const resolveTsLocationKey = flow(resolveTsNodeOwnLocation, makeLocationKey);

const resolveLogicalLocationKey = (
  node: TSESTree.LogicalExpression,
  services: ParserServicesWithTypeInformation,
) => resolveTsLocationKey(services.esTreeNodeToTSNodeMap.get(node));

const formatClusterFields = (cluster: GuardCluster) => ({
  count: String(cluster.locations.length),
  preview: cluster.preview,
});

type GuardClauseEnv = Readonly<{
  readonly options: Options[0];
  readonly services: ParserServicesWithTypeInformation;
  readonly report: (d: TSESLint.ReportDescriptor<MessageIds>) => void;
}>;

const lookupFirstCluster = (key: string) =>
  flow(
    (byLocation: Readonly<Record<string, ReadonlyArray<GuardCluster>>>) =>
      RR.lookup(key)(byLocation),
    O.flatMap(RA.head<GuardCluster>),
  );

const reportRepeatedGuard = (
  env: GuardClauseEnv,
) => (
  node: TSESTree.LogicalExpression,
  byLocation: Readonly<Record<string, ReadonlyArray<GuardCluster>>>,
) => {
  O.map((cluster: GuardCluster) => {
    env.report({
      node,
      messageId: "repeatedGuardClause",
      data: formatClusterFields(cluster),
    });
  })(lookupFirstCluster(resolveLogicalLocationKey(node, env.services))(byLocation));
};

const resolveGuardByLocation = (env: GuardClauseEnv) =>
  analyzeGuardClauses(env.services.program, {
    minClauses: env.options.minClauses,
    minOccurrences: env.options.minOccurrences,
  }).byLocation;

const buildGuardListeners = (env: GuardClauseEnv) => {
  const getByLocation = flow(lazyOnce(() => resolveGuardByLocation(env)));
  return {
    LogicalExpression: (node: TSESTree.LogicalExpression) => {
      O.map((n: TSESTree.LogicalExpression) => {
        reportRepeatedGuard(env)(n, getByLocation());
      })(O.fromPredicate(isTopLevelLogical)(node));
    },
  };
};

export const noRepeatedGuardClauses = createRule<Options, MessageIds>({
  name: "no-repeated-guard-clauses",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Detect structurally similar compound guard clauses inspecting entity fields across multiple call sites; suggest extracting a domain predicate or Specification.",
    },
    messages: {
      repeatedGuardClause:
        "Guard clause `{{preview}}` is duplicated across {{count}} call sites. Extract an intention-revealing predicate or Specification policy.",
    },
    schema: [
      {
        type: "object",
        properties: {
          minClauses: { type: "number", minimum: 2 },
          minOccurrences: { type: "number", minimum: 2 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ minClauses: 2, minOccurrences: 2 }],
  },
  create: (context, [options]) =>
    buildGuardListeners({
      options,
      services: ESLintUtils.getParserServices(context),
      report: (d) => { context.report(d); },
    }),
});
