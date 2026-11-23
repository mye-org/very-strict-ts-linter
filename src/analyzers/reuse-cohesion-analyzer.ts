import * as O from "fp-ts/lib/Option.js";
import * as Ord from "fp-ts/lib/Ord.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import * as S from "fp-ts/lib/string.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { normalizeFilePath } from "../lib/source-paths.js";
import {
  analyzeFileCohesion,
  DEFAULT_UBIQUITOUS_TYPES,
  ModuleCohesionOptions,
} from "./module-cohesion-analyzer.js";
import {
  analyzeModuleSymbolGraph,
  DEFAULT_TEST_PATTERNS,
  FileModuleGraph,
  ModuleConsumerRecord,
  ProgramSymbolGraph,
  RuntimeExport,
} from "./module-symbol-graph.js";
import {
  DEFAULT_EFFECT_TYPES,
  DEFAULT_IMPURE_MODULES,
  FilePuritySummary,
  ModulePurityStatus,
  ProgramPurityAnalysis,
  PurityOptions,
} from "./purity-analyzer.js";

export type SingleCallerExportFinding = Readonly<
  Record<"exportName" | "fileName" | "locationKey" | "soleConsumer", string> &
    Record<"line", number> & {
      readonly kind: "singleCallerExport";
    }
>;

export type TestOnlyExportFinding = Readonly<
  Record<"exportName" | "fileName" | "locationKey", string> &
    Record<"line", number> & {
      readonly kind: "testOnlyExport";
      readonly testConsumers: ReadonlyArray<string>;
    }
>;

export type EncapsulationFinding = SingleCallerExportFinding | TestOnlyExportFinding;

export type SingleCallerOptions = Readonly<
  Record<"entryPoints" | "testPatterns", ReadonlyArray<string>> &
    Record<"respectPurityBoundary", true | false> &
    Record<"maxMergedFileLines", number> & {
      readonly purityOptions: PurityOptions;
      readonly cohesionOptions: ModuleCohesionOptions;
    }
>;

export type SingleCallerAnalysis = Readonly<{
  readonly findings: ReadonlyArray<EncapsulationFinding>;
  readonly byFile: Readonly<Record<string, ReadonlyArray<EncapsulationFinding>>>;
}>;

export type ConsumerExportGroup = Readonly<{
  readonly exports: ReadonlyArray<string>;
  readonly consumers: ReadonlyArray<string>;
}>;

export type CommonReuseFinding = Readonly<
  Record<"fileName", string> &
    Record<"exportCount", number> & {
      readonly groups: ReadonlyArray<ConsumerExportGroup>;
    }
>;

export type CommonReuseOptions = Readonly<
  Record<"minExports", number> & {
    readonly testPatterns: ReadonlyArray<string>;
  }
>;

export type CommonReuseAnalysis = Readonly<{
  readonly findings: ReadonlyArray<CommonReuseFinding>;
  readonly byFile: Readonly<Record<string, CommonReuseFinding>>;
}>;

export const DEFAULT_SINGLE_CALLER_OPTIONS: SingleCallerOptions = {
  entryPoints: [],
  testPatterns: DEFAULT_TEST_PATTERNS,
  respectPurityBoundary: true,
  maxMergedFileLines: 300,
  purityOptions: {
    effectTypes: DEFAULT_EFFECT_TYPES,
    impureModules: DEFAULT_IMPURE_MODULES,
    pureModules: [],
  },
  cohesionOptions: {
    ubiquitousTypes: DEFAULT_UBIQUITOUS_TYPES,
    primaryDomainTypes: [],
  },
};

type SingleCallerContext = Readonly<{
  readonly checker: ts.TypeChecker;
  readonly symbolGraph: ProgramSymbolGraph;
  readonly purityAnalysis: ProgramPurityAnalysis;
  readonly sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>;
  readonly options: SingleCallerOptions;
}>;

type ExportEvaluationInput = Readonly<{
  readonly context: SingleCallerContext;
  readonly fileGraph: FileModuleGraph;
  readonly filePurity: O.Option<FilePuritySummary>;
  readonly runtimeExport: RuntimeExport;
}>;

type AdjacencyRecord = Readonly<Record<string, ReadonlyArray<string>>>;

type ReuseGraphContext = Readonly<{
  readonly fileGraph: FileModuleGraph;
  readonly adjacency: AdjacencyRecord;
}>;

type FrontierWalkState = Readonly<{
  readonly pendingExports: ReadonlyArray<string>;
  readonly seenExports: ReadonlySet<string>;
  readonly componentExports: ReadonlyArray<string>;
}>;

