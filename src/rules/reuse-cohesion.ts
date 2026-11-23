import path from "node:path";
import {
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { DEFAULT_TEST_PATTERNS } from "../analyzers/module-symbol-graph.js";
import {
  analyzeCommonReuseCohesion,
  CommonReuseAnalysis,
  CommonReuseFinding,
  CommonReuseOptions,
  ConsumerExportGroup,
} from "../analyzers/reuse-cohesion-analyzer.js";
import { memoizeByProgramAndKey } from "../lib/program-memo.js";
import { createRule } from "../lib/rule-factory.js";
import { normalizeFilePath } from "../lib/source-paths.js";

type Options = [
  Partial<
    Readonly<
      Record<"minExports", number> & {
        readonly testPatterns: ReadonlyArray<string>;
      }
    >
  >,
];

type MessageIds = "disjointConsumerGroups";
type Reporter = (d: TSESLint.ReportDescriptor<MessageIds>) => void;

const isContainedRelativePath = (rel: string) => !rel.startsWith("..") && rel !== "";

const formatRelativePath = (cwd: string, filePath: string) => {
  const rel = normalizeFilePath(path.relative(cwd, filePath));
  return isContainedRelativePath(rel) ? rel : filePath;
};

const joinWithComma = (items: ReadonlyArray<string>) => items.join(", ");
const joinWithPipe = (items: ReadonlyArray<string>) => items.join(" | ");
const toDecimalText = (value: number) => String(value);

const formatGroupSummary = (label: string, exportsText: string, consumersText: string) =>
  `Group ${label} [${exportsText}] -> ${consumersText}`;

const formatConsumers = (consumers: ReadonlyArray<string>, cwd: string) => {
  const format = flow(
    RA.map((c: string) => formatRelativePath(cwd, c)),
    joinWithComma,
  );
  return format(consumers);
};

const formatGroup = (group: ConsumerExportGroup, index: number, cwd: string) =>
  formatGroupSummary(
    toDecimalText(index + 1),
    joinWithComma(group.exports),
    formatConsumers(group.consumers, cwd),
  );

const formatAllGroups = (groups: ReadonlyArray<ConsumerExportGroup>, cwd: string) => {
  const format = flow(
    RA.mapWithIndex((idx: number, g: ConsumerExportGroup) => formatGroup(g, idx, cwd)),
    joinWithPipe,
  );
  return format(groups);
};

const toDisjointGroupDescriptor = (
  node: TSESTree.Program,
  finding: CommonReuseFinding,
  cwd: string,
) => ({
  node,
  messageId: "disjointConsumerGroups" as const,
  data: {
    exportCount: toDecimalText(finding.exportCount),
    groupCount: toDecimalText(finding.groups.length),
    groups: formatAllGroups(finding.groups, cwd),
  },
});

const resolveCohesionOptions = (options: Options[0]) => ({
  minExports: options.minExports ?? 5,
  testPatterns: options.testPatterns ?? DEFAULT_TEST_PATTERNS,
});

const resolveProgramFileName = (
  programNode: TSESTree.Program,
  services: ParserServicesWithTypeInformation,
) => normalizeFilePath(services.esTreeNodeToTSNodeMap.get(programNode).fileName);

const commonReuseCache = new WeakMap<
  ts.Program,
  Readonly<Record<string, CommonReuseAnalysis>>
>();

const serializeCommonReuseOptions = (options: CommonReuseOptions) =>
  `${String(options.minExports)}||${options.testPatterns.join(",")}`;

const analyzeByFile =
  (program: ts.Program) =>
  (resolved: CommonReuseOptions) =>
    memoizeByProgramAndKey(
      program,
      serializeCommonReuseOptions(resolved),
      commonReuseCache,
      (p) => analyzeCommonReuseCohesion(p, resolved),
    ).byFile;

const lookupByFileName =
  (fileName: string) => (byFile: Readonly<Record<string, CommonReuseFinding>>) =>
    O.fromNullable(byFile[fileName]);

const lookupCohesionFinding = (
  programNode: TSESTree.Program,
  services: ParserServicesWithTypeInformation,
  options: Options[0],
) => {
  const lookup = flow(
    resolveCohesionOptions,
    analyzeByFile(services.program),
    lookupByFileName(resolveProgramFileName(programNode, services)),
  );
  return lookup(options);
};

const inspectProgramCohesion = (
  programNode: TSESTree.Program,
  services: ParserServicesWithTypeInformation,
  options: Options[0],
  cwd: string,
  report: Reporter,
) => {
  O.map((finding: CommonReuseFinding) => {
    report(toDisjointGroupDescriptor(programNode, finding, cwd));
  })(lookupCohesionFinding(programNode, services, options));
};

export const commonReuseCohesion = createRule<Options, MessageIds>({
  name: "common-reuse-cohesion",
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce the Common Reuse Principle (CRP) by flagging modules with more than minExports runtime exports whose exports partition into disjoint non-test consumer groups.",
    },
    messages: {
      disjointConsumerGroups:
        "Module has {{exportCount}} runtime exports split into {{groupCount}} disjoint consumer groups ({{groups}}). Split the module along actor boundaries (Common Reuse Principle).",
    },
    schema: [
      {
        type: "object",
        properties: {
          minExports: { type: "number", minimum: 1 },
          testPatterns: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        minExports: 5,
        testPatterns: [...DEFAULT_TEST_PATTERNS],
      },
    ],
  },
  create: (context, [options]) => ({
    Program: (programNode: TSESTree.Program) => {
      inspectProgramCohesion(
        programNode,
        ESLintUtils.getParserServices(context),
        options,
        context.cwd,
        (d) => {
          context.report(d);
        },
      );
    },
  }),
});
