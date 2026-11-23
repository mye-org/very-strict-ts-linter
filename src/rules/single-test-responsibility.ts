import {
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
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

const toResponsibilityDescriptor = (finding: SingleResponsibilityFinding) => ({
  loc: {
    start: { line: finding.line, column: 0 },
    end: { line: finding.line, column: 1 },
  },
  messageId: "multipleTestResponsibilities" as const,
  data: {
    testName: finding.testName,
    groupCount: toDecimalText(finding.groups.length),
    groups: flow(RA.map(formatBracketedGroup), joinGroups)(finding.groups),
  },
});

const resolveScopeOptions = (options: Options[0]) => ({
  ...DEFAULT_TEST_SCOPE_OPTIONS,
  testPatterns: options.testPatterns ?? DEFAULT_TEST_PATTERNS,
  minUnrelatedComponents:
    options.minUnrelatedComponents ?? DEFAULT_TEST_SCOPE_OPTIONS.minUnrelatedComponents,
});

const reportFileResponsibilities = (
  fileName: string,
  services: ParserServicesWithTypeInformation,
  options: Options[0],
  report: Reporter,
) => {
  RA.map((finding: SingleResponsibilityFinding) => {
    report(toResponsibilityDescriptor(finding));
  })(analyzeTestScope(services.program, resolveScopeOptions(options)).responsibilityByFile[fileName] ?? []);
};

const inspectTestProgram = (
  programNode: TSESTree.Program,
  services: ParserServicesWithTypeInformation,
  options: Options[0],
  report: Reporter,
) => {
  const fileName = normalizeFilePath(services.esTreeNodeToTSNodeMap.get(programNode).fileName);
  match(isMatchingAnyPattern(fileName, options.testPatterns ?? DEFAULT_TEST_PATTERNS))
    .with(false, () => {})
    .with(true, () => {
      reportFileResponsibilities(fileName, services, options, report);
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
    Program: (programNode: TSESTree.Program) => {
      inspectTestProgram(programNode, ESLintUtils.getParserServices(context), options, (d) => {
        context.report(d);
      });
    },
  }),
});
