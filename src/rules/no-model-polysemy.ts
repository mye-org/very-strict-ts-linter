import { ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { analyzePolysemy, PolysemyFinding } from "../analyzers/polysemy-analyzer.js";
import { createRule } from "../lib/rule-factory.js";
import { makeLocationKey, resolveTsNodeOwnLocation } from "../lib/ts-node-location.js";

type Options = [
  Readonly<
    Record<"minFields" | "minClusterFields" | "maxOverlap", number>
  >,
];
type MessageIds = "modelPolysemy";

type ModelDeclNode =
  | TSESTree.TSTypeAliasDeclaration
  | TSESTree.TSInterfaceDeclaration
  | TSESTree.ClassDeclaration;

const formatClusterFields = (cluster: PolysemyFinding["clusters"][number]) =>
  `{${cluster.fields.join(", ")}}`;

const joinWithVs = (items: ReadonlyArray<string>) => items.join(" vs ");

const formatClusters = flow(
  (finding: PolysemyFinding) => finding.clusters,
  RA.map(formatClusterFields),
  joinWithVs,
);

const resolveTsLocationKey = flow(resolveTsNodeOwnLocation, makeLocationKey);

const resolveModelKey = (
  node: ModelDeclNode,
  services: ParserServicesWithTypeInformation,
) => resolveTsLocationKey(services.esTreeNodeToTSNodeMap.get(node));

const checkModelNode = (
  node: ModelDeclNode,
  byLocation: Readonly<Record<string, PolysemyFinding>>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  O.map((finding: PolysemyFinding) => {
    report({
      node: node.id ?? node,
      messageId: "modelPolysemy",
      data: { model: finding.modelName, clusters: formatClusters(finding) },
    });
  })(O.fromNullable(byLocation[resolveModelKey(node, services)]));
};

const buildPolysemyListeners = (
  options: Options[0],
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  const check = (node: ModelDeclNode) => {
    checkModelNode(
      node,
      analyzePolysemy(services.program, options.minFields, options.minClusterFields, options.maxOverlap).byLocation,
      services,
      report,
    );
  };
  return {
    TSTypeAliasDeclaration: check,
    TSInterfaceDeclaration: check,
    ClassDeclaration: check,
  };
};

export const noModelPolysemy = createRule<Options, MessageIds>({
  name: "no-model-polysemy",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Detect core models whose fields are accessed in disjoint clusters by separate modules; signals a missing Bounded Context split.",
    },
    messages: {
      modelPolysemy:
        "Model `{{model}}` has disjoint field-access clusters across modules ({{clusters}}). Consider splitting into separate Bounded Context models.",
    },
    schema: [
      {
        type: "object",
        properties: {
          minFields: { type: "number", minimum: 2 },
          minClusterFields: { type: "number", minimum: 1 },
          maxOverlap: { type: "number", minimum: 0, maximum: 1 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ minFields: 4, minClusterFields: 2, maxOverlap: 0.2 }],
  },
  create: (context, [options]) =>
    buildPolysemyListeners(options, ESLintUtils.getParserServices(context), (d) => { context.report(d); }),
});
