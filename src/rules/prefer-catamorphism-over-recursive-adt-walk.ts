import {
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import {
  analyzeCatamorphisms,
  CatamorphismFinding,
} from "../analyzers/catamorphism-analyzer.js";
import { hasFunctionInit } from "../lib/estree-function-nodes.js";
import { createRule } from "../lib/rule-factory.js";
import { makeLocationKey, resolveTsNodeOwnLocation } from "../lib/ts-node-location.js";

type Options = [Readonly<Record<"minWalkers", number>>];
type MessageIds = "preferCatamorphism";

const resolveNodeLocationKey = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => flow(resolveTsNodeOwnLocation, makeLocationKey)(services.esTreeNodeToTSNodeMap.get(node));

const formatWalkerList = (finding: CatamorphismFinding) =>
  RA.map((w: CatamorphismFinding["walkers"][number]) => w.functionName)(finding.walkers).join(", ");

const formatWalkerCount = (finding: CatamorphismFinding) => String(finding.walkers.length);

const formatSuggestedFold = (adtName: string) => `fold${adtName}`;

const toCatamorphismDescriptor = (node: TSESTree.Node, finding: CatamorphismFinding) => ({
  node,
  messageId: "preferCatamorphism" as const,
  data: {
    adt: finding.adtName,
    count: formatWalkerCount(finding),
    walkers: formatWalkerList(finding),
    suggestedFold: formatSuggestedFold(finding.adtName),
  },
});

const reportWalkerFindings = (
  node: TSESTree.Node,
  locationIndex: Readonly<Record<string, ReadonlyArray<CatamorphismFinding>>>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  O.map(RA.map((finding: CatamorphismFinding) => { report(toCatamorphismDescriptor(node, finding)); }))(
    O.fromNullable(locationIndex[resolveNodeLocationKey(node, services)]),
  );
};

const checkWalkerNode = (
  node: TSESTree.Node,
  minWalkers: number,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  reportWalkerFindings(
    node,
    analyzeCatamorphisms(services.program, minWalkers).locationIndex,
    services,
    report,
  );
};

const buildCatamorphismListeners = (
  minWalkers: number,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => ({
  FunctionDeclaration: (node: TSESTree.FunctionDeclaration) => {
    checkWalkerNode(node, minWalkers, services, report);
  },
  VariableDeclarator: (node: TSESTree.VariableDeclarator) => {
    flow(
      O.fromPredicate(hasFunctionInit),
      O.map((n) => { checkWalkerNode(n, minWalkers, services, report); }),
    )(node);
  },
});

export const preferCatamorphismOverRecursiveAdtWalk = createRule<Options, MessageIds>({
  name: "prefer-catamorphism-over-recursive-adt-walk",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Detect multiple manual recursive traversal functions over the same recursive discriminated-union ADT; suggest extracting a single catamorphism (`fold`) combinator.",
    },
    messages: {
      preferCatamorphism:
        "Recursive ADT `{{adt}}` has {{count}} manual recursive walkers ({{walkers}}). Extract a single catamorphism (`{{suggestedFold}}`) so consumers supply an algebra instead of duplicating recursion.",
    },
    schema: [
      {
        type: "object",
        properties: {
          minWalkers: { type: "number", minimum: 2 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ minWalkers: 2 }],
  },
  create: (context, [options]) =>
    buildCatamorphismListeners(options.minWalkers, ESLintUtils.getParserServices(context), (d) => {
      context.report(d);
    }),
});
