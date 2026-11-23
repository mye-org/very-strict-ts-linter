import path from "node:path";
import {
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { DEFAULT_UBIQUITOUS_TYPES } from "../analyzers/module-cohesion-analyzer.js";
import { DEFAULT_TEST_PATTERNS } from "../analyzers/module-symbol-graph.js";
import {
  analyzeProgramPurity,
  DEFAULT_EFFECT_TYPES,
  DEFAULT_IMPURE_MODULES,
} from "../analyzers/purity-analyzer.js";
import {
  analyzeSingleCallerExports,
  EncapsulationFinding,
  SingleCallerAnalysis,
  SingleCallerOptions,
} from "../analyzers/reuse-cohesion-analyzer.js";
import { memoizeByProgramAndKey } from "../lib/program-memo.js";
import { createRule } from "../lib/rule-factory.js";
import { normalizeFilePath } from "../lib/source-paths.js";

// eslint-disable-next-line strict-fp/prefer-union-over-boolean -- ESLint rule JSON schema boolean option
type RespectPurityFlag = boolean;

type StringArrayOptionKey =
  | "entryPoints"
  | "testPatterns"
  | "effectTypes"
  | "impureModules"
  | "pureModules"
  | "ubiquitousTypes"
  | "primaryDomainTypes";

type Options = [
  Partial<
    Readonly<Record<StringArrayOptionKey, ReadonlyArray<string>>> &
      Readonly<Record<"maxMergedFileLines", number>> &
      Readonly<{ readonly respectPurityBoundary: RespectPurityFlag }>
  >,
];

type MessageIds = "singleCallerExport" | "testOnlyExport";

const isWithinWorkingDirectory = (rel: string) => rel !== "" && !rel.startsWith("..");

const formatRelativePath = (cwd: string, filePath: string) => {
  const rel = normalizeFilePath(path.relative(cwd, filePath));
  return isWithinWorkingDirectory(rel) ? rel : filePath;
};

const formatRelativeList = (cwd: string, files: ReadonlyArray<string>) =>
  RA.map((f: string) => formatRelativePath(cwd, f))(files).join(", ");

const toLineLoc = (line: number) => ({
  start: { line, column: 0 },
  end: { line, column: 1 },
});

const toSingleCallerDescriptor = (
  cwd: string,
  f: Extract<EncapsulationFinding, { readonly kind: "singleCallerExport" }>,
) => ({
  loc: toLineLoc(f.line),
  messageId: "singleCallerExport" as const,
  data: {
    name: f.exportName,
    consumer: formatRelativePath(cwd, f.soleConsumer),
  },
});

const toTestOnlyDescriptor = (
  cwd: string,
  f: Extract<EncapsulationFinding, { readonly kind: "testOnlyExport" }>,
) => ({
  loc: toLineLoc(f.line),
  messageId: "testOnlyExport" as const,
  data: {
    name: f.exportName,
    testFiles: formatRelativeList(cwd, f.testConsumers),
  },
});

const reportEncapsulationFinding = (
  cwd: string,
  finding: EncapsulationFinding,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(finding)
    .with({ kind: "singleCallerExport" }, (f) => { report(toSingleCallerDescriptor(cwd, f)); })
    .with({ kind: "testOnlyExport" }, (f) => { report(toTestOnlyDescriptor(cwd, f)); })
    .exhaustive();
};

const resolveAnalyzerOptions = (options: Options[0]) => ({
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

const resolveProgramFileName = (
  programNode: TSESTree.Program,
  services: ParserServicesWithTypeInformation,
) => normalizeFilePath(services.esTreeNodeToTSNodeMap.get(programNode).fileName);

const singleCallerCache = new WeakMap<
  ts.Program,
  Readonly<Record<string, SingleCallerAnalysis>>
>();

const joinStrings = (items: ReadonlyArray<string>) => items.join(",");
const joinSections = (parts: ReadonlyArray<string>) => parts.join("||");
const formatPurityFlag = (val: RespectPurityFlag) => String(val);
const formatCount = (val: number) => String(val);

const serializeSingleCallerOptions = (options: SingleCallerOptions) =>
  joinSections([
    joinStrings(options.entryPoints),
    joinStrings(options.testPatterns),
    formatPurityFlag(options.respectPurityBoundary),
    formatCount(options.maxMergedFileLines),
    joinStrings(options.purityOptions.effectTypes),
    joinStrings(options.purityOptions.impureModules),
    joinStrings(options.purityOptions.pureModules),
    joinStrings(options.cohesionOptions.ubiquitousTypes),
    joinStrings(options.cohesionOptions.primaryDomainTypes),
  ]);

const computeSingleCaller = (program: ts.Program, resolved: SingleCallerOptions) =>
  analyzeSingleCallerExports(
    program,
    analyzeProgramPurity(program, resolved.purityOptions),
    resolved,
  );

const runCachedSingleCallerAnalysis = (
  program: ts.Program,
  resolved: SingleCallerOptions,
) =>
  memoizeByProgramAndKey(
    program,
    serializeSingleCallerOptions(resolved),
    singleCallerCache,
    (p) => computeSingleCaller(p, resolved),
  );

const checkProgram = (
  programNode: TSESTree.Program,
  options: Options[0],
  cwd: string,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  RA.map((finding: EncapsulationFinding) => {
    reportEncapsulationFinding(cwd, finding, report);
  })(
    runCachedSingleCallerAnalysis(services.program, resolveAnalyzerOptions(options)).byFile[
      resolveProgramFileName(programNode, services)
    ] ?? [],
  );
};

const buildSingleCallerListeners = (
  options: Options[0],
  cwd: string,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => ({
  Program: (programNode: TSESTree.Program) => {
    checkProgram(programNode, options, cwd, services, report);
  },
});

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
  create: (context, [options]) =>
    buildSingleCallerListeners(options, context.cwd, ESLintUtils.getParserServices(context), (d) => {
      context.report(d);
    }),
});
