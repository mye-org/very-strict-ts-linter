import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import {
  analyzeFileCohesion,
  CohesionCluster,
  DEFAULT_UBIQUITOUS_TYPES,
} from "../analyzers/module-cohesion-analyzer.js";
import { createRule } from "../utils/create-rule.js";

type Options = [
  Partial<
    Readonly<{
      readonly ubiquitousTypes: ReadonlyArray<string>;
      readonly primaryDomainTypes: ReadonlyArray<string>;
    }>
  >,
];

type MessageIds = "disconnectedExportClusters";

const formatCluster = (cluster: CohesionCluster, index: number) => {
  const base = `Cluster ${String(index + 1)}: [${cluster.exports.join(", ")}]`;
  return cluster.sharedReasons.length > 0
    ? `${base} (${cluster.sharedReasons.slice(0, 2).join("; ")})`
    : base;
};

const formatClusters = (clusters: ReadonlyArray<CohesionCluster>) =>
  pipe(clusters, RA.mapWithIndex((idx, c) => formatCluster(c, idx))).join(" | ");

export const moduleCohesion = createRule<Options, MessageIds>({
  name: "module-cohesion",
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce internal module cohesion (Module LCOM4) by ensuring runtime exports form a single connected component via calls, shared private helpers, or shared domain types.",
    },
    messages: {
      disconnectedExportClusters:
        "Module exports form {{clusterCount}} disconnected cohesion clusters ({{clusters}}). Split unrelated exports into separate cohesive modules.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ubiquitousTypes: { type: "array", items: { type: "string" } },
          primaryDomainTypes: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        ubiquitousTypes: [...DEFAULT_UBIQUITOUS_TYPES],
        primaryDomainTypes: [],
      },
    ],
  },
  create: (context, [options]) => {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const resolvedOptions = {
      ubiquitousTypes: options.ubiquitousTypes ?? DEFAULT_UBIQUITOUS_TYPES,
      primaryDomainTypes: options.primaryDomainTypes ?? [],
    };

    return {
      Program: (node: TSESTree.Program) => {
        const sf = services.esTreeNodeToTSNodeMap.get(node);
        const result = analyzeFileCohesion(sf, checker, resolvedOptions);
        if (!result.isCohesive) {
          context.report({
            node,
            messageId: "disconnectedExportClusters",
            data: {
              clusterCount: String(result.clusters.length),
              clusters: formatClusters(result.clusters),
            },
          });
        }
      },
    };
  },
});
