#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import {
  buildDiscoveryRadarReport,
  formatDiscoveryReport,
  type DiscoveryRadarReport,
} from "../analyzers/radar-report.js";
import {
  computeProjectFingerprint,
  loadParsedTsConfig,
  readCachedArtifact,
  resolveCacheDir,
  resolveTsBuildInfoPath,
  resolveTsConfigPath,
  writeCachedArtifact,
} from "./incremental-cache.js";

export type RadarRunOptions = {
  readonly cwd?: string;
  readonly tsconfig?: string;
  readonly format?: "markdown" | "json";
  readonly cache?: boolean;
  readonly cacheLocation?: string;
};

export type RadarRunResult = {
  readonly report: DiscoveryRadarReport;
  readonly formatted: string;
  readonly cacheHit: boolean;
  readonly tsBuildInfoPath?: string;
};

const parseRadarArgs = (args: ReadonlyArray<string>): RadarRunOptions => {
  let tsconfig: string | undefined;
  let format: "markdown" | "json" = "markdown";
  let cache: boolean | undefined;
  let cacheLocation: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if ((arg === "--tsconfig" || arg === "--project" || arg === "-p") && args[i + 1]) {
      tsconfig = args[i + 1];
      i += 1;
    } else if (arg === "--format" && args[i + 1]) {
      format = args[i + 1] === "json" ? "json" : "markdown";
      i += 1;
    } else if (arg === "--cache") {
      cache = true;
    } else if (arg === "--no-cache") {
      cache = false;
    } else if ((arg === "--cache-location" || arg === "--cache-dir") && args[i + 1]) {
      cacheLocation = args[i + 1];
      i += 1;
    }
  }

  return {
    format,
    ...(tsconfig !== undefined ? { tsconfig } : {}),
    ...(cache !== undefined ? { cache } : {}),
    ...(cacheLocation !== undefined ? { cacheLocation } : {}),
  };
};

export const runDiscoveryRadar = (options: RadarRunOptions = {}): RadarRunResult => {
  const cwd = options.cwd ?? process.cwd();
  const format = options.format ?? "markdown";
  const useCache = options.cache !== false;
  const tsconfigPath =
    resolveTsConfigPath(cwd, options.tsconfig) ??
    path.resolve(cwd, options.tsconfig ?? "tsconfig.json");

  const cacheDir = useCache ? resolveCacheDir(cwd, options.cacheLocation) : undefined;
  const scopeKey = JSON.stringify({ tsconfig: tsconfigPath });
  const fingerprint = useCache
    ? computeProjectFingerprint({
        cwd,
        kind: "radar",
        tsconfigPath,
        scopeKey,
      })
    : undefined;

  const tsBuildInfoPath = cacheDir
    ? resolveTsBuildInfoPath(cacheDir, "radar", tsconfigPath)
    : undefined;

  if (cacheDir && fingerprint) {
    const cachedReport = readCachedArtifact<DiscoveryRadarReport>(
      cacheDir,
      "radar",
      scopeKey,
      fingerprint,
    );
    if (cachedReport) {
      return {
        report: cachedReport,
        formatted: formatDiscoveryReport(cachedReport, format),
        cacheHit: true,
        ...(tsBuildInfoPath !== undefined ? { tsBuildInfoPath } : {}),
      };
    }
  }

  const configFile = ts.readConfigFile(tsconfigPath, (f) => ts.sys.readFile(f));
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }

  const parsed = loadParsedTsConfig(tsconfigPath);
  if (!parsed) {
    throw new Error(`Failed to parse TypeScript config at ${tsconfigPath}`);
  }

  let program: ts.Program;
  if (tsBuildInfoPath !== undefined) {
    const incrementalOptions: ts.CompilerOptions = {
      ...parsed.options,
      noEmit: true,
      incremental: true,
      tsBuildInfoFile: tsBuildInfoPath,
    };
    const host = ts.createIncrementalCompilerHost(incrementalOptions);
    const builderProgram = ts.createIncrementalProgram({
      rootNames: parsed.fileNames,
      options: incrementalOptions,
      host,
      configFileParsingDiagnostics: parsed.errors,
      ...(parsed.projectReferences !== undefined
        ? { projectReferences: parsed.projectReferences }
        : {}),
    });
    program = builderProgram.getProgram();
    const report = buildDiscoveryRadarReport(program);
    try {
      builderProgram.emit();
    } catch {
      // Best-effort .tsbuildinfo persistence.
    }
    if (cacheDir && fingerprint) {
      writeCachedArtifact(cacheDir, "radar", scopeKey, fingerprint, report);
    }
    return {
      report,
      formatted: formatDiscoveryReport(report, format),
      cacheHit: false,
      tsBuildInfoPath,
    };
  }

  program = ts.createProgram(parsed.fileNames, parsed.options);
  const report = buildDiscoveryRadarReport(program);
  return {
    report,
    formatted: formatDiscoveryReport(report, format),
    cacheHit: false,
  };
};

const runRadarCli = () => {
  const options = parseRadarArgs(process.argv.slice(2));
  const result = runDiscoveryRadar(options);
  console.log(result.formatted);
};

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryUrl) {
  try {
    runRadarCli();
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
