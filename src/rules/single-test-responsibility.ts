import {
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { DEFAULT_TEST_PATTERNS } from "../analyzers/module-symbol-graph.js";
import {
  analyzeTestScope,
  DEFAULT_TEST_SCOPE_OPTIONS,
  SingleResponsibilityFinding,
} from "../analyzers/test-scope-analyzer.js";
import { createRule } from "../lib/rule-factory.js";
import { isMatchingAnyPattern, normalizeFilePath } from "../lib/source-paths.js";

type Options = [
  Partial<
    Readonly<
      Record<"minUnrelatedComponents", number> & {
        readonly testPatterns: ReadonlyArray<string>;
      }
    >
  >,
];

type MessageIds = "multipleTestResponsibilities";
type Reporter = (d: TSESLint.ReportDescriptor<MessageIds>) => void;

const formatBracketedGroup = (group: ReadonlyArray<string>) => `[${group.join(", ")}]`;
const joinGroups = (groups: ReadonlyArray<string>) => groups.join(" | ");
const toDecimalText = (value: number) => String(value);
const formatAllGroups = flow(RA.map(formatBracketedGroup), joinGroups);

const toResponsibilityDescriptor = (finding: SingleResponsibilityFinding) => ({
  loc: {
    start: { line: finding.line, column: 0 },
    end: { line: finding.line, column: 1 },
  },
  messageId: "multipleTestResponsibilities" as const,
  data: {
    testName: finding.testName,
    groupCount: toDecimalText(finding.groups.length),
    groups: formatAllGroups(finding.groups),
  },
});

const resolveTestPatterns = flow(
  (options: Options[0]) => options.testPatterns,
  O.fromNullable,
  O.getOrElse<ReadonlyArray<string>>(() => DEFAULT_TEST_PATTERNS),
);

const resolveScopeOptions = (options: Options[0]) => ({
  ...DEFAULT_TEST_SCOPE_OPTIONS,
  testPatterns: resolveTestPatterns(options),
  minUnrelatedComponents: O.getOrElse(() => DEFAULT_TEST_SCOPE_OPTIONS.minUnrelatedComponents)(
    O.fromNullable(options.minUnrelatedComponents),
  ),
});

const reportFileResponsibilities =
  (services: ParserServicesWithTypeInformation, options: Options[0]) =>
  (report: Reporter) =>
  (fileName: string) => {
    O.map(
      RA.map((finding: SingleResponsibilityFinding) => {
        report(toResponsibilityDescriptor(finding));
      }),
    )(
      RR.lookup(fileName)(
        analyzeTestScope(services.program, resolveScopeOptions(options)).responsibilityByFile,
      ),
    );
  };

const isTargetTestFile = (fileName: string, options: Options[0]) =>
  isMatchingAnyPattern(fileName, resolveTestPatterns(options));

const inspectTestProgram =
  (services: ParserServicesWithTypeInformation, options: Options[0]) =>
  (report: Reporter) =>
  (programNode: TSESTree.Program) => {
    const fileName = normalizeFilePath(services.esTreeNodeToTSNodeMap.get(programNode).fileName);
    match(isTargetTestFile(fileName, options))
      .with(false, () => {})
      .with(true, () => {
        reportFileResponsibilities(services, options)(report)(fileName);
      })
      .exhaustive();
  };

export const singleTestResponsibility = createRule<Options, MessageIds>({
  name: "single-test-responsibility",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Ensure each test targets a single well-defined correctness property by flagging test cases that assert on multiple disconnected production components with no call, module, dataflow, or invariant relationship.",
    },
    messages: {
      multipleTestResponsibilities:
        "[TESTSCOPE-003] Test '{{testName}}' verifies {{groupCount}} unrelated component responsibilities in one test ({{groups}}). Split into focused tests so each test owns a single correctness property.",
    },
    schema: [
      {
        type: "object",
        properties: {
          testPatterns: { type: "array", items: { type: "string" } },
          minUnrelatedComponents: { type: "number", minimum: 2 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        testPatterns: [...DEFAULT_TEST_PATTERNS],
        minUnrelatedComponents: DEFAULT_TEST_SCOPE_OPTIONS.minUnrelatedComponents,
      },
    ],
  },
  create: (context, [options]) => ({
    Program: inspectTestProgram(ESLintUtils.getParserServices(context), options)((d) => {
      context.report(d);
    }),
  }),
});
