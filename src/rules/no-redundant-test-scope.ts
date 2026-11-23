import {
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { DEFAULT_TEST_PATTERNS } from "../analyzers/module-symbol-graph.js";
import {
  analyzeTestScope,
  DEFAULT_TEST_SCOPE_OPTIONS,
  RedundantTestFinding,
} from "../analyzers/test-scope-analyzer.js";
import { createRule } from "../lib/rule-factory.js";
import { isMatchingAnyPattern, normalizeFilePath } from "../lib/source-paths.js";

// eslint-disable-next-line strict-fp/prefer-union-over-boolean -- ESLint rule JSON schema boolean option
type CheckSameLevelFlag = boolean;

type Options = [
  Partial<
    Readonly<{
      readonly testPatterns: ReadonlyArray<string>;
      readonly checkSameLevelDuplicates: CheckSameLevelFlag;
    }> &
      Readonly<Record<"minRepeatedCases", number>>
  >,
];

type MessageIds = "redundantCrossLevelTest" | "duplicateSameLevelTest";

const toLineLoc = (line: number) => ({
  start: { line, column: 0 },
  end: { line, column: 1 },
});

const formatExistingTests = (existingTests: ReadonlyArray<string>) =>
  RA.map((t: string) => `'${t}'`)(existingTests).join(", ");

const toCrossLevelDescriptor = (
  f: Extract<RedundantTestFinding, { readonly kind: "redundantCrossLevelTest" }>,
) => ({
  loc: toLineLoc(f.line),
  messageId: "redundantCrossLevelTest" as const,
  data: {
    testName: f.testName,
    property: f.property,
    lowerComponent: f.lowerComponent,
    higherComponent: f.higherComponent,
    existingTests: formatExistingTests(f.existingTests),
  },
});

const toSameLevelDescriptor = (
  f: Extract<RedundantTestFinding, { readonly kind: "duplicateSameLevelTest" }>,
) => ({
  loc: toLineLoc(f.line),
  messageId: "duplicateSameLevelTest" as const,
  data: {
    testName: f.testName,
    targetComponent: f.targetComponent,
    primaryTest: f.primaryTest,
  },
});

const reportRedundantFinding = (
  finding: RedundantTestFinding,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(finding)
    .with({ kind: "redundantCrossLevelTest" }, (f) => { report(toCrossLevelDescriptor(f)); })
    .with({ kind: "duplicateSameLevelTest" }, (f) => { report(toSameLevelDescriptor(f)); })
    .exhaustive();
};

const resolveScopeOptions = (options: Options[0], testPatterns: ReadonlyArray<string>) => ({
  ...DEFAULT_TEST_SCOPE_OPTIONS,
  testPatterns,
  minRepeatedCases: options.minRepeatedCases ?? DEFAULT_TEST_SCOPE_OPTIONS.minRepeatedCases,
  checkSameLevelDuplicates:
    (options.checkSameLevelDuplicates ?? true) ? ("enabled" as const) : ("disabled" as const),
});

const reportRedundantFindings = (
  fileName: string,
  options: Options[0],
  testPatterns: ReadonlyArray<string>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  RA.map((finding: RedundantTestFinding) => {
    reportRedundantFinding(finding, report);
  })(
    analyzeTestScope(services.program, resolveScopeOptions(options, testPatterns)).redundancyByFile[
      fileName
    ] ?? [],
  );
};

const resolveProgramFileName = (
  programNode: TSESTree.Program,
  services: ParserServicesWithTypeInformation,
) => normalizeFilePath(services.esTreeNodeToTSNodeMap.get(programNode).fileName);

const checkProgram = (
  programNode: TSESTree.Program,
  options: Options[0],
  testPatterns: ReadonlyArray<string>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  flow(
    O.fromPredicate((fileName: string) => isMatchingAnyPattern(fileName, testPatterns)),
    O.map((fileName) => {
      reportRedundantFindings(fileName, options, testPatterns, services, report);
    }),
  )(resolveProgramFileName(programNode, services));
};

const buildTestScopeListeners = (
  options: Options[0],
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => ({
  Program: (programNode: TSESTree.Program) => {
    checkProgram(
      programNode,
      options,
      options.testPatterns ?? DEFAULT_TEST_PATTERNS,
      services,
      report,
    );
  },
});

export const noRedundantTestScope = createRule<Options, MessageIds>({
  name: "no-redundant-test-scope",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Detect tests whose correctness guarantees overlap unnecessarily with existing lower-level unit tests or peer tests, while preserving minimal composition wiring coverage.",
    },
    messages: {
      redundantCrossLevelTest:
        "[TESTSCOPE-001] Potentially redundant test '{{testName}}': verifies '{{property}}' (owned by '{{lowerComponent}}') through '{{higherComponent}}', already verified by {{existingTests}}. Remove repeated '{{lowerComponent}}' cases and retain a minimal '{{higherComponent}}' composition test verifying dependency wiring.",
      duplicateSameLevelTest:
        "[TESTSCOPE-001] Duplicate test scope in '{{testName}}': asserts the same '{{targetComponent}}' behavior already verified by '{{primaryTest}}'. Consolidate or test a distinct behavioral property.",
    },
    schema: [
      {
        type: "object",
        properties: {
          testPatterns: { type: "array", items: { type: "string" } },
          minRepeatedCases: { type: "number", minimum: 1 },
          checkSameLevelDuplicates: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        testPatterns: [...DEFAULT_TEST_PATTERNS],
        minRepeatedCases: DEFAULT_TEST_SCOPE_OPTIONS.minRepeatedCases,
        checkSameLevelDuplicates: true,
      },
    ],
  },
  create: (context, [options]) =>
    buildTestScopeListeners(options, ESLintUtils.getParserServices(context), (d) => {
      context.report(d);
    }),
});
