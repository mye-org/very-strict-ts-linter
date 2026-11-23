import * as ts from "typescript";
import { memoizeByProgramAndKey, normalizeFilePath } from "../utils/program-cache.js";
import {
  analyzeFileCohesion,
  DEFAULT_UBIQUITOUS_TYPES,
  ModuleCohesionOptions,
} from "./module-cohesion-analyzer.js";
import {
  analyzeModuleSymbolGraph,
  DEFAULT_TEST_PATTERNS,
  RuntimeExport,
} from "./module-symbol-graph.js";
import {
  analyzeProgramPurity,
  DEFAULT_EFFECT_TYPES,
  DEFAULT_IMPURE_MODULES,
  FilePuritySummary,
  PurityOptions,
  PurityStatus,
} from "./purity-analyzer.js";

export type SingleCallerExportFinding = Readonly<{
  readonly kind: "singleCallerExport";
  readonly exportName: string;
  readonly fileName: string;
  readonly line: number;
  readonly locationKey: string;
  readonly soleConsumer: string;
}>;

export type TestOnlyExportFinding = Readonly<{
  readonly kind: "testOnlyExport";
  readonly exportName: string;
  readonly fileName: string;
  readonly line: number;
  readonly locationKey: string;
  readonly testConsumers: ReadonlyArray<string>;
}>;

export type EncapsulationFinding = SingleCallerExportFinding | TestOnlyExportFinding;

export type SingleCallerOptions = Readonly<{
  readonly entryPoints: ReadonlyArray<string>;
  readonly testPatterns: ReadonlyArray<string>;
  readonly respectPurityBoundary: boolean;
  readonly maxMergedFileLines: number;
  readonly purityOptions: PurityOptions;
  readonly cohesionOptions: ModuleCohesionOptions;
}>;

export type SingleCallerAnalysis = Readonly<{
  readonly findings: ReadonlyArray<EncapsulationFinding>;
  readonly byFile: Readonly<Record<string, ReadonlyArray<EncapsulationFinding>>>;
}>;

export type ConsumerExportGroup = Readonly<{
  readonly exports: ReadonlyArray<string>;
  readonly consumers: ReadonlyArray<string>;
}>;

export type CommonReuseFinding = Readonly<{
  readonly fileName: string;
  readonly exportCount: number;
  readonly groups: ReadonlyArray<ConsumerExportGroup>;
}>;

export type CommonReuseOptions = Readonly<{
  readonly minExports: number;
  readonly testPatterns: ReadonlyArray<string>;
}>;

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

const getExportDeclarationLineCount = (exp: RuntimeExport): number => {
  const sf = exp.declaration.getSourceFile();
  const startLine = sf.getLineAndCharacterOfPosition(exp.declaration.getStart(sf)).line;
  const endLine = sf.getLineAndCharacterOfPosition(exp.declaration.getEnd()).line;
  return Math.max(1, endLine - startLine + 1);
};

const resolveExportPurity = (
  exp: RuntimeExport,
  filePurity: FilePuritySummary | undefined,
): PurityStatus => {
  if (!filePurity) return "pure";
  const byExport = filePurity.exportPurityByName[exp.exportName];
  if (byExport) return byExport;
  const byLocal = filePurity.exportPurityByName[exp.localName];
  if (byLocal) return byLocal;
  return filePurity.modulePurity === "impure" ? "impure" : "pure";
};

