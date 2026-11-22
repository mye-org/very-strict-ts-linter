import path from "node:path";
import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";
import { DEFAULT_TEST_PATTERNS } from "../analyzers/module-symbol-graph.js";
import { analyzeCommonReuseCohesion, ConsumerExportGroup } from "../analyzers/reuse-cohesion-analyzer.js";
import { createRule } from "../utils/create-rule.js";
import { normalizeFilePath } from "../utils/program-cache.js";

type Options = [
  Partial<
    Readonly<{
      readonly minExports: number;
      readonly testPatterns: ReadonlyArray<string>;
    }>
  >,
];

type MessageIds = "disjointConsumerGroups";

const formatRelativePath = (cwd: string, filePath: string) => {
  const rel = normalizeFilePath(path.relative(cwd, filePath));
  return rel.length > 0 && !rel.startsWith("..") ? rel : filePath;
};

const formatGroup = (group: ConsumerExportGroup, index: number, cwd: string) => {
  const consumers = group.consumers.map((c) => formatRelativePath(cwd, c)).join(", ");
  return `Group ${String(index + 1)} [${group.exports.join(", ")}] -> ${consumers}`;
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
  create: (context, [options]) => {
    const services = ESLintUtils.getParserServices(context);
    const resolvedOptions = {
      minExports: options.minExports ?? 5,
      testPatterns: options.testPatterns ?? DEFAULT_TEST_PATTERNS,
    };

    return {
      Program: (programNode: TSESTree.Program) => {
        const sf = services.esTreeNodeToTSNodeMap.get(programNode);
        const fileName = normalizeFilePath(sf.fileName);
        const analysis = analyzeCommonReuseCohesion(services.program, resolvedOptions);
        const finding = analysis.byFile[fileName];
        if (!finding) return;

        context.report({
          node: programNode,
          messageId: "disjointConsumerGroups",
          data: {
            exportCount: String(finding.exportCount),
            groupCount: String(finding.groups.length),
            groups: finding.groups
              .map((g, idx) => formatGroup(g, idx, context.cwd))
              .join(" | "),
          },
        });
      },
    };
  },
});
