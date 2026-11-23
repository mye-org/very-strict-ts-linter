import {
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import {
  analyzeFileCohesion,
  CohesionCluster,
  DEFAULT_UBIQUITOUS_TYPES,
  FileCohesionResult,
  ModuleCohesionOptions,
} from "../analyzers/module-cohesion-analyzer.js";
import { createRule } from "../lib/rule-factory.js";

type Options = [Partial<ModuleCohesionOptions>];
type MessageIds = "disconnectedExportClusters";

const formatCluster = (cluster: CohesionCluster, index: number) => {
  const base = `Cluster ${String(index + 1)}: [${cluster.exports.join(", ")}]`;
  return cluster.sharedReasons.length > 0
    ? `${base} (${cluster.sharedReasons.slice(0, 2).join("; ")})`
    : base;
};

const joinClusters = (items: ReadonlyArray<string>) => items.join(" | ");

const formatClusters = flow(
  RA.mapWithIndex((idx: number, cluster: CohesionCluster) => formatCluster(cluster, idx)),
  joinClusters,
);

const formatClusterCount = (count: number) => String(count);

const formatCohesionPayload = (clusters: ReadonlyArray<CohesionCluster>) => ({
  clusterCount: formatClusterCount(clusters.length),
  clusters: formatClusters(clusters),
});

const resolveCohesionOptions = (options: Options[0]) => ({
  ubiquitousTypes: options.ubiquitousTypes ?? DEFAULT_UBIQUITOUS_TYPES,
  primaryDomainTypes: options.primaryDomainTypes ?? [],
});

const evaluateProgramCohesion = (
  node: TSESTree.Program,
  services: ParserServicesWithTypeInformation,
  options: Options[0],
) =>
  analyzeFileCohesion(
    services.esTreeNodeToTSNodeMap.get(node),
    services.program.getTypeChecker(),
    resolveCohesionOptions(options),
  );

const reportIfDisconnected = (
  node: TSESTree.Program,
  result: FileCohesionResult,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(result.isCohesive)
    .with(true, () => {})
    .with(false, () => {
      report({ node, messageId: "disconnectedExportClusters", data: formatCohesionPayload(result.clusters) });
    })
    .exhaustive();
};

const checkProgramCohesion = (
  node: TSESTree.Program,
  services: ParserServicesWithTypeInformation,
  options: Options[0],
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  flow(
    (n: TSESTree.Program) => evaluateProgramCohesion(n, services, options),
    (result) => { reportIfDisconnected(node, result, report); },
  )(node);
};

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
  create: (context, [options]) => ({
    Program: (node: TSESTree.Program) => {
      checkProgramCohesion(node, ESLintUtils.getParserServices(context), options, (d) => { context.report(d); });
    },
  }),
});
