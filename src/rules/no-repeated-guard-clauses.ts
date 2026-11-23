import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";
import { analyzeGuardClauses, GuardCluster } from "../analyzers/guard-clause-analyzer.js";
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

const resolveLogicalLocationKey = (
  node: TSESTree.LogicalExpression,
  services: ParserServicesWithTypeInformation,
) => flow(resolveTsNodeOwnLocation, makeLocationKey)(services.esTreeNodeToTSNodeMap.get(node));

const formatClusterFields = (cluster: GuardCluster) => ({
  count: String(cluster.locations.length),
  preview: cluster.preview,
});

const reportRepeatedGuard = (
  node: TSESTree.LogicalExpression,
  byLocation: Readonly<Record<string, ReadonlyArray<GuardCluster>>>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  O.map((cluster: GuardCluster) => {
    report({
      node,
      messageId: "repeatedGuardClause",
      data: formatClusterFields(cluster),
    });
  })(O.fromNullable(byLocation[resolveLogicalLocationKey(node, services)]?.[0]));
};

const checkLogicalExpr = (
  node: TSESTree.LogicalExpression,
  options: Options[0],
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  flow(
    O.fromPredicate(isTopLevelLogical),
    O.map((n) => {
      reportRepeatedGuard(
        n,
        analyzeGuardClauses(services.program, options.minClauses, options.minOccurrences).byLocation,
        services,
        report,
      );
    }),
  )(node);
};

const buildGuardListeners = (
  options: Options[0],
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => ({
  LogicalExpression: (node: TSESTree.LogicalExpression) => {
    checkLogicalExpr(node, options, services, report);
  },
});

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
    buildGuardListeners(options, ESLintUtils.getParserServices(context), (d) => { context.report(d); }),
});
