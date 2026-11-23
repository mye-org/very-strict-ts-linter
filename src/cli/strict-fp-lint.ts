#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ESLint, type Linter } from "eslint";
import {
  ruleTiers,
  tier0TypeChecker,
  type LintTier,
  type PluginRuleName,
  type PluginRuleTier,
} from "../configs/recommended.js";
import {
  computeProjectFingerprint,
  loadParsedTsConfig,
  readCachedArtifact,
  resolveCacheDir,
  resolveTsBuildInfoPath,
  resolveTsConfigPath,
  writeCachedArtifact,
} from "./incremental-cache.js";
import {
  requestDaemonStatus,
  runLintViaDaemon,
  stopWorkspaceDaemon,
} from "./strict-fp-daemon.js";

export type PhasedLintOptions = {
  readonly targets: ReadonlyArray<string>;
  readonly fix: boolean;
  readonly format: string;
  readonly maxTier: LintTier;
  readonly onlyTier?: LintTier;
  readonly tsconfig?: string;
  readonly cwd?: string;
  readonly cache?: boolean;
  readonly cacheLocation?: string;
  readonly eslintCache?: boolean;
  readonly daemon?: boolean;
  readonly daemonStop?: boolean;
  readonly daemonStatus?: boolean;
};

export type PhasedLintDependencies = {
  readonly ESLintClass?: typeof ESLint;
};

export type TierRunSummary = {
  readonly tier: LintTier;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly output: string;
};

export type PhasedLintResult = {
  readonly passed: boolean;
  readonly failedTier?: LintTier;
  readonly summaries: ReadonlyArray<TierRunSummary>;
  readonly cacheHit?: boolean;
};

const tierLabels: Record<LintTier, string> = {
  0: `Tier 0 (${tier0TypeChecker.name} — ${tier0TypeChecker.command})`,
  1: "Tier 1 (Type Safety & Correctness)",
  2: "Tier 2 (Architecture & DDD)",
  3: "Tier 3 (FP & Style)",
};

export const classifyRuleTier = (ruleId: string): PluginRuleTier => {
  if (ruleId.startsWith("strict-fp/")) {
    const shortName = ruleId.slice("strict-fp/".length);
    return Object.prototype.hasOwnProperty.call(ruleTiers, shortName)
      ? ruleTiers[shortName as PluginRuleName]
      : 3;
  }
  return 1;
};

export const classifyMessageTier = (
  message: Pick<Linter.LintMessage, "fatal" | "ruleId">,
): PluginRuleTier => {
  if (message.fatal === true || message.ruleId === null || message.ruleId === undefined) {
    return 1;
  }
  return classifyRuleTier(message.ruleId);
};

export const createTierRuleFilter =
  (tier: LintTier) =>
  ({ ruleId }: { readonly ruleId: string }) =>
    tier !== 0 && classifyRuleTier(ruleId) <= tier;

export const createExactTierRuleFilter =
  (tier: LintTier) =>
  ({ ruleId }: { readonly ruleId: string }) =>
    tier !== 0 && classifyRuleTier(ruleId) === tier;

const parseTier = (raw: string | undefined) => {
  if (raw === "0") return 0 as const;
  if (raw === "1") return 1 as const;
  if (raw === "2") return 2 as const;
  if (raw === "3") return 3 as const;
  return undefined;
};

export const parseCliArgs = (args: ReadonlyArray<string>) => {
  let targets: ReadonlyArray<string> = [];
  let fix = false;
  let format = "stylish";
  let maxTier: LintTier = 3;
  let onlyTier: LintTier | undefined;
  let tsconfig: string | undefined;
  let cache: boolean | undefined;
  let cacheLocation: string | undefined;
  let eslintCache: boolean | undefined;
  let daemon: boolean | undefined;
  let daemonStop: boolean | undefined;
  let daemonStatus: boolean | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--fix") {
      fix = true;
    } else if (arg === "--cache") {
      cache = true;
    } else if (arg === "--no-cache") {
      cache = false;
    } else if ((arg === "--cache-location" || arg === "--cache-dir") && args[i + 1]) {
      cacheLocation = args[i + 1];
      i += 1;
    } else if (arg === "--eslint-cache") {
      eslintCache = true;
    } else if (arg === "--daemon") {
      daemon = true;
    } else if (arg === "--daemon-stop") {
      daemonStop = true;
    } else if (arg === "--daemon-status") {
      daemonStatus = true;
    } else if (arg === "--format" && args[i + 1]) {
      format = args[i + 1] ?? "stylish";
      i += 1;
    } else if (arg === "--max-tier") {
      maxTier = parseTier(args[i + 1]) ?? 3;
      i += 1;
    } else if (arg === "--tier") {
      onlyTier = parseTier(args[i + 1]);
      i += 1;
    } else if ((arg === "--tsconfig" || arg === "--project" || arg === "-p") && args[i + 1]) {
      tsconfig = args[i + 1];
      i += 1;
    } else if (arg && !arg.startsWith("-")) {
      targets = [...targets, arg];
    }
  }

  return {
    targets: targets.length > 0 ? targets : ["."],
    fix,
    format,
    maxTier,
    ...(onlyTier !== undefined ? { onlyTier } : {}),
    ...(tsconfig !== undefined ? { tsconfig } : {}),
    ...(cache !== undefined ? { cache } : {}),
    ...(cacheLocation !== undefined ? { cacheLocation } : {}),
    ...(eslintCache !== undefined ? { eslintCache } : {}),
    ...(daemon !== undefined ? { daemon } : {}),
    ...(daemonStop !== undefined ? { daemonStop } : {}),
    ...(daemonStatus !== undefined ? { daemonStatus } : {}),
  } satisfies PhasedLintOptions;
};

