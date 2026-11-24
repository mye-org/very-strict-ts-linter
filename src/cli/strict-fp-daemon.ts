#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clearCaches } from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import * as E from "fp-ts/lib/Either.js";
import * as IOE from "fp-ts/lib/IOEither.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as TE from "fp-ts/lib/TaskEither.js";
import * as N from "fp-ts/lib/number.js";
import * as ts from "typescript";
import type { LintTier, PluginRuleTier } from "../configs/recommended.js";
import {
  buildEslintCacheOptions,
  computeConfigFingerprint,
  computeProjectFingerprint,
  hashShort,
  isRecord,
  loadParsedTsConfig,
  readCachedArtifact,
  resolveCacheDir,
  resolveTsBuildInfoPath,
  resolveTsConfigPath,
  writeCachedArtifact,
} from "./incremental-cache.js";
import {
  createExactTierRuleFilter,
  createTierRuleFilter,
  isPhasedLintResult,
  sliceLintResultsForTier,
  type PhasedLintOptions,
  type PhasedLintResult,
  type TierRunSummary,
} from "./strict-fp-lint.js";

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DAEMON_START_TIMEOUT_MS = 10_000;
const DAEMON_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export type DaemonStatus = {
  readonly running: boolean;
  readonly socketPath: string;
  readonly pid?: number;
  readonly uptimeMs?: number;
  readonly requestsServed?: number;
};

type DaemonRequest =
  | { readonly type: "ping" }
  | { readonly type: "stop" }
  | { readonly type: "lint"; readonly options: PhasedLintOptions };

type DaemonResponse =
  | {
      readonly ok: true;
      readonly type: "pong";
      readonly pid: number;
      readonly uptimeMs: number;
      readonly requestsServed: number;
    }
  | { readonly ok: true; readonly type: "stopped" }
  | { readonly ok: true; readonly type: "lint"; readonly result: PhasedLintResult }
  | { readonly ok: false; readonly error: string };

type CachedSourceEntry = {
  readonly text: string;
  readonly sourceFile: ts.SourceFile;
};

type KeyValueStore<V> = Readonly<{
  readonly get: (key: string) => V | undefined;
  readonly set: (key: string) => (value: V) => void;
  readonly remove: (key: string) => void;
  readonly clear: () => void;
}>;

const buildKeyValueStore = <V>() => {
  const entries = new Map<string, V>();
  return {
    get: (key: string) => entries.get(key),
    set: (key: string) => (value: V) => {
      entries.set(key, value);
    },
    remove: (key: string) => {
      entries.delete(key);
    },
    clear: () => {
      entries.clear();
    },
  } satisfies KeyValueStore<V>;
};

type WarmTypeCheckerState = {
  readonly tsconfigPath: string;
  readonly configFingerprint: string;
  readonly tsBuildInfoPath: string | undefined;
  readonly projectSourceCache: KeyValueStore<CachedSourceEntry>;
  readonly librarySourceCache: KeyValueStore<ts.SourceFile>;
  builderProgram: ts.EmitAndSemanticDiagnosticsBuilderProgram | undefined;
};

type WarmWorkspaceState = {
  readonly cwd: string;
  configFingerprint: string;
  eslintInstances: KeyValueStore<ESLint>;
  typeChecker: WarmTypeCheckerState | undefined;
  trackedProjectFileContents: ReadonlyMap<string, string>;
};

type WarmTier0Target = Readonly<{
  readonly configPath: string | undefined;
  readonly cacheRoot: string | undefined;
  readonly configFingerprint: string;
}>;

type LintPassOutput = Readonly<{
  readonly lintResults: ReadonlyArray<ESLint.LintResult>;
  readonly lintFormatter: ESLint.Formatter;
}>;

const isPongResponse = (
  resp: DaemonResponse,
): resp is Extract<DaemonResponse, { readonly type: "pong" }> =>
  resp.ok && resp.type === "pong";

