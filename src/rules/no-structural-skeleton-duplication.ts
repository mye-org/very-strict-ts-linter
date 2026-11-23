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
import { isPipeCallExpression } from "../lib/pipe-call.js";
import { createRule } from "../lib/rule-factory.js";
import { makeLocationKey, resolveTsNodeOwnLocation } from "../lib/ts-node-location.js";

type Options = [
  Readonly<Record<"minSteps" | "minDistinctCombinators" | "minOccurrences", number>>,
];
type MessageIds = "structuralSkeletonDuplication";

const resolveCallLocationKey = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) => flow(resolveTsNodeOwnLocation, makeLocationKey)(services.esTreeNodeToTSNodeMap.get(node));

const formatClusterFields = (cluster: SkeletonCluster) => ({
  count: String(cluster.sites.length),
  preview: cluster.preview,
});

const reportCluster = (
  node: TSESTree.CallExpression,
  locationIndex: Readonly<Record<string, ReadonlyArray<SkeletonCluster>>>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  O.map((cluster: SkeletonCluster) => {
    report({
      node,
      messageId: "structuralSkeletonDuplication",
      data: formatClusterFields(cluster),
    });
  })(O.fromNullable(locationIndex[resolveCallLocationKey(node, services)]?.[0]));
};

const isPipeOrFlowNode = (n: TSESTree.CallExpression) =>
  isPipeCallExpression(n) || isFlowCallExpression(n);

const resolveSkeletonIndex = (options: Options[0], services: ParserServicesWithTypeInformation) =>
  analyzeSkeletonDuplications(
    services.program,
    options.minSteps,
    options.minDistinctCombinators,
    options.minOccurrences,
  ).locationIndex;

const checkPipelineCall = (
  node: TSESTree.CallExpression,
  options: Options[0],
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  flow(
    O.fromPredicate(isPipeOrFlowNode),
    O.map((n) => {
      reportCluster(n, resolveSkeletonIndex(options, services), services, report);
    }),
  )(node);
};

const buildSkeletonListeners = (
  options: Options[0],
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => ({
  CallExpression: (node: TSESTree.CallExpression) => {
    checkPipelineCall(node, options, services, report);
  },
});

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
    buildSkeletonListeners(options, ESLintUtils.getParserServices(context), (d) => {
      context.report(d);
    }),
});
