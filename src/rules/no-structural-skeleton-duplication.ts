import {
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";
import {
  analyzeSkeletonDuplications,
  SkeletonCluster,
} from "../analyzers/skeleton-duplication-analyzer.js";
import { isFlowCallExpression } from "../lib/flow-call.js";
import { lazyOnce } from "../lib/lazy-once.js";
import { isPipeCallExpression } from "../lib/pipe-call.js";
import { createRule } from "../lib/rule-factory.js";
import { makeLocationKey, resolveTsNodeOwnLocation } from "../lib/ts-node-location.js";

type Options = [
  Readonly<Record<"minSteps" | "minDistinctCombinators" | "minOccurrences", number>>,
];
type MessageIds = "structuralSkeletonDuplication";

const resolveTsLocationKey = flow(resolveTsNodeOwnLocation, makeLocationKey);

const resolveCallLocationKey = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) => resolveTsLocationKey(services.esTreeNodeToTSNodeMap.get(node));

const formatClusterFields = (cluster: SkeletonCluster) => ({
  count: String(cluster.sites.length),
  preview: cluster.preview,
});

type SkeletonEnv = Readonly<{
  readonly options: Options[0];
  readonly services: ParserServicesWithTypeInformation;
  readonly report: (d: TSESLint.ReportDescriptor<MessageIds>) => void;
}>;

const reportCluster = (
  env: SkeletonEnv,
) => (
  node: TSESTree.CallExpression,
  locationIndex: Readonly<Record<string, ReadonlyArray<SkeletonCluster>>>,
) => {
  O.map((cluster: SkeletonCluster) => {
    env.report({
      node,
      messageId: "structuralSkeletonDuplication",
      data: formatClusterFields(cluster),
    });
  })(O.fromNullable(locationIndex[resolveCallLocationKey(node, env.services)]?.[0]));
};

const isPipeOrFlowNode = (n: TSESTree.CallExpression) =>
  isPipeCallExpression(n) || isFlowCallExpression(n);

const resolveSkeletonIndex = (options: Options[0], services: ParserServicesWithTypeInformation) =>
  analyzeSkeletonDuplications(services.program, {
    minSteps: options.minSteps,
    minDistinctCombinators: options.minDistinctCombinators,
    minOccurrences: options.minOccurrences,
  }).locationIndex;

const buildSkeletonListeners = (env: SkeletonEnv) => {
  const getLocationIndex = flow(lazyOnce(() => resolveSkeletonIndex(env.options, env.services)));
  return {
    CallExpression: (node: TSESTree.CallExpression) => {
      O.map((n: TSESTree.CallExpression) => {
        reportCluster(env)(n, getLocationIndex());
      })(O.fromPredicate(isPipeOrFlowNode)(node));
    },
  };
};

export const noStructuralSkeletonDuplication = createRule<Options, MessageIds>({
  name: "no-structural-skeleton-duplication",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Detect duplicated multi-step `pipe`/`flow` combinator skeletons across functions (anti-unification); extract a reusable higher-order combinator.",
    },
    messages: {
      structuralSkeletonDuplication:
        "Pipeline skeleton `{{preview}}` is duplicated across {{count}} sites. Extract a higher-order combinator to capture this emergent workflow abstraction.",
    },
    schema: [
      {
        type: "object",
        properties: {
          minSteps: { type: "number", minimum: 2 },
          minDistinctCombinators: { type: "number", minimum: 1 },
          minOccurrences: { type: "number", minimum: 2 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ minSteps: 4, minDistinctCombinators: 3, minOccurrences: 2 }],
  },
  create: (context, [options]) =>
    buildSkeletonListeners({
      options,
      services: ESLintUtils.getParserServices(context),
      report: (d) => {
        context.report(d);
      },
    }),
});