const computeSingleCallerAnalysis = (
  program: ts.Program,
  options: SingleCallerOptions,
): SingleCallerAnalysis => {
  const checker = program.getTypeChecker();
  const symbolGraph = analyzeModuleSymbolGraph(program, options.entryPoints, options.testPatterns);
  const purityAnalysis = analyzeProgramPurity(program, options.purityOptions);

  const sfByNormalizedPath = new Map<string, ts.SourceFile>();
  for (const sf of program.getSourceFiles()) {
    sfByNormalizedPath.set(normalizeFilePath(sf.fileName), sf);
  }
  const consumerCohesionCache = new Map<string, boolean>();
  const isConsumerCohesive = (consumerFile: string): boolean => {
    const cached = consumerCohesionCache.get(consumerFile);
    if (cached !== undefined) return cached;
    const sf = sfByNormalizedPath.get(consumerFile);
    if (!sf) {
      consumerCohesionCache.set(consumerFile, true);
      return true;
    }
    const cohesive = analyzeFileCohesion(sf, checker, options.cohesionOptions).isCohesive;
    consumerCohesionCache.set(consumerFile, cohesive);
    return cohesive;
  };

  const findings: Array<EncapsulationFinding> = [];
  const byFile: Record<string, Array<EncapsulationFinding>> = {};

  for (const fileGraph of Object.values(symbolGraph.files)) {
    if (fileGraph.isBarrel || fileGraph.isTest || fileGraph.isEntryPoint) continue;
    const filePurity = purityAnalysis.files[fileGraph.fileName];

    for (const exp of fileGraph.runtimeExports) {
      if (symbolGraph.publicEntryPointExports.has(exp.key)) continue;
      const consumerRec = fileGraph.consumersByExport[exp.exportName];
      if (!consumerRec) continue;

      const { prodConsumers, testConsumers } = consumerRec;

      if (prodConsumers.length === 0 && testConsumers.length >= 1) {
        const finding: TestOnlyExportFinding = {
          kind: "testOnlyExport",
          exportName: exp.exportName,
          fileName: exp.fileName,
          line: exp.line,
          locationKey: exp.locationKey,
          testConsumers,
        };
        findings.push(finding);
        const list = byFile[exp.fileName] ?? [];
        list.push(finding);
        byFile[exp.fileName] = list;
        continue;
      }

      if (prodConsumers.length === 1) {
        const soleConsumer = prodConsumers[0]!;

        // Deadlock Guard 1: Purity-Boundary Split (pure core called by 1 impure shell)
        if (options.respectPurityBoundary) {
          const expPurity = resolveExportPurity(exp, filePurity);
          const consumerPurity = purityAnalysis.files[soleConsumer]?.modulePurity;
          if (expPurity === "pure" && consumerPurity === "impure") {
            continue;
          }
        }

        // Deadlock Guard 2: Size Guard (merging would exceed maxMergedFileLines)
        const consumerLines = symbolGraph.files[soleConsumer]?.lineCount ?? 0;
        const declLines = getExportDeclarationLineCount(exp);
        if (consumerLines + declLines > options.maxMergedFileLines) {
          continue;
        }

        // Deadlock Guard 3: Cohesion Guard (avoid folding into non-cohesive consumer)
        if (!isConsumerCohesive(soleConsumer)) {
          continue;
        }

        // Deadlock Guard 4: React View-Model Boundary (.ts helper consumed solely by .tsx component)
        if (!fileGraph.fileName.endsWith(".tsx") && soleConsumer.endsWith(".tsx")) {
          continue;
        }

        const finding: SingleCallerExportFinding = {
          kind: "singleCallerExport",
          exportName: exp.exportName,
          fileName: exp.fileName,
          line: exp.line,
          locationKey: exp.locationKey,
          soleConsumer,
        };
        findings.push(finding);
        const list = byFile[exp.fileName] ?? [];
        list.push(finding);
        byFile[exp.fileName] = list;
      }
    }
  }

  return { findings, byFile };
};

const singleCallerCache = new WeakMap<
  ts.Program,
  Readonly<Record<string, SingleCallerAnalysis>>
>();