const tiersUpTo: Record<LintTier, ReadonlyArray<LintTier>> = {
  0: [0],
  1: [0, 1],
  2: [0, 1, 2],
  3: [0, 1, 2, 3],
};

const resolveTiersToRun = (options: PhasedLintOptions): ReadonlyArray<LintTier> =>
  options.onlyTier !== undefined ? [options.onlyTier] : tiersUpTo[options.maxTier];

const findLocalTscBin = (startDir: string) => {
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, "node_modules", "typescript", "bin", "tsc");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
};

const resolveTscCommand = (cwd: string) => {
  const localTsc = findLocalTscBin(cwd);
  if (localTsc !== undefined) {
    return { command: process.execPath, prefixArgs: [localTsc] as ReadonlyArray<string> };
  }
  try {
    const require = createRequire(import.meta.url);
    const resolvedTsc = require.resolve("typescript/bin/tsc");
    return { command: process.execPath, prefixArgs: [resolvedTsc] as ReadonlyArray<string> };
  } catch {
    return { command: "tsc", prefixArgs: [] as ReadonlyArray<string> };
  }
};

const countTscErrors = (output: string) => {
  const matches = output.match(/(?:^|\s)error TS\d+:/gm);
  return matches && matches.length > 0 ? matches.length : 1;
};

const buildIncrementalTscArgs = (
  cwd: string,
  tsconfig: string | undefined,
  cacheDir: string | undefined,
) => {
  if (!cacheDir) {
    return ["--incremental", "false"] as ReadonlyArray<string>;
  }
  const tsconfigPath = resolveTsConfigPath(cwd, tsconfig);
  if (!tsconfigPath || !fs.existsSync(tsconfigPath)) {
    return [] as ReadonlyArray<string>;
  }
  const parsed = loadParsedTsConfig(tsconfigPath);
  if (parsed?.options.composite === true) {
    return [] as ReadonlyArray<string>;
  }
  const tsBuildInfoPath = resolveTsBuildInfoPath(cacheDir, "tsc", tsconfigPath);
  return ["--incremental", "--tsBuildInfoFile", tsBuildInfoPath] as ReadonlyArray<string>;
};

const runTypeCheck = (
  cwd: string,
  tsconfig: string | undefined,
  cacheDir: string | undefined,
) =>
  new Promise<TierRunSummary>((resolve) => {
    const { command, prefixArgs } = resolveTscCommand(cwd);
    const incrementalArgs = buildIncrementalTscArgs(cwd, tsconfig, cacheDir);
    const tscArgs = [
      ...prefixArgs,
      "--noEmit",
      ...(tsconfig ? ["-p", tsconfig] : []),
      ...incrementalArgs,
    ];

    execFile(
      command,
      tscArgs,
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const combinedOutput = [stdout, stderr]
          .filter((chunk) => chunk.trim().length > 0)
          .join("\n")
          .trim();

        if (!error) {
          resolve({
            tier: 0,
            errorCount: 0,
            warningCount: 0,
            output: combinedOutput,
          });
          return;
        }

        const output = combinedOutput.length > 0 ? combinedOutput : error.message;
        resolve({
          tier: 0,
          errorCount: countTscErrors(output),
          warningCount: 0,
          output,
        });
      },
    );
  });

