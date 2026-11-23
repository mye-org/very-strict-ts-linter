#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ESLint } from "eslint";
import {
  ruleTiers,
  tier0TypeChecker,
  type LintTier,
  type PluginRuleName,
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

export const createTierRuleFilter =
  (tier: LintTier) =>
  ({ ruleId }: { readonly ruleId: string }) => {
    if (tier === 0) {
      return false;
    }
    if (tier === 3) {
      return true;
    }
    if (ruleId.startsWith("strict-fp/")) {
      const shortName = ruleId.slice("strict-fp/".length);
      const ruleTier = Object.prototype.hasOwnProperty.call(ruleTiers, shortName)
        ? ruleTiers[shortName as PluginRuleName]
        : undefined;
      return typeof ruleTier === "number" && ruleTier <= tier;
    }
    return tier > 1;
  };

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

const allTiers = [0, 1, 2, 3] as const satisfies ReadonlyArray<LintTier>;

const resolveTiersToRun = (options: PhasedLintOptions) => {
  if (options.onlyTier !== undefined) {
    return [options.onlyTier] as const;
  }
  return allTiers.filter((t) => t <= options.maxTier);
};

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

const runEslintTier = async (tier: Exclude<LintTier, 0>, options: PhasedLintOptions) => {
  const eslint = new ESLint({
    cwd: options.cwd ?? process.cwd(),
    fix: options.fix,
    ruleFilter: createTierRuleFilter(tier),
  });
  const results = await eslint.lintFiles([...options.targets]);
  if (options.fix) {
    await ESLint.outputFixes(results);
  }
  const errorCount = results.reduce((sum, r) => sum + r.errorCount, 0);
  const warningCount = results.reduce((sum, r) => sum + r.warningCount, 0);
  const formatter = await eslint.loadFormatter(options.format);
  const output = await formatter.format(results);

  return { tier, errorCount, warningCount, output } satisfies TierRunSummary;
};

export const runPhasedLint = async (options: PhasedLintOptions) => {
  const tiers = resolveTiersToRun(options);
  const cwd = options.cwd ?? process.cwd();
  let summaries: ReadonlyArray<TierRunSummary> = [];

  for (const tier of tiers) {
    const summary =
      tier === 0 ? await runTypeCheck(cwd, options.tsconfig) : await runEslintTier(tier, options);

    summaries = [...summaries, summary];

    if (summary.errorCount > 0) {
      return { passed: false, failedTier: tier, summaries } satisfies PhasedLintResult;
    }
  }

  return { passed: true, summaries } satisfies PhasedLintResult;
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