const safeRealpath = (targetPath: string) =>
  E.getOrElse(() => path.resolve(targetPath))(
    IOE.tryCatch(
      () => fs.realpathSync(targetPath),
      () => undefined,
    )(),
  );

export const resolveDaemonEndpoints = ((
  cwd: string,
) => {
  const key = hashShort(safeRealpath(cwd));
  const baseDir = os.tmpdir();
  return {
    socketPath: path.join(baseDir, `strict-fp-daemon-${key}.sock`),
    pidPath: path.join(baseDir, `strict-fp-daemon-${key}.pid`),
  };
}) satisfies (cwd: string) => { readonly socketPath: string; readonly pidPath: string };

const isLibraryOrNodeModulesPath = (fileName: string) => {
  const normalized = fileName.replace(/\\/g, "/");
  return normalized.includes("/node_modules/") || normalized.endsWith(".d.ts");
};

const buildWarmCompilerHost =
  (options: ts.CompilerOptions) => (state: WarmTypeCheckerState) => {
    const baseHost = ts.createIncrementalCompilerHost(options);
    const originalGetSourceFile = baseHost.getSourceFile.bind(baseHost);

    return {
      ...baseHost,
      getSourceFile(
        fileName,
        languageVersionOrOptions,
        onError,
        shouldCreateNewSourceFile,
      ) {
        const resolved = path.resolve(fileName);
        if (isLibraryOrNodeModulesPath(resolved)) {
          const cachedLib = state.librarySourceCache.get(resolved);
          if (cachedLib && !shouldCreateNewSourceFile) {
            return cachedLib;
          }
          const loaded = originalGetSourceFile(
            fileName,
            languageVersionOrOptions,
            onError,
            shouldCreateNewSourceFile,
          );
          if (loaded) {
            state.librarySourceCache.set(resolved)(loaded);
          }
          return loaded;
        }

        const diskTextResult = IOE.tryCatch(
          () => fs.readFileSync(resolved, "utf8"),
          () => undefined,
        )();
        if (E.isLeft(diskTextResult)) {
          state.projectSourceCache.remove(resolved);
          return undefined;
        }
        const diskText = diskTextResult.right;

        const cached = state.projectSourceCache.get(resolved);
        if (cached && cached.text === diskText && !shouldCreateNewSourceFile) {
          return cached.sourceFile;
        }

        const sourceFile = originalGetSourceFile(
          fileName,
          languageVersionOrOptions,
          onError,
          shouldCreateNewSourceFile,
        );
        if (sourceFile) {
          state.projectSourceCache.set(resolved)({ text: diskText, sourceFile });
        }
        return sourceFile;
      },
    } satisfies ts.CompilerHost;
  };

const formatDiagnosticsOutput =
  (cwd: string) => (diagnostics: ReadonlyArray<ts.Diagnostic>) => {
    if (diagnostics.length === 0) {
      return "";
    }
    const formatHost: ts.FormatDiagnosticsHost = {
      getCurrentDirectory: () => cwd,
      getCanonicalFileName: (fileName) => fileName,
      getNewLine: () => "\n",
    };
    return ts.formatDiagnostics(diagnostics, formatHost).trim();
  };