export const sliceLintResultsForTier = (
  results: ReadonlyArray<ESLint.LintResult>,
  tier: PluginRuleTier,
): Array<ESLint.LintResult> =>
  results.map((result) => {
    const messages = result.messages.filter((msg) => classifyMessageTier(msg) === tier);
    const suppressedMessages = result.suppressedMessages.filter(
      (msg) => classifyMessageTier(msg) === tier,
    );
    const usedDeprecatedRules = result.usedDeprecatedRules.filter(
      (entry) => classifyRuleTier(entry.ruleId) === tier,
    );

    let errorCount = 0;
    let fatalErrorCount = 0;
    let warningCount = 0;
    let fixableErrorCount = 0;
    let fixableWarningCount = 0;

    for (const msg of messages) {
      if (msg.fatal === true || msg.severity === 2) {
        errorCount += 1;
        if (msg.fatal === true) {
          fatalErrorCount += 1;
        }
        if (msg.fix !== undefined) {
          fixableErrorCount += 1;
        }
      } else if (msg.severity === 1) {
        warningCount += 1;
        if (msg.fix !== undefined) {
          fixableWarningCount += 1;
        }
      }
    }

    const { source, ...rest } = result;
    const hasMessages = messages.length > 0 || suppressedMessages.length > 0;
    return {
      ...rest,
      ...(hasMessages && source !== undefined ? { source } : {}),
      messages,
      suppressedMessages,
      usedDeprecatedRules,
      errorCount,
      fatalErrorCount,
      warningCount,
      fixableErrorCount,
      fixableWarningCount,
    };
  });

