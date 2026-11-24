/* eslint-disable strict-fp/functional-core-boundary -- both exports are pure program analyzers; collectTsNodes uses an internal O(n) accumulator */
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

type PurityProvider = ProgramPurityAnalysis | (() => ProgramPurityAnalysis);

type SingleCallerContext = Readonly<{
  readonly checker: ts.TypeChecker;
  readonly symbolGraph: ProgramSymbolGraph;
  readonly getPurityAnalysis: () => ProgramPurityAnalysis;
  readonly sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>;
  readonly options: SingleCallerOptions;
}>;

type ExportEvaluationInput = Readonly<{
  readonly context: SingleCallerContext;
  readonly fileGraph: FileModuleGraph;
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

const resolveExportPurityByName = (exp: RuntimeExport, filePurity: FilePuritySummary) =>
  flow(
    (summary: FilePuritySummary) => O.fromNullable(summary.exportPurityByName[exp.exportName]),
    O.alt(() => O.fromNullable(filePurity.exportPurityByName[exp.localName])),
    O.getOrElseW(() => fallbackModulePurity(filePurity)),
  );

const resolveExportPurity = (exp: RuntimeExport, filePurity: O.Option<FilePuritySummary>) =>
  O.getOrElseW(() => "pure" as const)(
    O.map((summary: FilePuritySummary) => resolveExportPurityByName(exp, summary)(summary))(
      filePurity,
    ),
  );

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
  O.map((summary: FilePuritySummary) => summary.modulePurity)(
    O.fromNullable(purityAnalysis.files[consumerFile]),
  );

const isImpureStatus = (status: ModulePurityStatus) => status === "impure";

const isPurityBoundaryRespected = (context: SingleCallerContext) =>
  context.options.respectPurityBoundary;

const isPureExportConsumedByImpureModule = (
  input: ExportEvaluationInput,
  soleConsumer: string,
) => {
  const purityAnalysis = input.context.getPurityAnalysis();
  return (
    resolveExportPurity(
      input.runtimeExport,
      O.fromNullable(purityAnalysis.files[input.fileGraph.fileName]),
    ) === "pure" &&
    O.exists(isImpureStatus)(lookupConsumerModulePurity(purityAnalysis, soleConsumer))
  );
};

const isBlockedByPurityBoundary = (input: ExportEvaluationInput, soleConsumer: string) =>
  isPurityBoundaryRespected(input.context) &&
  isPureExportConsumedByImpureModule(input, soleConsumer);

const readFileLineCount = (consumerFile: string) =>
  flow(
    (files: Readonly<Record<string, FileModuleGraph>>) => O.fromNullable(files[consumerFile]),
    O.map((fileGraph: FileModuleGraph) => fileGraph.lineCount),
    O.getOrElse(() => 0),
  );

const lookupConsumerLineCount = (symbolGraph: ProgramSymbolGraph, consumerFile: string) =>
  readFileLineCount(consumerFile)(symbolGraph.files);

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
  isBlockedByMergedSize(input, soleConsumer) ||
  isBlockedByViewModelBoundary(input.fileGraph.fileName, soleConsumer) ||
  isBlockedByPurityBoundary(input, soleConsumer);

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
  O.flatMap((soleConsumer: string) => evaluateSoleConsumerCandidate(input, soleConsumer))(
    RA.head<string>(prodConsumers),
  );

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

const evaluateRuntimeExport = ({ context, fileGraph, runtimeExport }: ExportEvaluationInput) =>
  isPublicEntryPointExport(context.symbolGraph, runtimeExport.key)
    ? O.none
    : O.flatMap((consumerRec: ModuleConsumerRecord) =>
        classifyExportConsumers({ context, fileGraph, runtimeExport }, consumerRec),
      )(O.fromNullable(fileGraph.consumersByExport[runtimeExport.exportName]));

const isEligibleSingleCallerFile = (fileGraph: FileModuleGraph) =>
  !fileGraph.isBarrel && !fileGraph.isTest && !fileGraph.isEntryPoint;

const collectFileCandidateFindings = (
  context: SingleCallerContext,
  fileGraph: FileModuleGraph,
) =>
  RA.filterMap((runtimeExport: RuntimeExport) =>
    evaluateRuntimeExport({
      context,
      fileGraph,
      runtimeExport,
    }),
  )(fileGraph.runtimeExports);

const isFileNonCohesive = (sf: ts.SourceFile, context: SingleCallerContext) =>
  !analyzeFileCohesion(sf, {
    checker: context.checker,
    options: O.some(context.options.cohesionOptions),
  }).isCohesive;

const isConsumerFileCohesive = (context: SingleCallerContext) =>
  flow(
    (consumerFile: string) => context.sourceFilesByPath.get(consumerFile),
    O.fromNullable,
    O.filter((sf: ts.SourceFile) => isFileNonCohesive(sf, context)),
    O.isNone,
  );

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
    RA.filter(isConsumerFileCohesive(context))(collectSoleConsumerPaths(candidates)),
  );

