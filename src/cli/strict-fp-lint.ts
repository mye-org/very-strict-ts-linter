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

export type PhasedLintOptions = {
  readonly targets: ReadonlyArray<string>;
  readonly fix: boolean;
  readonly format: string;
  readonly maxTier: LintTier;
  readonly onlyTier?: LintTier;
  readonly tsconfig?: string;
  readonly cwd?: string;
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
};

const tierLabels: Record<LintTier, string> = {
  0: `Tier 0 (${tier0TypeChecker.name} — ${tier0TypeChecker.command})`,
  1: "Tier 1 (Architecture & DDD)",
  2: "Tier 2 (Type Safety & Correctness)",
  3: "Tier 3 (FP & Style)",
};

export const classifyRuleTier = (ruleId: string): PluginRuleTier => {
  if (ruleId.startsWith("strict-fp/")) {
    const shortName = ruleId.slice("strict-fp/".length);
    return Object.prototype.hasOwnProperty.call(ruleTiers, shortName)
      ? ruleTiers[shortName as PluginRuleName]
      : 3;
  }
  return 2;
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

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--fix") {
      fix = true;
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

const runTypeCheck = (cwd: string, tsconfig: string | undefined) =>
  new Promise<TierRunSummary>((resolve) => {
    const { command, prefixArgs } = resolveTscCommand(cwd);
    const tscArgs = [...prefixArgs, "--noEmit", ...(tsconfig ? ["-p", tsconfig] : [])];

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

const runNonFixPhased = async (
  tiers: ReadonlyArray<LintTier>,
  options: PhasedLintOptions,
  cwd: string,
  EslintCtor: typeof ESLint,
): Promise<PhasedLintResult> => {
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
      const eslint = new EslintCtor({ cwd, fix: false, ruleFilter });
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
      summary = await runTypeCheck(cwd, options.tsconfig);
    } else {
      const pass = await getSinglePass();
      const tierResults =
        options.onlyTier !== undefined ? pass.results : sliceLintResultsForTier(pass.results, tier);
      summary = await buildTierSummary(tier, tierResults, pass.formatter);
    }

    summaries = [...summaries, summary];
    if (summary.errorCount > 0) {
      return { passed: false, failedTier: tier, summaries };
    }
  }

  return { passed: true, summaries };
};

const runTierForFix = async (
  tier: LintTier,
  options: PhasedLintOptions,
  cwd: string,
  EslintCtor: typeof ESLint,
): Promise<{ readonly summary: TierRunSummary; readonly didMutate: boolean }> => {
  if (tier === 0) {
    return { summary: await runTypeCheck(cwd, options.tsconfig), didMutate: false };
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

  return options.fix
    ? runFixPhased(tiers, options, cwd, EslintCtor)
    : runNonFixPhased(tiers, options, cwd, EslintCtor);
};

const runCli = async () => {
  const options = parseCliArgs(process.argv.slice(2));
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
