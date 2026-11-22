import path from "node:path";
import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";
import { DEFAULT_UBIQUITOUS_TYPES } from "../analyzers/module-cohesion-analyzer.js";
import { DEFAULT_TEST_PATTERNS } from "../analyzers/module-symbol-graph.js";
import { DEFAULT_EFFECT_TYPES, DEFAULT_IMPURE_MODULES } from "../analyzers/purity-analyzer.js";
import { analyzeSingleCallerExports } from "../analyzers/reuse-cohesion-analyzer.js";
import { createRule } from "../utils/create-rule.js";
import { normalizeFilePath } from "../utils/program-cache.js";

// eslint-disable-next-line strict-fp/prefer-union-over-boolean -- ESLint rule JSON schema boolean option
type RespectPurityFlag = boolean;

type Options = [
  Partial<
    Readonly<{
      readonly entryPoints: ReadonlyArray<string>;
      readonly testPatterns: ReadonlyArray<string>;
      readonly respectPurityBoundary: RespectPurityFlag;
      readonly maxMergedFileLines: number;
      readonly effectTypes: ReadonlyArray<string>;
      readonly impureModules: ReadonlyArray<string>;
      readonly pureModules: ReadonlyArray<string>;
      readonly ubiquitousTypes: ReadonlyArray<string>;
      readonly primaryDomainTypes: ReadonlyArray<string>;
    }>
  >,
];

type MessageIds = "singleCallerExport" | "testOnlyExport";

const formatRelativePath = (cwd: string, filePath: string) => {
  const rel = normalizeFilePath(path.relative(cwd, filePath));
  return rel.length > 0 && !rel.startsWith("..") ? rel : filePath;
};

export const noSingleCallerExport = createRule<Options, MessageIds>({
  name: "no-single-caller-export",
  meta: {
    type: "problem",
    docs: {
      description:
        "Prevent over-fragmentation and encapsulation leaks by flagging runtime exports consumed by only one production file or only by tests, with deadlock guards for purity boundaries, file size, cohesion, and configured entry points.",
    },
    messages: {
      singleCallerExport:
        "Runtime export '{{name}}' is only imported by one production file ('{{consumer}}'). Fold it into '{{consumer}}' as an unexported helper, or configure 'entryPoints' if it is a public API.",
      testOnlyExport:
        "Runtime export '{{name}}' has no production callers and is only imported by tests ({{testFiles}}). Make it private and test it through the module's public boundary.",
    },
    schema: [
      {
        type: "object",
        properties: {
          entryPoints: { type: "array", items: { type: "string" } },
          testPatterns: { type: "array", items: { type: "string" } },
          respectPurityBoundary: { type: "boolean" },
          maxMergedFileLines: { type: "number", minimum: 1 },
          effectTypes: { type: "array", items: { type: "string" } },
          impureModules: { type: "array", items: { type: "string" } },
          pureModules: { type: "array", items: { type: "string" } },
          ubiquitousTypes: { type: "array", items: { type: "string" } },
          primaryDomainTypes: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        entryPoints: [],
        testPatterns: [...DEFAULT_TEST_PATTERNS],
        respectPurityBoundary: true,
        maxMergedFileLines: 300,
        effectTypes: [...DEFAULT_EFFECT_TYPES],
        impureModules: [...DEFAULT_IMPURE_MODULES],
        pureModules: [],
        ubiquitousTypes: [...DEFAULT_UBIQUITOUS_TYPES],
        primaryDomainTypes: [],
      },
    ],
  },
  create: (context, [options]) => {
    const services = ESLintUtils.getParserServices(context);

    return {
      Program: (programNode: TSESTree.Program) => {
        const sf = services.esTreeNodeToTSNodeMap.get(programNode);
        const fileName = normalizeFilePath(sf.fileName);
        const analysis = analyzeSingleCallerExports(services.program, {
          entryPoints: options.entryPoints ?? [],
          testPatterns: options.testPatterns ?? DEFAULT_TEST_PATTERNS,
          respectPurityBoundary: options.respectPurityBoundary ?? true,
          maxMergedFileLines: options.maxMergedFileLines ?? 300,
          purityOptions: {
            effectTypes: options.effectTypes ?? DEFAULT_EFFECT_TYPES,
            impureModules: options.impureModules ?? DEFAULT_IMPURE_MODULES,
            pureModules: options.pureModules ?? [],
          },
          cohesionOptions: {
            ubiquitousTypes: options.ubiquitousTypes ?? DEFAULT_UBIQUITOUS_TYPES,
            primaryDomainTypes: options.primaryDomainTypes ?? [],
          },
        });

        const fileFindings = analysis.byFile[fileName] ?? [];
        for (const finding of fileFindings) {
          const line = finding.line;
          const loc = {
            start: { line, column: 0 },
            end: { line, column: 1 },
          };
          if (finding.kind === "singleCallerExport") {
            context.report({
              loc,
              messageId: "singleCallerExport",
              data: {
                name: finding.exportName,
                consumer: formatRelativePath(context.cwd, finding.soleConsumer),
              },
            });
          } else {
            context.report({
              loc,
              messageId: "testOnlyExport",
              data: {
                name: finding.exportName,
                testFiles: finding.testConsumers
                  .map((f) => formatRelativePath(context.cwd, f))
                  .join(", "),
              },
            });
          }
        }
      },
    };
  },
});