const runWarmTier0 =
  (workspace: WarmWorkspaceState) => (target: WarmTier0Target) => {
    const tsconfigPath = resolveTsConfigPath(workspace.cwd)(target.configPath);
    if (!tsconfigPath || !fs.existsSync(tsconfigPath)) {
      return {
        tier: 0 as const,
        errorCount: 1,
        warningCount: 0,
        output: `error TS5058: The specified path does not exist: '${target.configPath ?? "tsconfig.json"}'.`,
      } satisfies TierRunSummary;
    }

    const parsed = loadParsedTsConfig(tsconfigPath);
    if (!parsed) {
      return {
        tier: 0 as const,
        errorCount: 1,
        warningCount: 0,
        output: `error TS5023: Failed to parse TypeScript config '${tsconfigPath}'.`,
      } satisfies TierRunSummary;
    }

    const tsBuildInfoPath = target.cacheRoot
      ? resolveTsBuildInfoPath(target.cacheRoot)("tsc")(tsconfigPath)
      : undefined;

    if (
      !workspace.typeChecker ||
      workspace.typeChecker.tsconfigPath !== tsconfigPath ||
      workspace.typeChecker.configFingerprint !== target.configFingerprint ||
      workspace.typeChecker.tsBuildInfoPath !== tsBuildInfoPath
    ) {
      workspace.typeChecker = {
        tsconfigPath,
        configFingerprint: target.configFingerprint,
        tsBuildInfoPath,
        projectSourceCache: buildKeyValueStore<CachedSourceEntry>(),
        librarySourceCache: buildKeyValueStore<ts.SourceFile>(),
        builderProgram: undefined,
      };
    }

    const tcState = workspace.typeChecker;
    const incrementalOptions: ts.CompilerOptions = {
      ...parsed.options,
      noEmit: true,
      ...(tsBuildInfoPath !== undefined
        ? { incremental: true, tsBuildInfoFile: tsBuildInfoPath }
        : {}),
    };

    const host = buildWarmCompilerHost(incrementalOptions)(tcState);
    const builderProgram = tcState.builderProgram
      ? ts.createEmitAndSemanticDiagnosticsBuilderProgram(
          parsed.fileNames,
          incrementalOptions,
          host,
          tcState.builderProgram,
          parsed.errors,
          parsed.projectReferences,
        )
      : ts.createIncrementalProgram({
          rootNames: parsed.fileNames,
          options: incrementalOptions,
          host,
          configFileParsingDiagnostics: parsed.errors,
          ...(parsed.projectReferences !== undefined
            ? { projectReferences: parsed.projectReferences }
            : {}),
        });

    tcState.builderProgram = builderProgram;

    const allDiagnostics: ReadonlyArray<ts.Diagnostic> = [
      ...builderProgram.getConfigFileParsingDiagnostics(),
      ...builderProgram.getOptionsDiagnostics(),
      ...builderProgram.getGlobalDiagnostics(),
      ...builderProgram.getSyntacticDiagnostics(),
      ...builderProgram.getSemanticDiagnostics(),
    ];

    if (tsBuildInfoPath !== undefined) {
      IOE.tryCatch(
        () => {
          builderProgram.emit();
        },
        () => undefined,
      )();
    }

    const errorDiagnostics = allDiagnostics.filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    const output = formatDiagnosticsOutput(workspace.cwd)(allDiagnostics);

    return {
      tier: 0 as const,
      errorCount: errorDiagnostics.length,
      warningCount: 0,
      output,
    } satisfies TierRunSummary;
  };

const detectChangedNonTargetProjectFiles =
  (workspace: WarmWorkspaceState) =>
  (tsconfigPath: string | undefined) =>
  (targets: ReadonlyArray<string>) => {
    if (!tsconfigPath || !fs.existsSync(tsconfigPath)) {
      return false;
    }
    const parsed = loadParsedTsConfig(tsconfigPath);
    if (!parsed) {
      return false;
    }

    const resolvedTargets = targets.map((t) => path.resolve(workspace.cwd, t));
    const isFullWorkspaceTarget = resolvedTargets.some(
      (t) => t === path.resolve(workspace.cwd),
    );
    const targetSet = new Set(resolvedTargets);

    let nonTargetChanged = false;
    const nextTracked = new Map<string, string>();
    for (const fileName of parsed.fileNames) {
      const resolved = path.resolve(fileName);
      const content = E.getOrElse(() => "")(
        IOE.tryCatch(
          () => fs.readFileSync(resolved, "utf8"),
          () => undefined,
        )(),
      );
      nextTracked.set(resolved, content);
      const prev = workspace.trackedProjectFileContents.get(resolved);
      if (prev !== undefined && prev !== content && !isFullWorkspaceTarget && !targetSet.has(resolved)) {
        nonTargetChanged = true;
      }
    }

    if (workspace.trackedProjectFileContents.size > 0) {
      for (const prevFile of workspace.trackedProjectFileContents.keys()) {
        if (!nextTracked.has(prevFile) && !isFullWorkspaceTarget) {
          nonTargetChanged = true;
        }
      }
    }

    workspace.trackedProjectFileContents = nextTracked;
    return nonTargetChanged;
  };

