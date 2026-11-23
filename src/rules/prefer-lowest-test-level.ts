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
      readonly minDelegatedCases: number;
    }>
  >,
];

type MessageIds = "preferLowestTestLevel";

export const preferLowestTestLevel = createRule<Options, MessageIds>({
  name: "prefer-lowest-test-level",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Enforce testing correctness properties at the lowest sufficient architectural boundary by flagging repeated verification of an untested exported lower-level component exclusively through a higher-level orchestrator.",
    },
    messages: {
      preferLowestTestLevel:
        "[TESTSCOPE-002] Test '{{testName}}' verifies '{{property}}' owned by lower-level exported component '{{lowerComponent}}' indirectly through '{{higherComponent}}' ({{caseCount}} delegated cases, 0 direct unit tests on '{{lowerComponent}}'). Move behavioral cases to direct unit tests on '{{lowerComponent}}' and keep a minimal composition test on '{{higherComponent}}'.",
    },
    schema: [
      {
        type: "object",
        properties: {
          testPatterns: { type: "array", items: { type: "string" } },
          minDelegatedCases: { type: "number", minimum: 1 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        testPatterns: [...DEFAULT_TEST_PATTERNS],
        minDelegatedCases: DEFAULT_TEST_SCOPE_OPTIONS.minDelegatedCases,
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
          minDelegatedCases:
            options.minDelegatedCases ?? DEFAULT_TEST_SCOPE_OPTIONS.minDelegatedCases,
        });

        const findings = analysis.lowestLevelByFile[fileName] ?? [];
        for (const finding of findings) {
          context.report({
            loc: {
              start: { line: finding.line, column: 0 },
              end: { line: finding.line, column: 1 },
            },
            messageId: "preferLowestTestLevel",
            data: {
              testName: finding.testName,
              property: finding.property,
              lowerComponent: finding.lowerComponent,
              higherComponent: finding.higherComponent,
              caseCount: String(finding.caseCount),
            },
          });
        }
      },
    };
  },
});
