import { ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { flow } from "fp-ts/lib/function.js";
import { analyzeDataClumps, ClumpFinding } from "../analyzers/data-clump-analyzer.js";
import { lazyOnce } from "../lib/lazy-once.js";
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

type ClumpCheckEnv = Readonly<{
  readonly options: Options[0];
  readonly services: ParserServicesWithTypeInformation;
  readonly report: (d: TSESLint.ReportDescriptor<MessageIds>) => void;
}>;

const reportFirstClump = (
  env: ClumpCheckEnv,
) => (
  node: ClumpCandidateNode,
  index: Readonly<Record<string, ReadonlyArray<ClumpFinding>>>,
) => {
  const reportIfFound = flow(
    (n: ClumpCandidateNode) => resolveNodeLocationKey(n, env.services),
    (key: string) => RR.lookup(key, index),
    O.flatMap(RA.head<ClumpFinding>),
    O.map((clump: ClumpFinding) => { env.report(formatClumpReport(node, clump)); }),
  );
  reportIfFound(node);
};

const resolveClumpsByLocation = (env: ClumpCheckEnv) =>
  analyzeDataClumps(env.services.program, {
    minSize: env.options.minSize,
    minOccurrences: env.options.minOccurrences,
  }).byLocation;

const makeClumpListeners = (env: ClumpCheckEnv) => {
  const getByLocation = flow(lazyOnce(() => resolveClumpsByLocation(env)));
  const check = (node: ClumpCandidateNode) => {
    reportFirstClump(env)(node, getByLocation());
  };
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
    makeClumpListeners({
      options,
      services: ESLintUtils.getParserServices(context),
      report: (d) => { context.report(d); },
    }),
});