const tiersUpTo: Record<LintTier, ReadonlyArray<LintTier>> = {
  0: [0],
  1: [0, 1],
  2: [0, 1, 2],
  3: [0, 1, 2, 3],
};

const buildTierSummary =
  (tier: PluginRuleTier) => async (pass: LintPassOutput) => {
    const errorCount = RA.foldMap(N.MonoidSum)((r: ESLint.LintResult) => r.errorCount)(
      pass.lintResults,
    );
    const warningCount = RA.foldMap(N.MonoidSum)((r: ESLint.LintResult) => r.warningCount)(
      pass.lintResults,
    );
    const output = await pass.lintFormatter.format([...pass.lintResults]);
    return { tier, errorCount, warningCount, output } satisfies TierRunSummary;
  };

const buildLintCacheScopeKey = (options: PhasedLintOptions) =>
  JSON.stringify({
    targets: options.targets,
    format: options.format,
    maxTier: options.maxTier,
    onlyTier: options.onlyTier ?? null,
    tsconfig: options.tsconfig ?? null,
    eslintCache: options.eslintCache === true,
  });

const handleWarmLint =
  (workspace: WarmWorkspaceState) => async (options: PhasedLintOptions) => {
    const useCache = options.cache !== false;
    const cacheDir = useCache ? resolveCacheDir(workspace.cwd)(options.cacheLocation) : undefined;
    const tsconfigPath = resolveTsConfigPath(workspace.cwd)(options.tsconfig);
    const configFingerprint = computeConfigFingerprint(workspace.cwd)(tsconfigPath);

    if (workspace.configFingerprint !== configFingerprint) {
      clearCaches();
      workspace.eslintInstances.clear();
      workspace.typeChecker = undefined;
      workspace.trackedProjectFileContents = new Map();
      workspace.configFingerprint = configFingerprint;
    }

    const scopeKey = buildLintCacheScopeKey(options);
    const projectFingerprint =
      useCache && !options.fix
        ? computeProjectFingerprint({
            cwd: workspace.cwd,
            kind: "lint",
            ...(tsconfigPath !== undefined ? { tsconfigPath } : {}),
            targets: options.targets,
            scopeKey,
          })
        : undefined;

    if (cacheDir && projectFingerprint) {
      const cached = readCachedArtifact(cacheDir)("lint")(scopeKey)(projectFingerprint)(
        isPhasedLintResult,
      );
      if (cached) {
        return { ...cached, cacheHit: true } satisfies PhasedLintResult;
      }
    }

    const nonTargetChanged = detectChangedNonTargetProjectFiles(workspace)(tsconfigPath)(
      options.targets,
    );
    if (nonTargetChanged) {
      clearCaches();
      workspace.eslintInstances.clear();
    }

    const tiers =
      options.onlyTier !== undefined ? [options.onlyTier] : tiersUpTo[options.maxTier];
    const filterKey =
      options.onlyTier !== undefined
        ? `only:${String(options.onlyTier)}:${String(options.eslintCache === true)}`
        : `max:${String(options.maxTier)}:${String(options.eslintCache === true)}`;

    let singlePass: LintPassOutput | undefined;

    const loadSinglePass = async () => {
      if (!singlePass) {
        let eslint = workspace.eslintInstances.get(filterKey);
        if (!eslint) {
          const ruleFilter =
            options.onlyTier !== undefined
              ? createExactTierRuleFilter(options.onlyTier)
              : createTierRuleFilter(options.maxTier);
          const eslintOptions: ESLint.Options = {
            cwd: workspace.cwd,
            fix: false,
            ruleFilter,
            ...buildEslintCacheOptions(options.eslintCache)(cacheDir),
          };
          eslint = new ESLint(eslintOptions);
          workspace.eslintInstances.set(filterKey)(eslint);
        }
        const lintResults = await eslint.lintFiles([...options.targets]);
        const lintFormatter = await eslint.loadFormatter(options.format);
        singlePass = { lintResults, lintFormatter };
      }
      return singlePass;
    };

    let summaries: ReadonlyArray<TierRunSummary> = [];
    for (const tier of tiers) {
      let summary: TierRunSummary;
      if (tier === 0) {
        summary = runWarmTier0(workspace)({
          configPath: options.tsconfig,
          cacheRoot: cacheDir,
          configFingerprint,
        });
      } else {
        const pass = await loadSinglePass();
        const tierResults =
          options.onlyTier !== undefined
            ? pass.lintResults
            : sliceLintResultsForTier(tier)(pass.lintResults);
        summary = await buildTierSummary(tier)({
          lintResults: tierResults,
          lintFormatter: pass.lintFormatter,
        });
      }

      summaries = [...summaries, summary];
      if (summary.errorCount > 0) {
        const failedResult: PhasedLintResult = {
          passed: false,
          failedTier: tier,
          summaries,
        };
        if (cacheDir && projectFingerprint) {
          writeCachedArtifact(cacheDir)("lint")(scopeKey)(projectFingerprint)(failedResult);
        }
        return failedResult;
      }
    }

    const passedResult: PhasedLintResult = { passed: true, summaries };
    if (cacheDir && projectFingerprint) {
      writeCachedArtifact(cacheDir)("lint")(scopeKey)(projectFingerprint)(passedResult);
    }
    return passedResult;
  };