const buildTierSummary = async (
  tier: PluginRuleTier,
  results: Array<ESLint.LintResult>,
  formatter: ESLint.Formatter,
): Promise<TierRunSummary> => {
  const errorCount = results.reduce((sum, r) => sum + r.errorCount, 0);
  const warningCount = results.reduce((sum, r) => sum + r.warningCount, 0);
  const output = await formatter.format(results);
  return { tier, errorCount, warningCount, output };
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

const runNonFixPhased = async (
  tiers: ReadonlyArray<LintTier>,
  options: PhasedLintOptions,
  cwd: string,
  EslintCtor: typeof ESLint,
): Promise<PhasedLintResult> => {
  const useCache = options.cache !== false;
  const cacheDir = useCache ? resolveCacheDir(cwd, options.cacheLocation) : undefined;
  const tsconfigPath = resolveTsConfigPath(cwd, options.tsconfig);
  const scopeKey = buildLintCacheScopeKey(options);
  const projectFingerprint = useCache
    ? computeProjectFingerprint({
        cwd,
        kind: "lint",
        ...(tsconfigPath !== undefined ? { tsconfigPath } : {}),
        targets: options.targets,
        scopeKey,
      })
    : undefined;

  if (cacheDir && projectFingerprint) {
    const cached = readCachedArtifact<PhasedLintResult>(
      cacheDir,
      "lint",
      scopeKey,
      projectFingerprint,
    );
    if (cached) {
      return { ...cached, cacheHit: true };
    }
  }

  let singlePass:
    | {
        readonly results: Array<ESLint.LintResult>;
        readonly formatter: ESLint.Formatter;
      }
    | undefined;

  const getSinglePass = async () => {
    if (!singlePass) {
      const ruleFilter =
        options.onlyTier !== undefined
          ? createExactTierRuleFilter(options.onlyTier)
          : createTierRuleFilter(options.maxTier);
      const eslintOptions: ESLint.Options = {
        cwd,
        fix: false,
        ruleFilter,
        ...(options.eslintCache === true && cacheDir
          ? {
              cache: true,
              cacheStrategy: "content" as const,
              cacheLocation: path.join(cacheDir, "eslint-cache.json"),
            }
          : {}),
      };
      const eslint = new EslintCtor(eslintOptions);
      const results = await eslint.lintFiles([...options.targets]);
      const formatter = await eslint.loadFormatter(options.format);
      singlePass = { results, formatter };
    }
    return singlePass;
  };

  let summaries: ReadonlyArray<TierRunSummary> = [];
  for (const tier of tiers) {
    let summary: TierRunSummary;
    if (tier === 0) {
      summary = await runTypeCheck(cwd, options.tsconfig, cacheDir);
    } else {
      const pass = await getSinglePass();
      const tierResults =
        options.onlyTier !== undefined ? pass.results : sliceLintResultsForTier(pass.results, tier);
      summary = await buildTierSummary(tier, tierResults, pass.formatter);
    }

    summaries = [...summaries, summary];
    if (summary.errorCount > 0) {
      const failedResult: PhasedLintResult = { passed: false, failedTier: tier, summaries };
      if (cacheDir && projectFingerprint) {
        writeCachedArtifact(cacheDir, "lint", scopeKey, projectFingerprint, failedResult);
      }
      return failedResult;
    }
  }

  const passedResult: PhasedLintResult = { passed: true, summaries };
  if (cacheDir && projectFingerprint) {
    writeCachedArtifact(cacheDir, "lint", scopeKey, projectFingerprint, passedResult);
  }
  return passedResult;
};

const runTierForFix = async (
  tier: LintTier,
  options: PhasedLintOptions,
  cwd: string,
  EslintCtor: typeof ESLint,
): Promise<{ readonly summary: TierRunSummary; readonly didMutate: boolean }> => {
  if (tier === 0) {
    const cacheDir =
      options.cache !== false ? resolveCacheDir(cwd, options.cacheLocation) : undefined;
    return { summary: await runTypeCheck(cwd, options.tsconfig, cacheDir), didMutate: false };
  }

  const eslint = new EslintCtor({
    cwd,
    fix: true,
    ruleFilter: createExactTierRuleFilter(tier),
  });
  const results = await eslint.lintFiles([...options.targets]);
  const didMutate = results.some((r) => r.output !== undefined);
  if (didMutate) {
    await EslintCtor.outputFixes(results);
  }
  const formatter = await eslint.loadFormatter(options.format);
  const summary = await buildTierSummary(tier, results, formatter);
  return { summary, didMutate };
};

const runFixPhased = async (
  tiers: ReadonlyArray<LintTier>,
  options: PhasedLintOptions,
  cwd: string,
  EslintCtor: typeof ESLint,
): Promise<PhasedLintResult> => {
  let summaries: ReadonlyArray<TierRunSummary> = [];

  for (const tier of tiers) {
    const { summary, didMutate } = await runTierForFix(tier, options, cwd, EslintCtor);
    summaries = [...summaries, summary];
    if (summary.errorCount > 0) {
      return { passed: false, failedTier: tier, summaries };
    }

    if (didMutate && tier > 0 && options.onlyTier === undefined) {
      const prevMaxTier = (tier - 1) as 0 | 1 | 2;
      const recheck = await runNonFixPhased(
        tiersUpTo[prevMaxTier],
        { ...options, fix: false, maxTier: prevMaxTier },
        cwd,
        EslintCtor,
      );
      if (!recheck.passed && recheck.failedTier !== undefined) {
        const failedSummary = recheck.summaries[recheck.summaries.length - 1];
        return {
          passed: false,
          failedTier: recheck.failedTier,
          summaries: failedSummary ? [...summaries, failedSummary] : summaries,
        };
      }
    }
  }

  return { passed: true, summaries };
};

export const runPhasedLint = async (
  options: PhasedLintOptions,
  deps?: PhasedLintDependencies,
): Promise<PhasedLintResult> => {
  const tiers = resolveTiersToRun(options);
  const cwd = options.cwd ?? process.cwd();
  const EslintCtor = deps?.ESLintClass ?? ESLint;

  if (options.daemon === true && !options.fix && !deps?.ESLintClass) {
    return runLintViaDaemon({ ...options, cwd });
  }

  return options.fix
    ? runFixPhased(tiers, options, cwd, EslintCtor)
    : runNonFixPhased(tiers, options, cwd, EslintCtor);
};

const runCli = async () => {
  const options = parseCliArgs(process.argv.slice(2));
  const cwd = process.cwd();

  if (options.daemonStop === true) {
    const stopped = await stopWorkspaceDaemon(cwd);
    console.log(
      stopped
        ? "[strict-fp-lint] Stopped workspace daemon."
        : "[strict-fp-lint] No running workspace daemon found.",
    );
    return;
  }

  if (options.daemonStatus === true) {
    const status = await requestDaemonStatus(cwd);
    if (status.running) {
      console.log(
        `[strict-fp-lint] Daemon running (pid=${String(status.pid)}, uptime=${String(status.uptimeMs)}ms, requests=${String(status.requestsServed)})`,
      );
    } else {
      console.log("[strict-fp-lint] Daemon is not running.");
    }
    return;
  }

  const result = await runPhasedLint(options);

  for (const summary of result.summaries) {
    const label = tierLabels[summary.tier];
    if (summary.errorCount > 0) {
      console.error(`\n[strict-fp-lint] FAILED at ${label} (${String(summary.errorCount)} error(s)):\n`);
      if (summary.output.trim().length > 0) {
        console.error(summary.output);
      }
    } else {
      console.log(`[strict-fp-lint] PASSED ${label}`);
    }
  }

  if (!result.passed) {
    process.exit(1);
  }
};

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryUrl) {
  runCli().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
