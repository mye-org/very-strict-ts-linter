import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";
import { DEFAULT_TEST_PATTERNS } from "../analyzers/module-symbol-graph.js";
import {
  analyzeTestScope,
  DEFAULT_TEST_SCOPE_OPTIONS,
} from "../analyzers/test-scope-analyzer.js";
import { createRule } from "../utils/create-rule.js";
import { isMatchingAnyPattern, normalizeFilePath } from "../utils/program-cache.js";

// eslint-disable-next-line strict-fp/prefer-union-over-boolean -- ESLint rule JSON schema boolean option
type CheckSameLevelFlag = boolean;

type Options = [
  Partial<
    Readonly<{
      readonly testPatterns: ReadonlyArray<string>;
      readonly minRepeatedCases: number;
      readonly checkSameLevelDuplicates: CheckSameLevelFlag;
    }>
  >,
];

type MessageIds = "redundantCrossLevelTest" | "duplicateSameLevelTest";

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
  create: (context, [options]) => {
    const services = ESLintUtils.getParserServices(context);
    const testPatterns = options.testPatterns ?? DEFAULT_TEST_PATTERNS;

    return {
      Program: (programNode: TSESTree.Program) => {
        const sf = services.esTreeNodeToTSNodeMap.get(programNode);
        const fileName = normalizeFilePath(sf.fileName);
        if (!isMatchingAnyPattern(fileName, testPatterns)) return;

        const analysis = analyzeTestScope(services.program, {
          ...DEFAULT_TEST_SCOPE_OPTIONS,
          testPatterns,
          minRepeatedCases:
            options.minRepeatedCases ?? DEFAULT_TEST_SCOPE_OPTIONS.minRepeatedCases,
          checkSameLevelDuplicates:
            (options.checkSameLevelDuplicates ?? true) ? "enabled" : "disabled",
        });

        const findings = analysis.redundancyByFile[fileName] ?? [];
        for (const finding of findings) {
          const loc = {
            start: { line: finding.line, column: 0 },
            end: { line: finding.line, column: 1 },
          };
          if (finding.kind === "redundantCrossLevelTest") {
            context.report({
              loc,
              messageId: "redundantCrossLevelTest",
              data: {
                testName: finding.testName,
                property: finding.property,
                lowerComponent: finding.lowerComponent,
                higherComponent: finding.higherComponent,
                existingTests: finding.existingTests.map((t) => `'${t}'`).join(", "),
              },
            });
          } else {
            context.report({
              loc,
              messageId: "duplicateSameLevelTest",
              data: {
                testName: finding.testName,
                targetComponent: finding.targetComponent,
                primaryTest: finding.primaryTest,
              },
            });
          }
        }
      },
    };
  },
});