const cleanupEndpoints = (socketPath: string) => (pidPath: string) => {
  IOE.tryCatch(
    () => {
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    },
    () => undefined,
  )();
  IOE.tryCatch(
    () => {
      if (fs.existsSync(pidPath)) {
        fs.unlinkSync(pidPath);
      }
    },
    () => undefined,
  )();
};

const isPhasedLintOptions = (value: unknown): value is PhasedLintOptions =>
  isRecord(value) &&
  Array.isArray(value["targets"]) &&
  typeof value["fix"] === "boolean" &&
  typeof value["format"] === "string" &&
  (value["maxTier"] === 0 || value["maxTier"] === 1 || value["maxTier"] === 2 || value["maxTier"] === 3);

const isDaemonRequest = (value: unknown): value is DaemonRequest => {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    return false;
  }
  if (value["type"] === "ping" || value["type"] === "stop") {
    return true;
  }
  return value["type"] === "lint" && isPhasedLintOptions(value["options"]);
};

const isDaemonResponse = (value: unknown): value is DaemonResponse => {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") {
    return false;
  }
  if (!value["ok"]) {
    return typeof value["error"] === "string";
  }
  if (value["type"] === "stopped") {
    return true;
  }
  if (value["type"] === "pong") {
    return (
      typeof value["pid"] === "number" &&
      typeof value["uptimeMs"] === "number" &&
      typeof value["requestsServed"] === "number"
    );
  }
  return value["type"] === "lint" && isPhasedLintResult(value["result"]);
};