type PartitionAccumulator = Readonly<{
  readonly visited: ReadonlySet<string>;
  readonly groups: ReadonlyArray<ConsumerExportGroup>;
}>;

const readRecordValues = <T>(record: Readonly<Record<string, T>>) => Object.values(record);

const clampAtLeastOne = (span: number) => Math.max(1, span);

const measureNodeLineSpan = (sf: ts.SourceFile, decl: ts.Node) =>
  sf.getLineAndCharacterOfPosition(decl.getEnd()).line -
  sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line +
  1;

const pairDeclWithSourceFile = (exp: RuntimeExport) => ({
  decl: exp.declaration,
  sf: exp.declaration.getSourceFile(),
});

const measureExportDeclarationLines = flow(
  pairDeclWithSourceFile,
  ({ sf, decl }) => measureNodeLineSpan(sf, decl),
  clampAtLeastOne,
);

const fallbackModulePurity = (filePurity: FilePuritySummary) =>
  match(filePurity.modulePurity)
    .with("impure", () => "impure" as const)
    .with("pure", "neutral", () => "pure" as const)
    .exhaustive();

const lookupNamedExportPurity = (exp: RuntimeExport, filePurity: FilePuritySummary) =>
  flow(
    (summary: FilePuritySummary) => O.fromNullable(summary.exportPurityByName[exp.exportName]),
    O.alt(() => O.fromNullable(filePurity.exportPurityByName[exp.localName])),
    O.getOrElseW(() => fallbackModulePurity(filePurity)),
  )(filePurity);

const resolveExportPurity = (exp: RuntimeExport, filePurity: O.Option<FilePuritySummary>) =>
  flow(
    O.map((summary: FilePuritySummary) => lookupNamedExportPurity(exp, summary)),
    O.getOrElseW(() => "pure" as const),
  )(filePurity);

const indexSourceFilesByPath = (program: ts.Program) =>
  new Map(
    RA.map((sf: ts.SourceFile) => [normalizeFilePath(sf.fileName), sf] as const)(
      program.getSourceFiles(),
    ),
  );

const lookupConsumerModulePurity = (
  purityAnalysis: ProgramPurityAnalysis,
  consumerFile: string,
) =>
  flow(
    (files: Readonly<Record<string, FilePuritySummary>>) => O.fromNullable(files[consumerFile]),
    O.map((summary) => summary.modulePurity),
  )(purityAnalysis.files);

const isImpureStatus = (status: ModulePurityStatus) => status === "impure";

const isPurityBoundaryRespected = (context: SingleCallerContext) =>
  context.options.respectPurityBoundary;

const isBlockedByPurityBoundary = (input: ExportEvaluationInput, soleConsumer: string) =>
  isPurityBoundaryRespected(input.context) &&
  resolveExportPurity(input.runtimeExport, input.filePurity) === "pure" &&
  O.exists(isImpureStatus)(
    lookupConsumerModulePurity(input.context.purityAnalysis, soleConsumer),
  );

const lookupConsumerLineCount = (symbolGraph: ProgramSymbolGraph, consumerFile: string) =>
  flow(
    (files: Readonly<Record<string, FileModuleGraph>>) => O.fromNullable(files[consumerFile]),
    O.map((fileGraph) => fileGraph.lineCount),
    O.getOrElse(() => 0),
  )(symbolGraph.files);

const readMaxMergedFileLines = (context: SingleCallerContext) =>
  context.options.maxMergedFileLines;

const isBlockedByMergedSize = (input: ExportEvaluationInput, soleConsumer: string) =>
  lookupConsumerLineCount(input.context.symbolGraph, soleConsumer) +
    measureExportDeclarationLines(input.runtimeExport) >
  readMaxMergedFileLines(input.context);

const isTsxPath = (filePath: string) => filePath.endsWith(".tsx");

const isBlockedByViewModelBoundary = (sourceFileName: string, consumerFile: string) =>
  !isTsxPath(sourceFileName) && isTsxPath(consumerFile);

const isBlockedByStaticGuards = (input: ExportEvaluationInput, soleConsumer: string) =>
  isBlockedByPurityBoundary(input, soleConsumer) ||
  isBlockedByMergedSize(input, soleConsumer) ||
  isBlockedByViewModelBoundary(input.fileGraph.fileName, soleConsumer);

const buildTestOnlyFinding = (
  exp: RuntimeExport,
  testConsumers: ReadonlyArray<string>,
) => ({
  kind: "testOnlyExport" as const,
  exportName: exp.exportName,
  fileName: exp.fileName,
  line: exp.line,
  locationKey: exp.locationKey,
  testConsumers,
});

