#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { ESLint } from "eslint";
import { tier1Rules, tier2Rules, type LintTier } from "../configs/recommended.js";

export type PhasedLintOptions = {
  readonly targets: ReadonlyArray<string>;
  readonly fix: boolean;
  readonly format: string;
  readonly maxTier: LintTier;
  readonly onlyTier?: LintTier;
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

const tier1RuleIds = new Set(Object.keys(tier1Rules));
const tier2RuleIds = new Set(Object.keys(tier2Rules));

const tierLabels: Record<LintTier, string> = {
  1: "Tier 1 (Architecture & DDD)",
  2: "Tier 2 (Type Safety & Correctness)",
  3: "Tier 3 (FP & Style)",
};

export const createTierRuleFilter =
  (tier: LintTier) =>
  ({ ruleId }: { readonly ruleId: string }) => {
    if (tier === 3) {
      return true;
    }
    if (ruleId.startsWith("strict-fp/")) {
      if (tier === 1) {
        return tier1RuleIds.has(ruleId);
      }
      return tier1RuleIds.has(ruleId) || tier2RuleIds.has(ruleId);
    }
    if (tier === 1) {
      return false;
    }
    return true;
  };

const parseTier = (raw: string | undefined) => {
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
  } satisfies PhasedLintOptions;
};

const allTiers = [1, 2, 3] as const satisfies ReadonlyArray<LintTier>;

const resolveTiersToRun = (options: PhasedLintOptions) => {
  if (options.onlyTier !== undefined) {
    return [options.onlyTier] as const;
  }
  return allTiers.filter((t) => t <= options.maxTier);
};

export const runPhasedLint = async (options: PhasedLintOptions) => {
  const tiers = resolveTiersToRun(options);
  let summaries: ReadonlyArray<TierRunSummary> = [];

  for (const tier of tiers) {
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

    summaries = [...summaries, { tier, errorCount, warningCount, output }];

    if (errorCount > 0) {
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
