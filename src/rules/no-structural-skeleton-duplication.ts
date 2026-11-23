import {
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { pipe } from "fp-ts/lib/function.js";
import {
  analyzeSkeletonDuplications,
  SkeletonCluster,
} from "../analyzers/skeleton-duplication-analyzer.js";
import { createRule } from "../utils/create-rule.js";
import { getTsNodeOwnLocation, makeLocationKey } from "../utils/ts-ast-helpers.js";
import { isFlowCallExpression, isPipeCallExpression } from "../utils/type-helpers.js";

type Options = [
  Readonly<Record<"minSteps" | "minDistinctCombinators" | "minOccurrences", number>>,
];
type MessageIds = "structuralSkeletonDuplication";

const getCallLocationKey = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) => pipe(services.esTreeNodeToTSNodeMap.get(node), getTsNodeOwnLocation, makeLocationKey);

const reportCluster = (
  node: TSESTree.CallExpression,
  locationIndex: Readonly<Record<string, ReadonlyArray<SkeletonCluster>>>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  pipe(
    O.fromNullable(locationIndex[getCallLocationKey(node, services)]?.[0]),
    O.map((cluster) => {
      report({
        node,
        messageId: "structuralSkeletonDuplication",
        data: { count: String(cluster.sites.length), preview: cluster.preview },
      });
    }),
  );
};

const isPipeOrFlowNode = (n: TSESTree.CallExpression) =>
  isPipeCallExpression(n) || isFlowCallExpression(n);

const getSkeletonIndex = (options: Options[0], services: ParserServicesWithTypeInformation) =>
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
  pipe(
    O.fromPredicate(isPipeOrFlowNode)(node),
    O.map((n) => {
      reportCluster(n, getSkeletonIndex(options, services), services, report);
    }),
  );
};

const createSkeletonListeners = (
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
    createSkeletonListeners(options, ESLintUtils.getParserServices(context), (d) => {
      context.report(d);
    }),
});
