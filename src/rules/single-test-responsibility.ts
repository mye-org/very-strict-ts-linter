import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";
import { DEFAULT_TEST_PATTERNS } from "../analyzers/module-symbol-graph.js";
import {
  analyzeTestScope,
  DEFAULT_TEST_SCOPE_OPTIONS,
} from "../analyzers/test-scope-analyzer.js";
import { createRule } from "../utils/create-rule.js";
import { isMatchingAnyPattern, normalizeFilePath } from "../utils/program-cache.js";

type Options = [
  Partial<
    Readonly<{
      readonly testPatterns: ReadonlyArray<string>;
      readonly minUnrelatedComponents: number;
    }>
  >,
];

type MessageIds = "multipleTestResponsibilities";

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
          minUnrelatedComponents:
            options.minUnrelatedComponents ?? DEFAULT_TEST_SCOPE_OPTIONS.minUnrelatedComponents,
        });

        const findings = analysis.responsibilityByFile[fileName] ?? [];
        for (const finding of findings) {
          context.report({
            loc: {
              start: { line: finding.line, column: 0 },
              end: { line: finding.line, column: 1 },
            },
            messageId: "multipleTestResponsibilities",
            data: {
              testName: finding.testName,
              groupCount: String(finding.groups.length),
              groups: finding.groups.map((g) => `[${g.join(", ")}]`).join(" | "),
            },
          });
        }
      },
    };
  },
});