export const analyzeSingleCallerExports = (
  program: ts.Program,
  options: SingleCallerOptions = DEFAULT_SINGLE_CALLER_OPTIONS,
): SingleCallerAnalysis => {
  const key = [
    options.entryPoints.join(","),
    options.testPatterns.join(","),
    String(options.respectPurityBoundary),
    String(options.maxMergedFileLines),
    options.purityOptions.effectTypes.join(","),
    options.purityOptions.impureModules.join(","),
    options.purityOptions.pureModules.join(","),
    options.cohesionOptions.ubiquitousTypes.join(","),
    options.cohesionOptions.primaryDomainTypes.join(","),
  ].join("||");
  return memoizeByProgramAndKey(program, key, singleCallerCache, (p) =>
    computeSingleCallerAnalysis(p, options),
  );
};

const computeCommonReuseAnalysis = (
  program: ts.Program,
  options: CommonReuseOptions,
): CommonReuseAnalysis => {
  const symbolGraph = analyzeModuleSymbolGraph(program, [], options.testPatterns);
  const findings: Array<CommonReuseFinding> = [];
  const byFile: Record<string, CommonReuseFinding> = {};

  for (const fileGraph of Object.values(symbolGraph.files)) {
    if (fileGraph.isBarrel || fileGraph.isTest) continue;
    if (fileGraph.runtimeExports.length <= options.minExports) continue;

    const usedExports = fileGraph.runtimeExports
      .map((e) => e.exportName)
      .filter((name) => (fileGraph.consumersByExport[name]?.prodConsumers.length ?? 0) >= 1);

    if (usedExports.length <= 1) continue;

    const usedSet = new Set(usedExports);
    const adj = new Map<string, Set<string>>();
    for (const name of usedExports) {
      adj.set(name, new Set());
    }

    // Add edge (u, v) if at least one non-test consumer imports both u and v
    for (const importedNames of Object.values(fileGraph.prodImportsByConsumer)) {
      const relevant = importedNames.filter((n) => usedSet.has(n));
      for (let i = 0; i < relevant.length; i += 1) {
        const u = relevant[i]!;
        for (let j = i + 1; j < relevant.length; j += 1) {
          const v = relevant[j]!;
          adj.get(u)?.add(v);
          adj.get(v)?.add(u);
        }
      }
    }

    // Connected components via BFS
    const visited = new Set<string>();
    const groups: Array<ConsumerExportGroup> = [];
    for (const name of usedExports) {
      if (visited.has(name)) continue;
      const compExports: Array<string> = [];
      const compConsumers = new Set<string>();
      const queue: Array<string> = [name];
      visited.add(name);
      while (queue.length > 0) {
        const curr = queue.shift()!;
        compExports.push(curr);
        for (const consumer of fileGraph.consumersByExport[curr]?.prodConsumers ?? []) {
          compConsumers.add(consumer);
        }
        for (const nb of adj.get(curr) ?? []) {
          if (!visited.has(nb)) {
            visited.add(nb);
            queue.push(nb);
          }
        }
      }
      compExports.sort();
      groups.push({
        exports: compExports,
        consumers: Array.from(compConsumers).sort(),
      });
    }

    if (groups.length > 1) {
      groups.sort((a, b) => (a.exports[0] ?? "").localeCompare(b.exports[0] ?? ""));
      const finding: CommonReuseFinding = {
        fileName: fileGraph.fileName,
        exportCount: fileGraph.runtimeExports.length,
        groups,
      };
      findings.push(finding);
      byFile[fileGraph.fileName] = finding;
    }
  }

  return { findings, byFile };
};

const commonReuseCache = new WeakMap<
  ts.Program,
  Readonly<Record<string, CommonReuseAnalysis>>
>();

export const analyzeCommonReuseCohesion = (
  program: ts.Program,
  options: CommonReuseOptions = {
    minExports: 5,
    testPatterns: DEFAULT_TEST_PATTERNS,
  },
): CommonReuseAnalysis => {
  const key = `${String(options.minExports)}||${options.testPatterns.join(",")}`;
  return memoizeByProgramAndKey(program, key, commonReuseCache, (p) =>
    computeCommonReuseAnalysis(p, options),
  );
};