const buildSingleCallerFinding = (exp: RuntimeExport, soleConsumer: string) => ({
  kind: "singleCallerExport" as const,
  exportName: exp.exportName,
  fileName: exp.fileName,
  line: exp.line,
  locationKey: exp.locationKey,
  soleConsumer,
});

const evaluateSoleConsumerCandidate = (input: ExportEvaluationInput, soleConsumer: string) =>
  isBlockedByStaticGuards(input, soleConsumer)
    ? O.none
    : O.some<EncapsulationFinding>(buildSingleCallerFinding(input.runtimeExport, soleConsumer));

const evaluateSingleProdConsumer = (
  input: ExportEvaluationInput,
  prodConsumers: ReadonlyArray<string>,
) =>
  flow(
    RA.head<string>,
    O.flatMap((soleConsumer) => evaluateSoleConsumerCandidate(input, soleConsumer)),
  )(prodConsumers);

const classifyExportConsumers = (
  input: ExportEvaluationInput,
  consumerRec: ModuleConsumerRecord,
) =>
  match({
    prodCount: consumerRec.prodConsumers.length,
    testCount: consumerRec.testConsumers.length,
  })
    .when(
      ({ prodCount, testCount }) => prodCount === 0 && testCount >= 1,
      () => O.some<EncapsulationFinding>(buildTestOnlyFinding(input.runtimeExport, consumerRec.testConsumers)),
    )
    .when(
      ({ prodCount }) => prodCount === 1,
      () => evaluateSingleProdConsumer(input, consumerRec.prodConsumers),
    )
    .otherwise(() => O.none);

const isPublicEntryPointExport = (symbolGraph: ProgramSymbolGraph, exportKey: string) =>
  symbolGraph.publicEntryPointExports.has(exportKey);

const evaluateRuntimeExport = (input: ExportEvaluationInput) =>
  isPublicEntryPointExport(input.context.symbolGraph, input.runtimeExport.key)
    ? O.none
    : flow(
        (consumers: Readonly<Record<string, ModuleConsumerRecord>>) =>
          O.fromNullable(consumers[input.runtimeExport.exportName]),
        O.flatMap((consumerRec) => classifyExportConsumers(input, consumerRec)),
      )(input.fileGraph.consumersByExport);

const isEligibleSingleCallerFile = (fileGraph: FileModuleGraph) =>
  !fileGraph.isBarrel && !fileGraph.isTest && !fileGraph.isEntryPoint;

const lookupFilePurity = (purityAnalysis: ProgramPurityAnalysis, fileName: string) =>
  O.fromNullable(purityAnalysis.files[fileName]);

const collectFileCandidateFindings = (
  context: SingleCallerContext,
  fileGraph: FileModuleGraph,
) =>
  RA.filterMap((runtimeExport: RuntimeExport) =>
    evaluateRuntimeExport({
      context,
      fileGraph,
      filePurity: lookupFilePurity(context.purityAnalysis, fileGraph.fileName),
      runtimeExport,
    }),
  )(fileGraph.runtimeExports);

const isFileNonCohesive = (sf: ts.SourceFile, context: SingleCallerContext) =>
  !analyzeFileCohesion(sf, context.checker, context.options.cohesionOptions).isCohesive;

const isConsumerFileCohesive = (context: SingleCallerContext, consumerFile: string) =>
  !flow(
    (sourceFiles: ReadonlyMap<string, ts.SourceFile>) => sourceFiles.get(consumerFile),
    O.fromNullable,
    O.exists((sf) => isFileNonCohesive(sf, context)),
  )(context.sourceFilesByPath);

const collectSoleConsumerPaths = flow(
  RA.filterMap((finding: EncapsulationFinding) =>
    match(finding)
      .with({ kind: "singleCallerExport" }, (f) => O.some(f.soleConsumer))
      .with({ kind: "testOnlyExport" }, () => O.none)
      .exhaustive(),
  ),
  RA.uniq(S.Eq),
);

const buildCohesiveConsumerSet = (
  context: SingleCallerContext,
  candidates: ReadonlyArray<EncapsulationFinding>,
) =>
  new Set(
    RA.filter((consumerFile: string) => isConsumerFileCohesive(context, consumerFile))(
      collectSoleConsumerPaths(candidates),
    ),
  );

