#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LintTier } from "../configs/recommended.js";

export type InitCliOptions = {
  readonly cwd: string;
  readonly force: boolean;
  readonly maxTier: LintTier;
  readonly help: boolean;
};

export type EslintConfigStatus = "created" | "overwritten" | "skipped";
export type PackageJsonStatus = "updated" | "unchanged" | "missing";

export type InitProjectResult = {
  readonly eslintConfigPath: string;
  readonly eslintConfigStatus: EslintConfigStatus;
  readonly packageJsonPath: string;
  readonly packageJsonStatus: PackageJsonStatus;
  readonly previousLintScript?: string;
  readonly existingOtherConfigs: ReadonlyArray<string>;
};

const DEFAULT_MAX_TIER: LintTier = 3;

const parseTier = (raw: string | undefined) => {
  if (raw === "0") return 0 as const;
  if (raw === "1") return 1 as const;
  if (raw === "2") return 2 as const;
  if (raw === "3") return 3 as const;
  return undefined;
};

export const parseInitArgs = (args: ReadonlyArray<string>, defaultCwd = process.cwd()) => {
  let cwd = defaultCwd;
  let force = false;
  let maxTier: LintTier = DEFAULT_MAX_TIER;
  let help = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if ((arg === "--max-tier" || arg === "--tier") && args[i + 1]) {
      maxTier = parseTier(args[i + 1]) ?? DEFAULT_MAX_TIER;
      i += 1;
    } else if (arg === "--cwd" && args[i + 1]) {
      cwd = path.resolve(defaultCwd, args[i + 1] ?? defaultCwd);
      i += 1;
    }
  }

  return {
    cwd,
    force,
    maxTier,
    help,
  } satisfies InitCliOptions;
};

export const buildEslintConfigTemplate = (maxTier: LintTier) => {
  const tierLine = maxTier < DEFAULT_MAX_TIER ? `\n    maxTier: ${String(maxTier)},` : "";
  return `import strictFp from "@mye-org/eslint-plugin-strict-fp";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  ...strictFp.createStrictFpConfig({${tierLine}
    // boundaryFiles: ["src/cli/**", "src/infra/**"],
    // testFiles: ["tests/**/*.ts", "**/*.test.ts"],
  }),
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
`;
};

const otherEslintConfigNames = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const syncPackageJsonLintScript = (packageJsonPath: string) => {
  if (!fs.existsSync(packageJsonPath)) {
    return { status: "missing" as const };
  }

  const raw = fs.readFileSync(packageJsonPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    return { status: "missing" as const };
  }

  const existingScripts = isRecord(parsed["scripts"]) ? parsed["scripts"] : {};
  const previousLint = typeof existingScripts["lint"] === "string" ? existingScripts["lint"] : undefined;

  if (previousLint === "strict-fp-lint") {
    return {
      status: "unchanged" as const,
      previousLintScript: previousLint,
    };
  }

  const updated = {
    ...parsed,
    scripts: {
      ...existingScripts,
      lint: "strict-fp-lint",
    },
  };

  fs.writeFileSync(packageJsonPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");

  return {
    status: "updated" as const,
    ...(previousLint !== undefined ? { previousLintScript: previousLint } : {}),
  };
};

export const runInit = (options: InitCliOptions) => {
  const eslintConfigPath = path.join(options.cwd, "eslint.config.ts");
  const packageJsonPath = path.join(options.cwd, "package.json");
  const existingOtherConfigs = otherEslintConfigNames.filter((name) =>
    fs.existsSync(path.join(options.cwd, name)),
  );

  const configExists = fs.existsSync(eslintConfigPath);
  let eslintConfigStatus: EslintConfigStatus = "skipped";

  if (!configExists || options.force) {
    fs.writeFileSync(eslintConfigPath, buildEslintConfigTemplate(options.maxTier), "utf8");
    eslintConfigStatus = configExists ? "overwritten" : "created";
  }

  const pkgResult = syncPackageJsonLintScript(packageJsonPath);

  return {
    eslintConfigPath,
    eslintConfigStatus,
    packageJsonPath,
    packageJsonStatus: pkgResult.status,
    ...(pkgResult.previousLintScript !== undefined
      ? { previousLintScript: pkgResult.previousLintScript }
      : {}),
    existingOtherConfigs,
  } satisfies InitProjectResult;
};

const printHelp = () => {
  console.log(`Usage: strict-fp-init [options]

Scaffold eslint.config.ts and configure "lint": "strict-fp-lint" in package.json.

Options:
  --max-tier <0|1|2|3>  Maximum lint tier to configure (default: 3)
  --force, -f           Overwrite existing eslint.config.ts
  --cwd <dir>           Target project directory (default: current directory)
  --help, -h            Show this help message
`);
};

const runCli = () => {
  const options = parseInitArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const result = runInit(options);

  if (result.eslintConfigStatus === "created") {
    console.log(`[strict-fp-init] Created ${result.eslintConfigPath}`);
  } else if (result.eslintConfigStatus === "overwritten") {
    console.log(`[strict-fp-init] Overwrote ${result.eslintConfigPath}`);
  } else {
    console.log(`[strict-fp-init] Skipped ${result.eslintConfigPath} (already exists; pass --force to overwrite)`);
  }

  if (result.existingOtherConfigs.length > 0) {
    console.warn(
      `[strict-fp-init] Warning: found existing ESLint config(s): ${result.existingOtherConfigs.join(", ")}. Remove or merge them so ESLint uses eslint.config.ts.`,
    );
  }

  if (result.packageJsonStatus === "updated") {
    const note = result.previousLintScript
      ? ` (replaced "${result.previousLintScript}")`
      : "";
    console.log(`[strict-fp-init] Set "scripts.lint": "strict-fp-lint" in ${result.packageJsonPath}${note}`);
  } else if (result.packageJsonStatus === "unchanged") {
    console.log(`[strict-fp-init] "scripts.lint" is already "strict-fp-lint" in ${result.packageJsonPath}`);
  } else {
    console.warn(`[strict-fp-init] Warning: package.json not found in ${options.cwd}; skipped setting "scripts.lint".`);
  }

  console.log(`\nNext steps:`);
  console.log(`  1. Run "npm run lint" (or "npx strict-fp-lint") for phased Tier 0 (tsc --noEmit) -> Tier 1 -> Tier 2 -> Tier 3 linting.`);
  console.log(`  2. Run "npx strict-fp-radar" to discover DDD/FP refactoring opportunities.`);
};

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryUrl) {
  try {
    runCli();
  } catch (err: unknown) {
    console.error(err);
    process.exit(1);
  }
}