const startDaemonServer = (cwd: string) => {
  const { socketPath, pidPath } = resolveDaemonEndpoints(cwd);
  cleanupEndpoints(socketPath)(pidPath);

  const startedAt = Date.now();
  let requestsServed = 0;
  let activeQueue: Promise<void> = Promise.resolve();

  const workspace: WarmWorkspaceState = {
    cwd,
    configFingerprint: "",
    eslintInstances: buildKeyValueStore<ESLint>(),
    typeChecker: undefined,
    trackedProjectFileContents: new Map(),
  };

  const rawIdleMs = process.env["STRICT_FP_DAEMON_IDLE_MS"];
  const parsedIdleMs = rawIdleMs ? Number(rawIdleMs) : DEFAULT_IDLE_TIMEOUT_MS;
  const idleTimeoutMs =
    Number.isFinite(parsedIdleMs) && parsedIdleMs > 0
      ? parsedIdleMs
      : DEFAULT_IDLE_TIMEOUT_MS;

  let idleTimer: NodeJS.Timeout | undefined;
  const shutdown = (server: net.Server) => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    server.close(() => {
      cleanupEndpoints(socketPath)(pidPath);
      process.exit(0);
    });
    setTimeout(() => {
      cleanupEndpoints(socketPath)(pidPath);
      process.exit(0);
    }, 500).unref();
  };

  const resetIdleTimer = (server: net.Server) => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      shutdown(server);
    }, idleTimeoutMs);
    idleTimer.unref();
  };

  const server = net.createServer((socket) => {
    resetIdleTimer(server);
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length === 0) {
        return;
      }

      const parsedOutcome = IOE.tryCatch(
        () => {
          const parsed: unknown = JSON.parse(line);
          return parsed;
        },
        (err) => (err instanceof Error ? err.message : String(err)),
      )();
      if (E.isLeft(parsedOutcome)) {
        socket.end(`${JSON.stringify({ ok: false, error: parsedOutcome.left })}\n`);
        return;
      }
      if (!isDaemonRequest(parsedOutcome.right)) {
        socket.end(`${JSON.stringify({ ok: false, error: "Invalid daemon request" })}\n`);
        return;
      }
      const request = parsedOutcome.right;

      if (request.type === "ping") {
        const resp: DaemonResponse = {
          ok: true,
          type: "pong",
          pid: process.pid,
          uptimeMs: Date.now() - startedAt,
          requestsServed,
        };
        socket.end(`${JSON.stringify(resp)}\n`);
        return;
      }

      if (request.type === "stop") {
        const resp: DaemonResponse = { ok: true, type: "stopped" };
        socket.end(`${JSON.stringify(resp)}\n`, () => {
          shutdown(server);
        });
        return;
      }

      // Serialize lint requests within one workspace to keep shared TS/ESLint state consistent.
      const runTask = async () => {
        try {
          const result = await handleWarmLint(workspace)(request.options);
          requestsServed += 1;
          resetIdleTimer(server);
          const resp: DaemonResponse = { ok: true, type: "lint", result };
          socket.end(`${JSON.stringify(resp)}\n`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const resp: DaemonResponse = { ok: false, error: message };
          socket.end(`${JSON.stringify(resp)}\n`);
        }
      };

      const prevQueue = activeQueue;
      activeQueue = (async () => {
        await prevQueue;
        await runTask();
      })();
    });
  });

  server.listen(socketPath, () => {
    fs.writeFileSync(pidPath, `${String(process.pid)}\n`, "utf8");
    resetIdleTimer(server);
  });

  process.on("SIGTERM", () => {
    shutdown(server);
  });
  process.on("SIGINT", () => {
    shutdown(server);
  });
};

