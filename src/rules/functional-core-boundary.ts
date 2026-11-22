import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";
import {
  analyzeProgramPurity,
  DEFAULT_EFFECT_TYPES,
  DEFAULT_IMPURE_MODULES,
  FunctionPurityInfo,
} from "../analyzers/purity-analyzer.js";
import { createRule } from "../utils/create-rule.js";
import { normalizeFilePath } from "../utils/program-cache.js";

type Options = [
  Partial<
    Readonly<{
      readonly maxImpureComplexity: number;
      readonly maxPrivatePureHelperComplexity: number;
      readonly effectTypes: ReadonlyArray<string>;
      readonly impureModules: ReadonlyArray<string>;
      readonly pureModules: ReadonlyArray<string>;
    }>
  >,
];

type MessageIds =
  | "mixedPurityExports"
  | "impureShellTooComplex"
  | "privatePureHelperTooComplex";

const formatImpureExportSummary = (fn: FunctionPurityInfo) =>
  fn.reasons.length > 0 ? `${fn.name} (${fn.reasons.slice(0, 2).join(", ")})` : fn.name;

export const functionalCoreBoundary = createRule<Options, MessageIds>({
  name: "functional-core-boundary",
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce Functional Core / Imperative Shell boundaries: disallow mixing pure and impure function exports, cap cyclomatic complexity of impure shells, and keep private pure helpers in impure modules thin.",
    },
    messages: {
      mixedPurityExports:
        "Module mixes pure exports ({{pureExports}}) with impure exports ({{impureExports}}). Separate pure domain logic from the imperative shell.",
      impureShellTooComplex:
        "Impure function '{{name}}' has cyclomatic complexity {{actual}} (max {{max}}; impure due to: {{reasons}}). Extract branching/logic into pure functions.",
      privatePureHelperTooComplex:
        "Private pure helper '{{name}}' in an impure module has cyclomatic complexity {{actual}} (max {{max}}). Extract it into a dedicated pure module.",
    },
    schema: [
      {
        type: "object",
        properties: {
          maxImpureComplexity: { type: "number", minimum: 1 },
          maxPrivatePureHelperComplexity: { type: "number", minimum: 1 },
          effectTypes: { type: "array", items: { type: "string" } },
          impureModules: { type: "array", items: { type: "string" } },
          pureModules: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        maxImpureComplexity: 5,
        maxPrivatePureHelperComplexity: 6,
        effectTypes: [...DEFAULT_EFFECT_TYPES],
        impureModules: [...DEFAULT_IMPURE_MODULES],
        pureModules: [],
      },
    ],
  },
  create: (context, [options]) => {
    const services = ESLintUtils.getParserServices(context);
    const maxImpureComplexity = options.maxImpureComplexity ?? 5;
    const maxPrivatePureHelperComplexity = options.maxPrivatePureHelperComplexity ?? 6;
    const effectTypes = options.effectTypes ?? DEFAULT_EFFECT_TYPES;
    const impureModules = options.impureModules ?? DEFAULT_IMPURE_MODULES;
    const pureModules = options.pureModules ?? [];

    return {
      Program: (programNode: TSESTree.Program) => {
        const sf = services.esTreeNodeToTSNodeMap.get(programNode);
        const fileName = normalizeFilePath(sf.fileName);
        const analysis = analyzeProgramPurity(services.program, {
          effectTypes,
          impureModules,
          pureModules,
        });
        const fileSummary = analysis.files[fileName];
        if (!fileSummary || fileSummary.isBarrel) return;

        // Sub-check 1: Export Purity Homogeneity
        if (
          fileSummary.pureExportedFunctions.length > 0 &&
          fileSummary.impureExportedFunctions.length > 0
        ) {
          context.report({
            node: programNode,
            messageId: "mixedPurityExports",
            data: {
              pureExports: fileSummary.pureExportedFunctions.map((f) => f.name).join(", "),
              impureExports: fileSummary.impureExportedFunctions
                .map(formatImpureExportSummary)
                .join(", "),
            },
          });
        }

        const isImpureModule = fileSummary.impureExportedFunctions.length > 0;

        // Sub-check 2 & 3: Thin Imperative Shell + Private Pure Helper Complexity Cap
        for (const fn of fileSummary.functions) {
          if (fn.isNested) continue;
          const esNode = services.tsNodeToESTreeNodeMap.get(fn.reportNode) ?? programNode;

          if (fn.purity === "impure" && fn.complexity > maxImpureComplexity) {
            context.report({
              node: esNode,
              messageId: "impureShellTooComplex",
              data: {
                name: fn.name,
                actual: String(fn.complexity),
                max: String(maxImpureComplexity),
                reasons: fn.reasons.slice(0, 3).join(", "),
              },
            });
          } else if (
            isImpureModule &&
            !fn.isExported &&
            fn.purity === "pure" &&
            fn.complexity > maxPrivatePureHelperComplexity
          ) {
            context.report({
              node: esNode,
              messageId: "privatePureHelperTooComplex",
              data: {
                name: fn.name,
                actual: String(fn.complexity),
                max: String(maxPrivatePureHelperComplexity),
              },
            });
          }
        }
      },
    };
  },
});