const isSurvivingFinding = (
  cohesiveConsumers: ReadonlySet<string>,
  finding: EncapsulationFinding,
) =>
  match(finding)
    .with({ kind: "testOnlyExport" }, () => true)
    .with({ kind: "singleCallerExport" }, (f) => cohesiveConsumers.has(f.soleConsumer))
    .exhaustive();

const lookupFindingsForFile = (
  fileName: string,
  acc: Readonly<Record<string, ReadonlyArray<EncapsulationFinding>>>,
) => O.getOrElseW(() => [])(RR.lookup(fileName, acc));

const appendFindingByFile = (
  acc: Readonly<Record<string, ReadonlyArray<EncapsulationFinding>>>,
  finding: EncapsulationFinding,
) => ({
  ...acc,
  [finding.fileName]: RA.append(finding)(lookupFindingsForFile(finding.fileName, acc)),
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

const collectEligibleFileCandidates = (context: SingleCallerContext) =>
  flow(
    readRecordValues<FileModuleGraph>,
    RA.filter(isEligibleSingleCallerFile),
    RA.flatMap((fileGraph: FileModuleGraph) => collectFileCandidateFindings(context, fileGraph)),
  );

const collectAllSingleCallerCandidates = (context: SingleCallerContext) =>
  collectEligibleFileCandidates(context)(context.symbolGraph.files);

const toPurityGetter = (purityAnalysis: PurityProvider) =>
  typeof purityAnalysis === "function" ? purityAnalysis : () => purityAnalysis;

type SingleCallerConfig = Readonly<{
  purityAnalysis: PurityProvider;
  options: O.Option<SingleCallerOptions>;
}>;

const buildSingleCallerContext = (program: ts.Program, config: SingleCallerConfig) => {
  const options = O.getOrElse(() => DEFAULT_SINGLE_CALLER_OPTIONS)(config.options);
  return {
    checker: program.getTypeChecker(),
    symbolGraph: analyzeModuleSymbolGraph(program, {
      entryPointPatterns: options.entryPoints,
      testFilePatterns: options.testPatterns,
    }),
    getPurityAnalysis: toPurityGetter(config.purityAnalysis),
    sourceFilesByPath: indexSourceFilesByPath(program),
    options,
  };
};

// eslint-disable-next-line strict-fp/no-single-caller-export -- analyzer entry point consumed by rule and tests
export const analyzeSingleCallerExports = ((
  program: ts.Program,
  config: SingleCallerConfig,
) => {
  const context = buildSingleCallerContext(program, config);
  return finalizeSingleCallerAnalysis(context, collectAllSingleCallerCandidates(context));
}) satisfies (program: ts.Program, config: SingleCallerConfig) => SingleCallerAnalysis;

const readProdConsumersForExport = (exportName: string) =>
  flow(
    (consumers: Readonly<Record<string, ModuleConsumerRecord>>) =>
      O.fromNullable(consumers[exportName]),
    O.map((rec: ModuleConsumerRecord) => rec.prodConsumers),
    O.getOrElseW(() => []),
  );

const lookupProdConsumers = (fileGraph: FileModuleGraph, exportName: string) =>
  readProdConsumersForExport(exportName)(fileGraph.consumersByExport);

const collectUsedExports = flow(
  (fileGraph: FileModuleGraph) => ({
    fileGraph,
    names: RA.map((exp: RuntimeExport) => exp.exportName)(fileGraph.runtimeExports),
  }),
  ({ fileGraph, names }) =>
    RA.filter((name: string) => lookupProdConsumers(fileGraph, name).length >= 1)(names),
);

const dropLeadingNames = (count: number) => (names: ReadonlyArray<string>) =>
  RA.dropLeft(count)(names);

const pairWithLaterNames =
  (relevantNames: ReadonlyArray<string>) => (idx: number, left: string) =>
    RA.flatMap((right: string) => [
      [left, right] as const,
      [right, left] as const,
    ])(dropLeadingNames(idx + 1)(relevantNames));

const collectUndirectedCliqueEdges = flow(
  (relevantNames: ReadonlyArray<string>) =>
    RA.mapWithIndex(pairWithLaterNames(relevantNames))(relevantNames),
  RA.flatten,
);

const readEdgeSource = (edge: readonly [string, string]) => edge[0];
const readEdgeTarget = (edge: readonly [string, string]) => edge[1];

const groupAdjacencyEdges = flow(
  RNEA.groupBy(readEdgeSource),
  RR.map(RA.map(readEdgeTarget)),
);

const buildAdjacencyFromConsumerImports = (usedSet: ReadonlySet<string>) =>
  flow(
    readRecordValues<ReadonlyArray<string>>,
    RA.map(RA.filter((name: string) => usedSet.has(name))),
    RA.flatMap(collectUndirectedCliqueEdges),
    groupAdjacencyEdges,
  );

const buildReuseAdjacency = (
  fileGraph: FileModuleGraph,
  usedSet: ReadonlySet<string>,
) => buildAdjacencyFromConsumerImports(usedSet)(fileGraph.prodImportsByConsumer);

const lookupAdjacentExports = (adjacency: AdjacencyRecord) =>
  flow(
    (node: string) => RR.lookup(node, adjacency),
    O.getOrElseW(() => []),
  );

const collectUnvisitedFromPending = (seenExports: ReadonlySet<string>, adjacency: AdjacencyRecord) =>
  flow(
    RA.flatMap(lookupAdjacentExports(adjacency)),
    RA.filter((neighbor: string) => !seenExports.has(neighbor)),
    RA.uniq(S.Eq),
  );

const collectUnvisitedNeighbors = (state: FrontierWalkState, adjacency: AdjacencyRecord) =>
  collectUnvisitedFromPending(state.seenExports, adjacency)(state.pendingExports);

const expandComponentFrontier = (
  state: FrontierWalkState,
  adjacency: AdjacencyRecord,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive graph walk
): FrontierWalkState =>
  state.pendingExports.length === 0
    ? state
    : stepComponentFrontier(state, adjacency);

const stepComponentFrontier = (
  state: FrontierWalkState,
  adjacency: AdjacencyRecord,
) => {
  const nextFrontier = collectUnvisitedNeighbors(state, adjacency);
  return expandComponentFrontier(
    {
      pendingExports: nextFrontier,
      seenExports: new Set([...state.seenExports, ...nextFrontier]),
      componentExports: [...state.componentExports, ...state.pendingExports],
    },
    adjacency,
  );
};

const collectSortedProdConsumers = (fileGraph: FileModuleGraph) =>
  flow(
    RA.flatMap((name: string) => lookupProdConsumers(fileGraph, name)),
    RA.uniq(S.Eq),
    RA.sort(S.Ord),
  );

const buildConsumerExportGroup = (
  members: ReadonlyArray<string>,
  fileGraph: FileModuleGraph,
) => ({
  exports: RA.sort(S.Ord)(members),
  consumers: collectSortedProdConsumers(fileGraph)(members),
});

const appendSeededComponent =
  (graphCtx: ReuseGraphContext) => (acc: PartitionAccumulator, seed: string) => {
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
      : appendSeededComponent(graphCtx)(acc, exportName);

const readFirstGroupExport = flow(
  (group: ConsumerExportGroup) => group.exports,
  RA.head,
  O.getOrElse(() => ""),
);

const compareGroupByFirstExport = Ord.contramap(readFirstGroupExport)(S.Ord);

const partitionUsedExports =
  (fileGraph: FileModuleGraph) => (usedExports: ReadonlyArray<string>) =>
    RA.sort(compareGroupByFirstExport)(
      RA.reduce<string, PartitionAccumulator>(
        { visited: new Set<string>(), groups: [] },
        stepComponentPartition({
          fileGraph,
          adjacency: buildReuseAdjacency(fileGraph, new Set(usedExports)),
        }),
      )(usedExports).groups,
    );

const evaluateFileCommonReuse = (fileGraph: FileModuleGraph, minExports: number) =>
  fileGraph.isBarrel || fileGraph.isTest || fileGraph.runtimeExports.length <= minExports
    ? O.none
    : evaluateUsedExportGroups(fileGraph, collectUsedExports(fileGraph));

const buildCommonReuseFinding = (fileGraph: FileModuleGraph) =>
  flow(
    partitionUsedExports(fileGraph),
    O.fromPredicate((groups: ReadonlyArray<ConsumerExportGroup>) => groups.length > 1),
    O.map((groups: ReadonlyArray<ConsumerExportGroup>) => ({
      fileName: fileGraph.fileName,
      exportCount: fileGraph.runtimeExports.length,
      groups,
    })),
  );

const evaluateUsedExportGroups = (
  fileGraph: FileModuleGraph,
  usedExports: ReadonlyArray<string>,
) => (RA.size(usedExports) <= 1 ? O.none : buildCommonReuseFinding(fileGraph)(usedExports));

const indexCommonReuseByFile = RA.reduce<
  CommonReuseFinding,
  Readonly<Record<string, CommonReuseFinding>>
>({}, (acc, finding) => ({
  ...acc,
  [finding.fileName]: finding,
}));

// eslint-disable-next-line strict-fp/no-single-caller-export -- analyzer entry point consumed by rule and tests
export const analyzeCommonReuseCohesion = ((
  program: ts.Program,
  options: CommonReuseOptions = {
    minExports: 5,
    testPatterns: DEFAULT_TEST_PATTERNS,
  },
) => {
  const findings = RA.filterMap((fileGraph: FileModuleGraph) =>
    evaluateFileCommonReuse(fileGraph, options.minExports),
  )(
    readRecordValues(
      analyzeModuleSymbolGraph(program, {
        entryPointPatterns: [],
        testFilePatterns: options.testPatterns,
      }).files,
    ),
  );
  return {
    findings,
    byFile: indexCommonReuseByFile(findings),
  };
}) satisfies (program: ts.Program, options?: CommonReuseOptions) => CommonReuseAnalysis;
