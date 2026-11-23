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
import {
  analyzeProgramPurity,
  DEFAULT_EFFECT_TYPES,
  DEFAULT_IMPURE_MODULES,
  FilePuritySummary,
  FunctionPurityInfo,
  PurityOptions,
} from "../analyzers/purity-analyzer.js";
import { createRule } from "../lib/rule-factory.js";
import { normalizeFilePath } from "../lib/source-paths.js";

type ComplexityLimits = Readonly<
  Record<"maxImpureComplexity" | "maxPrivatePureHelperComplexity", number>
>;

type Options = [Partial<Readonly<PurityOptions & ComplexityLimits>>];

type MessageIds =
  | "mixedPurityExports"
  | "impureShellTooComplex"
  | "privatePureHelperTooComplex";

type ReportFn = (d: TSESLint.ReportDescriptor<MessageIds>) => void;
type ProgramPurityContext = Readonly<{
  readonly programNode: TSESTree.Program;
  readonly summary: FilePuritySummary;
}>;

const formatImpureExportSummary = (fn: FunctionPurityInfo) =>
  fn.reasons.length > 0 ? `${fn.name} (${fn.reasons.slice(0, 2).join(", ")})` : fn.name;

const joinComma = (items: ReadonlyArray<string>) => items.join(", ");

const formatPureExports = flow(
  RA.map((fn: FunctionPurityInfo) => fn.name),
  joinComma,
);

const formatImpureExports = flow(
  RA.map(formatImpureExportSummary),
  joinComma,
);

const formatMixedExportsPayload = (summary: FilePuritySummary) => ({
  pureExports: formatPureExports(summary.pureExportedFunctions),
  impureExports: formatImpureExports(summary.impureExportedFunctions),
});

const formatImpureShellPayload = (fn: FunctionPurityInfo, maxImpure: number) => ({
  name: fn.name,
  actual: String(fn.complexity),
  max: String(maxImpure),
  reasons: fn.reasons.slice(0, 3).join(", "),
});

const formatPrivateHelperPayload = (fn: FunctionPurityInfo, maxPrivate: number) => ({
  name: fn.name,
  actual: String(fn.complexity),
  max: String(maxPrivate),
});

const resolvePurityOptions = (options: Options[0]) => ({
  effectTypes: options.effectTypes ?? DEFAULT_EFFECT_TYPES,
  impureModules: options.impureModules ?? DEFAULT_IMPURE_MODULES,
  pureModules: options.pureModules ?? [],
});

const resolveComplexityLimits = (options: Options[0]) => ({
  maxImpureComplexity: options.maxImpureComplexity ?? 5,
  maxPrivatePureHelperComplexity: options.maxPrivatePureHelperComplexity ?? 6,
});

const resolveModuleScope = (summary: FilePuritySummary) =>
  summary.impureExportedFunctions.length > 0 ? ("impure-module" as const) : ("pure-module" as const);

const hasMixedPurityExports = (summary: FilePuritySummary) =>
  summary.pureExportedFunctions.length > 0 && summary.impureExportedFunctions.length > 0;

const reportMixedExports = (ctx: ProgramPurityContext, report: ReportFn) => {
  match(hasMixedPurityExports(ctx.summary))
    .with(true, () => {
      report({
        node: ctx.programNode,
        messageId: "mixedPurityExports",
        data: formatMixedExportsPayload(ctx.summary),
      });
    })
    .with(false, () => {})
    .exhaustive();
};

const resolveFunctionViolation = (
  fn: FunctionPurityInfo,
  summary: FilePuritySummary,
  limits: ComplexityLimits,
) =>
  match({
    purity: fn.purity,
    exceedsImpure: fn.complexity > limits.maxImpureComplexity,
    moduleScope: resolveModuleScope(summary),
    isExported: fn.isExported,
    exceedsPrivate: fn.complexity > limits.maxPrivatePureHelperComplexity,
  })
    .with({ purity: "impure", exceedsImpure: true }, () =>
      O.some({ messageId: "impureShellTooComplex" as const, data: formatImpureShellPayload(fn, limits.maxImpureComplexity) }),
    )
    .with({ purity: "pure", moduleScope: "impure-module", isExported: false, exceedsPrivate: true }, () =>
      O.some({ messageId: "privatePureHelperTooComplex" as const, data: formatPrivateHelperPayload(fn, limits.maxPrivatePureHelperComplexity) }),
    )
    .otherwise(() => O.none);

const reportFunctionViolation = (
  violation: O.Option<Readonly<{ readonly messageId: MessageIds; readonly data: Readonly<Record<string, string>> }>>,
  esNode: TSESTree.Node,
  report: ReportFn,
) => {
  O.map((v: Readonly<{ readonly messageId: MessageIds; readonly data: Readonly<Record<string, string>> }>) => {
    report({ node: esNode, ...v });
  })(violation);
};

const resolveReportNode = (
  fn: FunctionPurityInfo,
  programNode: TSESTree.Program,
  services: ParserServicesWithTypeInformation,
) =>
  flow(
    (f: FunctionPurityInfo) => services.tsNodeToESTreeNodeMap.get(f.reportNode),
    O.fromNullable,
    O.getOrElse(() => programNode as TSESTree.Node),
  )(fn);

const inspectFileFunctions = (
  ctx: ProgramPurityContext,
  services: ParserServicesWithTypeInformation,
  limits: ComplexityLimits,
  report: ReportFn,
) => {
  RA.map((fn: FunctionPurityInfo) => {
    match(fn.isNested)
      .with(true, () => {})
      .with(false, () => {
        reportFunctionViolation(
          resolveFunctionViolation(fn, ctx.summary, limits),
          resolveReportNode(fn, ctx.programNode, services),
          report,
        );
      })
      .exhaustive();
  })(ctx.summary.functions);
};

const inspectFileSummary = (
  ctx: ProgramPurityContext,
  services: ParserServicesWithTypeInformation,
  limits: ComplexityLimits,
  report: ReportFn,
) => {
  match(ctx.summary.isBarrel)
    .with(true, () => {})
    .with(false, () => {
      reportMixedExports(ctx, report);
      inspectFileFunctions(ctx, services, limits, report);
    })
    .exhaustive();
};

const lookupFileSummary = (
  programNode: TSESTree.Program,
  services: ParserServicesWithTypeInformation,
  options: Options[0],
) =>
  O.fromNullable(
    analyzeProgramPurity(services.program, resolvePurityOptions(options)).files[
      normalizeFilePath(services.esTreeNodeToTSNodeMap.get(programNode).fileName)
    ],
  );

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
  create: (context, [options]) => ({
    Program: (programNode: TSESTree.Program) => {
      const services = ESLintUtils.getParserServices(context);
      O.map((summary: FilePuritySummary) => {
        inspectFileSummary({ programNode, summary }, services, resolveComplexityLimits(options), (d) => { context.report(d); });
      })(lookupFileSummary(programNode, services, options));
    },
  }),
});