const isSurvivingFinding = (
  cohesiveConsumers: ReadonlySet<string>,
  finding: EncapsulationFinding,
) =>
  match(finding)
    .with({ kind: "testOnlyExport" }, () => true)
    .with({ kind: "singleCallerExport" }, (f) => cohesiveConsumers.has(f.soleConsumer))
    .exhaustive();

const appendFindingByFile = (
  acc: Readonly<Record<string, ReadonlyArray<EncapsulationFinding>>>,
  finding: EncapsulationFinding,
) => ({
  ...acc,
  [finding.fileName]: RA.append(finding)(acc[finding.fileName] ?? []),
});

const filterFindingsByCohesion = (
  cohesiveConsumers: ReadonlySet<string>,
  candidates: ReadonlyArray<EncapsulationFinding>,
) =>
  RA.filter((finding: EncapsulationFinding) => isSurvivingFinding(cohesiveConsumers, finding))(
    candidates,
  );

const finalizeSingleCallerAnalysis = (
  context: SingleCallerContext,
  candidates: ReadonlyArray<EncapsulationFinding>,
) => {
  const findings = filterFindingsByCohesion(
    buildCohesiveConsumerSet(context, candidates),
    candidates,
  );
  return {
    findings,
    byFile: RA.reduce<
      EncapsulationFinding,
      Readonly<Record<string, ReadonlyArray<EncapsulationFinding>>>
    >({}, appendFindingByFile)(findings),
  };
};

const collectAllSingleCallerCandidates = (context: SingleCallerContext) =>
  flow(
    readRecordValues<FileModuleGraph>,
    RA.filter(isEligibleSingleCallerFile),
    RA.flatMap((fileGraph) => collectFileCandidateFindings(context, fileGraph)),
  )(context.symbolGraph.files);

const buildSingleCallerContext = (
  program: ts.Program,
  purityAnalysis: ProgramPurityAnalysis,
  options: SingleCallerOptions,
) => ({
  checker: program.getTypeChecker(),
  symbolGraph: analyzeModuleSymbolGraph(program, options.entryPoints, options.testPatterns),
  purityAnalysis,
  sourceFilesByPath: indexSourceFilesByPath(program),
  options,
});

export const analyzeSingleCallerExports = (
  program: ts.Program,
  purityAnalysis: ProgramPurityAnalysis,
  options: SingleCallerOptions = DEFAULT_SINGLE_CALLER_OPTIONS,
) => {
  const context = buildSingleCallerContext(program, purityAnalysis, options);
  return finalizeSingleCallerAnalysis(context, collectAllSingleCallerCandidates(context));
};

const lookupProdConsumers = (fileGraph: FileModuleGraph, exportName: string) =>
  flow(
    (consumers: Readonly<Record<string, ModuleConsumerRecord>>) =>
      O.fromNullable(consumers[exportName]),
    O.map((rec) => rec.prodConsumers),
    O.getOrElse(() => RA.empty as ReadonlyArray<string>),
  )(fileGraph.consumersByExport);

const collectUsedExports = (fileGraph: FileModuleGraph) =>
  flow(
    RA.map((exp: RuntimeExport) => exp.exportName),
    RA.filter((name: string) => lookupProdConsumers(fileGraph, name).length >= 1),
  )(fileGraph.runtimeExports);

const dropLeadingNames = (count: number) => (names: ReadonlyArray<string>) =>
  RA.dropLeft(count)(names);

const pairWithLaterNames =
  (relevantNames: ReadonlyArray<string>) => (idx: number, left: string) =>
    flow(
      dropLeadingNames(idx + 1),
      RA.flatMap((right: string) => [
        [left, right] as const,
        [right, left] as const,
      ]),
    )(relevantNames);

const collectUndirectedCliqueEdges = (relevantNames: ReadonlyArray<string>) =>
  flow(RA.mapWithIndex(pairWithLaterNames(relevantNames)), RA.flatten)(relevantNames);

const readEdgeSource = (edge: readonly [string, string]) => edge[0];
const readEdgeTarget = (edge: readonly [string, string]) => edge[1];

const groupAdjacencyEdges = flow(
  RNEA.groupBy(readEdgeSource),
  RR.map(RA.map(readEdgeTarget)),
);

const buildReuseAdjacency = (
  fileGraph: FileModuleGraph,
  usedSet: ReadonlySet<string>,
) =>
  flow(
    readRecordValues<ReadonlyArray<string>>,
    RA.map(RA.filter((name: string) => usedSet.has(name))),
    RA.flatMap(collectUndirectedCliqueEdges),
    groupAdjacencyEdges,
  )(fileGraph.prodImportsByConsumer);

