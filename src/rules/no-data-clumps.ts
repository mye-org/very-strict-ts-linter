import { ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { flow } from "fp-ts/lib/function.js";
import { analyzeDataClumps, ClumpFinding } from "../analyzers/data-clump-analyzer.js";
import { createRule } from "../lib/rule-factory.js";
import { makeLocationKey, resolveTsNodeOwnLocation } from "../lib/ts-node-location.js";

type Options = [Readonly<Record<"minSize" | "minOccurrences", number>>];
type MessageIds = "dataClump";

type ClumpCandidateNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression
  | TSESTree.TSTypeLiteral
  | TSESTree.TSInterfaceDeclaration
  | TSESTree.ClassDeclaration;

const resolveTsLocationKey = flow(resolveTsNodeOwnLocation, makeLocationKey);

const resolveNodeLocationKey = (
  node: ClumpCandidateNode,
  services: ParserServicesWithTypeInformation,
) => resolveTsLocationKey(services.esTreeNodeToTSNodeMap.get(node));

const formatClumpReport = (
  node: ClumpCandidateNode,
  clump: ClumpFinding,
) => ({
  node,
  messageId: "dataClump" as const,
  data: {
    fields: clump.fields.join(", "),
    count: String(clump.locations.length),
    suggestedName: clump.suggestedName,
  },
});

const reportFirstClump = (
  node: ClumpCandidateNode,
  index: Readonly<Record<string, ReadonlyArray<ClumpFinding>>>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  const reportIfFound = flow(
    (n: ClumpCandidateNode) => resolveNodeLocationKey(n, services),
    (key: string) => RR.lookup(key, index),
    O.flatMap(RA.head<ClumpFinding>),
    O.map((clump: ClumpFinding) => { report(formatClumpReport(node, clump)); }),
  );
  reportIfFound(node);
};

const runClumpCheck =
  (
    options: Options[0],
    services: ParserServicesWithTypeInformation,
    report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
  ) =>
  (node: ClumpCandidateNode) => {
    reportFirstClump(
      node,
      analyzeDataClumps(services.program, options.minSize, options.minOccurrences).byLocation,
      services,
      report,
    );
  };

const makeClumpListeners = (
  options: Options[0],
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  const check = runClumpCheck(options, services, report);
  return {
    FunctionDeclaration: check,
    FunctionExpression: check,
    ArrowFunctionExpression: check,
    TSTypeLiteral: check,
    TSInterfaceDeclaration: check,
    ClassDeclaration: check,
  };
};

export const noDataClumps = createRule<Options, MessageIds>({
  name: "no-data-clumps",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Detect parameters or fields that repeatedly co-occur across functions, DTOs, or types; suggest extracting a Value Object.",
    },
    messages: {
      dataClump:
        "Data clump ({{fields}}) appears across {{count}} declarations. Extract a `{{suggestedName}}` Value Object.",
    },
    schema: [
      {
        type: "object",
        properties: {
          minSize: { type: "number", minimum: 2 },
          minOccurrences: { type: "number", minimum: 2 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ minSize: 2, minOccurrences: 3 }],
  },
  create: (context, [options]) =>
    makeClumpListeners(options, ESLintUtils.getParserServices(context), (d) => { context.report(d); }),
});