const sendDaemonRequest =
  (socketPath: string) =>
  (timeoutMs: number) =>
  async (request: DaemonRequest): Promise<DaemonResponse> => {
    const client = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      client.destroy(new Error(`Daemon request timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);

    client.on("connect", () => {
      client.write(`${JSON.stringify(request)}\n`);
    });

    const outcome = await TE.tryCatch(
      async () => {
        let buffer = "";
        for await (const chunk of client) {
          buffer += String(chunk);
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).trim();
            client.end();
            const parsedOutcome = IOE.tryCatch(
              () => {
                const parsed: unknown = JSON.parse(line);
                return parsed;
              },
              (err) => (err instanceof Error ? err : new Error(String(err))),
            )();
            if (E.isLeft(parsedOutcome)) {
              throw parsedOutcome.left;
            }
            if (!isDaemonResponse(parsedOutcome.right)) {
              throw new Error("Invalid daemon response");
            }
            return parsedOutcome.right;
          }
        }
        throw new Error("Daemon connection closed before response");
      },
      (err) => (err instanceof Error ? err : new Error(String(err))),
    )();

    clearTimeout(timer);
    if (E.isLeft(outcome)) {
      throw outcome.left;
    }
    return outcome.right;
  };

const sleep = (ms: number) => delay(ms);

const resolveDaemonScriptPath = () => {
  const currentFile = fileURLToPath(import.meta.url);
  if (currentFile.endsWith(".js")) {
    return currentFile;
  }
  const distCandidate = path.resolve(
    path.dirname(currentFile),
    "../../dist/cli/strict-fp-daemon.js",
  );
  return distCandidate;
};

const ensureDaemonRunning = async (cwd: string) => {
  const { socketPath, pidPath } = resolveDaemonEndpoints(cwd);
  try {
    const pong = await sendDaemonRequest(socketPath)(1000)({ type: "ping" });
    if (isPongResponse(pong)) {
      return socketPath;
    }
  } catch {
    // Daemon not running or stale socket.
  }

  cleanupEndpoints(socketPath)(pidPath);
  const daemonScript = resolveDaemonScriptPath();
  const child = spawn(process.execPath, [daemonScript, cwd], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(50);
    try {
      const pong = await sendDaemonRequest(socketPath)(500)({ type: "ping" });
      if (isPongResponse(pong)) {
        return socketPath;
      }
    } catch {
      // Wait for socket to bind.
    }
  }

  throw new Error(`Failed to start strict-fp daemon for workspace ${cwd}`);
};

export const requestDaemonStatus = (async (cwd: string) => {
  const { socketPath } = resolveDaemonEndpoints(cwd);
  try {
    const resp = await sendDaemonRequest(socketPath)(1000)({ type: "ping" });
    if (isPongResponse(resp)) {
      const runningStatus: DaemonStatus = {
        running: true,
        socketPath,
        pid: resp.pid,
        uptimeMs: resp.uptimeMs,
        requestsServed: resp.requestsServed,
      };
      return runningStatus;
    }
  } catch {
    // Not running.
  }
  const stoppedStatus: DaemonStatus = { running: false, socketPath };
  return stoppedStatus;
}) satisfies (cwd: string) => Promise<DaemonStatus>;

export const stopWorkspaceDaemon = (async (cwd: string) => {
  const { socketPath, pidPath } = resolveDaemonEndpoints(cwd);
  try {
    const resp = await sendDaemonRequest(socketPath)(2000)({ type: "stop" });
    if (resp.ok) {
      await sleep(50);
      return true;
    }
  } catch {
    // Fall back to PID file if socket was unresponsive.
  }

  try {
    if (fs.existsSync(pidPath)) {
      const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, "SIGTERM");
      }
      cleanupEndpoints(socketPath)(pidPath);
      return true;
    }
  } catch {
    cleanupEndpoints(socketPath)(pidPath);
  }

  return false;
}) satisfies (cwd: string) => Promise<boolean>;

export const runLintViaDaemon = (async (
  options: PhasedLintOptions,
) => {
  const cwd = options.cwd ?? process.cwd();
  const socketPath = await ensureDaemonRunning(cwd);
  const resp = await sendDaemonRequest(socketPath)(DAEMON_REQUEST_TIMEOUT_MS)({
    type: "lint",
    options: { ...options, cwd },
  });
  if (!resp.ok) {
    throw new Error(`strict-fp daemon error: ${resp.error}`);
  }
  if (resp.type !== "lint") {
    throw new Error(`Unexpected daemon response type: ${resp.type}`);
  }
  return resp.result;
}) satisfies (options: PhasedLintOptions) => Promise<PhasedLintResult>;

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryUrl) {
  const targetCwd = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  startDaemonServer(targetCwd);
}