const collectUnvisitedNeighbors = (state: FrontierWalkState, adjacency: AdjacencyRecord) =>
  flow(
    RA.flatMap((node: string) => adjacency[node] ?? []),
    RA.filter((neighbor: string) => !state.seenExports.has(neighbor)),
    RA.uniq(S.Eq),
  )(state.pendingExports);

const expandComponentFrontier = (
  state: FrontierWalkState,
  adjacency: AdjacencyRecord,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive graph walk
): FrontierWalkState =>
  state.pendingExports.length === 0
    ? state
    : stepComponentFrontier(
        collectUnvisitedNeighbors(state, adjacency),
        state,
        adjacency,
      );

const stepComponentFrontier = (
  nextFrontier: ReadonlyArray<string>,
  state: FrontierWalkState,
  adjacency: AdjacencyRecord,
) =>
  expandComponentFrontier(
    {
      pendingExports: nextFrontier,
      seenExports: new Set([...state.seenExports, ...nextFrontier]),
      componentExports: [...state.componentExports, ...state.pendingExports],
    },
    adjacency,
  );

const buildConsumerExportGroup = (
  members: ReadonlyArray<string>,
  fileGraph: FileModuleGraph,
) => ({
  exports: RA.sort(S.Ord)(members),
  consumers: flow(
    RA.flatMap((name: string) => lookupProdConsumers(fileGraph, name)),
    RA.uniq(S.Eq),
    RA.sort(S.Ord),
  )(members),
});

const appendSeededComponent = (
  acc: PartitionAccumulator,
  seed: string,
  graphCtx: ReuseGraphContext,
) => {
  const walked = expandComponentFrontier(
    { pendingExports: [seed], seenExports: new Set([...acc.visited, seed]), componentExports: [] },
    graphCtx.adjacency,
  );
  return {
    visited: walked.seenExports,
    groups: RA.append(buildConsumerExportGroup(walked.componentExports, graphCtx.fileGraph))(
      acc.groups,
    ),
  };
};

const stepComponentPartition =
  (graphCtx: ReuseGraphContext) => (acc: PartitionAccumulator, exportName: string) =>
    acc.visited.has(exportName)
      ? acc
      : appendSeededComponent(acc, exportName, graphCtx);

const compareGroupByFirstExport = Ord.contramap(
  (group: ConsumerExportGroup) => group.exports[0] ?? "",
)(S.Ord);

const partitionUsedExports =
  (fileGraph: FileModuleGraph) => (usedExports: ReadonlyArray<string>) =>
    flow(
      RA.reduce<string, PartitionAccumulator>(
        { visited: new Set<string>(), groups: [] },
        stepComponentPartition({
          fileGraph,
          adjacency: buildReuseAdjacency(fileGraph, new Set(usedExports)),
        }),
      ),
      (result) => RA.sort(compareGroupByFirstExport)(result.groups),
    )(usedExports);

const evaluateFileCommonReuse = (fileGraph: FileModuleGraph, minExports: number) =>
  fileGraph.isBarrel || fileGraph.isTest || fileGraph.runtimeExports.length <= minExports
    ? O.none
    : evaluateUsedExportGroups(fileGraph, collectUsedExports(fileGraph));

const evaluateUsedExportGroups = (
  fileGraph: FileModuleGraph,
  usedExports: ReadonlyArray<string>,
) =>
  RA.size(usedExports) <= 1
    ? O.none
    : flow(
        partitionUsedExports(fileGraph),
        O.fromPredicate((groups) => groups.length > 1),
        O.map((groups) => ({
          fileName: fileGraph.fileName,
          exportCount: fileGraph.runtimeExports.length,
          groups,
        })),
      )(usedExports);

const indexCommonReuseByFile = RA.reduce<
  CommonReuseFinding,
  Readonly<Record<string, CommonReuseFinding>>
>({}, (acc, finding) => ({
  ...acc,
  [finding.fileName]: finding,
}));

export const analyzeCommonReuseCohesion = (
  program: ts.Program,
  options: CommonReuseOptions = {
    minExports: 5,
    testPatterns: DEFAULT_TEST_PATTERNS,
  },
) => {
  const findings = flow(
    (graph: ProgramSymbolGraph) => readRecordValues(graph.files),
    RA.filterMap((fileGraph) => evaluateFileCommonReuse(fileGraph, options.minExports)),
  )(analyzeModuleSymbolGraph(program, [], options.testPatterns));
  return {
    findings,
    byFile: indexCommonReuseByFile(findings),
  };
};
