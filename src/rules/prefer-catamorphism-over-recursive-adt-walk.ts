import {
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import {
  analyzeCatamorphisms,
  CatamorphismFinding,
} from "../analyzers/catamorphism-analyzer.js";
import { createRule } from "../utils/create-rule.js";
import { getTsNodeOwnLocation, makeLocationKey } from "../utils/ts-ast-helpers.js";
import { hasFunctionInit } from "../utils/type-helpers.js";

type Options = [Readonly<Record<"minWalkers", number>>];
type MessageIds = "preferCatamorphism";

const getNodeLocationKey = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => pipe(services.esTreeNodeToTSNodeMap.get(node), getTsNodeOwnLocation, makeLocationKey);

const formatWalkerList = (finding: CatamorphismFinding) =>
  pipe(
    finding.walkers,
    RA.map((w) => w.functionName),
  ).join(", ");

const toCatamorphismDescriptor = (node: TSESTree.Node, finding: CatamorphismFinding) => ({
  node,
  messageId: "preferCatamorphism" as const,
  data: {
    adt: finding.adtName,
    count: String(finding.walkers.length),
    walkers: formatWalkerList(finding),
    suggestedFold: `fold${finding.adtName}`,
  },
});

const reportWalkerFindings = (
  node: TSESTree.Node,
  locationIndex: Readonly<Record<string, ReadonlyArray<CatamorphismFinding>>>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  pipe(
    O.fromNullable(locationIndex[getNodeLocationKey(node, services)]),
    O.map(RA.map((finding) => { report(toCatamorphismDescriptor(node, finding)); })),
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

const createCatamorphismListeners = (
  minWalkers: number,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => ({
  FunctionDeclaration: (node: TSESTree.FunctionDeclaration) => {
    checkWalkerNode(node, minWalkers, services, report);
  },
  VariableDeclarator: (node: TSESTree.VariableDeclarator) => {
    pipe(
      O.fromPredicate(hasFunctionInit)(node),
      O.map((n) => { checkWalkerNode(n, minWalkers, services, report); }),
    );
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
    createCatamorphismListeners(options.minWalkers, ESLintUtils.getParserServices(context), (d) => {
      context.report(d);
    }),
});
