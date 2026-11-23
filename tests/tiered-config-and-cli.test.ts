import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TSESLint } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { pipe } from "fp-ts/lib/function.js";
import * as S from "fp-ts/lib/string.js";
import { describe, expect, it } from "vitest";
import strictFp, {
  configs,
  createTieredConfig,
  rules,
  ruleTiers,
  tier0TypeChecker,
  tier1Rules,
  tier2Rules,
  tier3Rules,
} from "../src/index.js";
import { defaultStrictFpFiles, defaultStrictFpIgnores } from "../src/configs/recommended.js";
import { createTierRuleFilter, parseCliArgs, runPhasedLint } from "../src/cli/strict-fp-lint.js";

const findTierBlock = (configList: ReadonlyArray<TSESLint.FlatConfig.Config>, name: string) =>
  pipe(
    configList,
    RA.findFirst((c) => c.name === name),
    O.toUndefined,
  );

const createTempProjectDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "strict-fp-phased-"));

describe("tiered configs and React/Expo exclusions", () => {
  it("exposes Tier 0 Type Checker (tsc --noEmit) metadata and empty ESLint tier0 preset", () => {
    expect(tier0TypeChecker).toEqual({
      tier: 0,
      name: "Type Checker",
      command: "tsc --noEmit",
      description: 'Type soundness — "Does this code obey TypeScript\'s type system?"',
    });

    expect(findTierBlock(configs.tier0, "strict-fp/tier-0")?.rules).toEqual({});
    expect(findTierBlock(configs.tier0, "strict-fp/react-thin-tsx")).toBeUndefined();
  });

  it("excludes .tsx and *.config.ts from strict .ts rules and includes thin-tsx block", () => {
    expect(defaultStrictFpFiles).toEqual(["**/*.ts"]);
    expect(defaultStrictFpIgnores).toEqual(["**/*.tsx", "**/*.config.ts"]);

    const tiered = createTieredConfig(strictFp, { maxTier: 1 });
    const mainBlock = findTierBlock(tiered, "strict-fp/tier-1");
    const tsxBlock = findTierBlock(tiered, "strict-fp/react-thin-tsx");
    expect(mainBlock?.files).toEqual(["**/*.ts"]);
    expect(mainBlock?.ignores).toEqual(["**/*.tsx", "**/*.config.ts"]);
    expect(tsxBlock?.files).toEqual(["**/*.tsx"]);
    expect(tsxBlock?.rules).toEqual({ "strict-fp/thin-react-component": "error" });
  });

  it("builds cumulative tier1, tier2, and tier3 presets", () => {
    const t1Rules = findTierBlock(configs.tier1, "strict-fp/tier-1")?.rules as
      | Record<string, TSESLint.FlatConfig.RuleEntry>
      | undefined;
    const t2Rules = findTierBlock(configs.tier2, "strict-fp/tier-2")?.rules as
      | Record<string, TSESLint.FlatConfig.RuleEntry>
      | undefined;
    const t3Rules = findTierBlock(configs.tier3, "strict-fp/tier-3")?.rules as
      | Record<string, TSESLint.FlatConfig.RuleEntry>
      | undefined;

    expect(t1Rules).toBeDefined();
    expect(t2Rules).toBeDefined();
    expect(t3Rules).toBeDefined();

    pipe(
      Object.keys(tier1Rules),
      RA.map((ruleId) => {
        expect(t1Rules?.[ruleId]).toBeDefined();
        expect(t2Rules?.[ruleId]).toBeDefined();
        expect(t3Rules?.[ruleId]).toBeDefined();
      }),
    );

    pipe(
      Object.keys(tier2Rules),
      RA.map((ruleId) => {
        expect(t1Rules?.[ruleId]).toBeUndefined();
        expect(t2Rules?.[ruleId]).toBeDefined();
        expect(t3Rules?.[ruleId]).toBeDefined();
      }),
    );

    pipe(
      Object.keys(tier3Rules),
      RA.map((ruleId) => {
        expect(t1Rules?.[ruleId]).toBeUndefined();
        expect(t2Rules?.[ruleId]).toBeUndefined();
        expect(t3Rules?.[ruleId]).toBeDefined();
      }),
    );
  });

  it("maps every plugin rule in ruleTiers to a numeric tier (1 | 2 | 3) with no missing or extra entries", () => {
    expect(pipe(RR.keys(ruleTiers), RA.sort(S.Ord))).toEqual(pipe(RR.keys(rules), RA.sort(S.Ord)));
    expect(
      pipe(
        Object.values(ruleTiers),
        RA.every((tier: number) => [1, 2, 3].includes(tier)),
      ),
    ).toBe(true);

    const fpDiscoveryBlock = findTierBlock(configs.fpDiscovery, "strict-fp/fp-discovery");
    expect(fpDiscoveryBlock?.rules).toEqual({
      "strict-fp/no-structural-skeleton-duplication": "error",
      "strict-fp/prefer-catamorphism-over-recursive-adt-walk": "error",
      "strict-fp/prefer-reader-over-context-drilling": "error",
    });
  });

  it("enables all 4 ts-unit architectural rules as error in Tier 1 with entryPoints, boundaryFiles, and testFiles overrides", () => {
    const tiered = createTieredConfig(strictFp, {
      maxTier: 1,
      entryPoints: ["src/index.ts"],
      boundaryFiles: ["src/cli/**"],
      testFiles: ["tests/**/*.ts"],
    });
    const mainBlock = findTierBlock(tiered, "strict-fp/tier-1");
    const boundaryBlock = findTierBlock(tiered, "strict-fp/boundary-overrides");
    const testBlock = findTierBlock(tiered, "strict-fp/test-overrides");

    const mainRules = mainBlock?.rules as Record<string, TSESLint.FlatConfig.RuleEntry> | undefined;
    expect(mainRules?.["strict-fp/module-cohesion"]).toBe("error");
    expect(mainRules?.["strict-fp/functional-core-boundary"]).toBe("error");
    expect(mainRules?.["strict-fp/no-single-caller-export"]).toEqual([
      "error",
      { entryPoints: ["src/index.ts"], testPatterns: ["tests/**/*.ts"] },
    ]);
    expect(mainRules?.["strict-fp/common-reuse-cohesion"]).toEqual([
      "error",
      { testPatterns: ["tests/**/*.ts"] },
    ]);

    const boundaryRules = boundaryBlock?.rules as Record<string, TSESLint.FlatConfig.RuleEntry> | undefined;
    expect(boundaryRules?.["strict-fp/functional-core-boundary"]).toBe("off");

    const testRules = testBlock?.rules as Record<string, TSESLint.FlatConfig.RuleEntry> | undefined;
    expect(testRules?.["strict-fp/module-cohesion"]).toBe("off");
    expect(testRules?.["strict-fp/functional-core-boundary"]).toBe("off");
    expect(testRules?.["strict-fp/no-single-caller-export"]).toBe("off");
    expect(testRules?.["strict-fp/common-reuse-cohesion"]).toBe("off");
  });
});

describe("strict-fp-lint CLI helpers and phased runner", () => {
  it("filters rules accurately per tier", () => {
    const t0Filter = createTierRuleFilter(0);
    const t1Filter = createTierRuleFilter(1);
    const t2Filter = createTierRuleFilter(2);

    expect(t0Filter({ ruleId: "strict-fp/domain-layer-purity" })).toBe(false);
    expect(t0Filter({ ruleId: "@typescript-eslint/no-unsafe-assignment" })).toBe(false);

    expect(t1Filter({ ruleId: "strict-fp/domain-layer-purity" })).toBe(true);
    expect(t1Filter({ ruleId: "strict-fp/no-react-in-ts" })).toBe(true);
    expect(t1Filter({ ruleId: "strict-fp/thin-react-component" })).toBe(true);
    expect(t1Filter({ ruleId: "strict-fp/no-any-or-unknown" })).toBe(false);
    expect(t1Filter({ ruleId: "strict-fp/no-let-or-var" })).toBe(false);
    expect(t1Filter({ ruleId: "@typescript-eslint/no-unsafe-assignment" })).toBe(false);

    expect(t2Filter({ ruleId: "strict-fp/domain-layer-purity" })).toBe(true);
    expect(t2Filter({ ruleId: "strict-fp/no-any-or-unknown" })).toBe(true);
    expect(t2Filter({ ruleId: "@typescript-eslint/no-unsafe-assignment" })).toBe(true);
    expect(t2Filter({ ruleId: "strict-fp/no-let-or-var" })).toBe(false);

    expect(createTierRuleFilter(3)({ ruleId: "strict-fp/no-let-or-var" })).toBe(true);
  });

  it("parses CLI flags including Tier 0 and tsconfig options", () => {
    expect(parseCliArgs(["--fix", "--max-tier", "2", "--format", "json", "src/domain"])).toEqual({
      targets: ["src/domain"],
      fix: true,
      format: "json",
      maxTier: 2,
    });
    expect(parseCliArgs(["--tier", "1"])).toEqual({
      targets: ["."],
      fix: false,
      format: "stylish",
      maxTier: 3,
      onlyTier: 1,
    });
    expect(parseCliArgs(["--tier", "0", "--tsconfig", "tsconfig.app.json"])).toEqual({
      targets: ["."],
      fix: false,
      format: "stylish",
      maxTier: 3,
      onlyTier: 0,
      tsconfig: "tsconfig.app.json",
    });
    expect(parseCliArgs(["--max-tier", "0", "-p", "tsconfig.check.json"])).toEqual({
      targets: ["."],
      fix: false,
      format: "stylish",
      maxTier: 0,
      tsconfig: "tsconfig.check.json",
    });
  });

  it("enforces tsc --noEmit as Tier 0 and stops before Tier 1 on type errors", async () => {
    const tmpDir = createTempProjectDir();
    try {
      const distEntry = path.resolve(import.meta.dirname, "../dist/index.js");
      const tsconfigJson = JSON.stringify({
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
        include: ["**/*.ts"],
      });
      fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), tsconfigJson);
      fs.writeFileSync(
        path.join(tmpDir, "eslint.config.mjs"),
        `import strictFp from ${JSON.stringify(distEntry)};
export default [
  ...strictFp.createTieredConfig({ maxTier: 3 }),
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
];
`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "broken.ts"),
        'export type Retry = { readonly timeoutMs: number };\nexport const invalidNumber: number = "not-a-number";\n',
      );

      const result = await runPhasedLint({
        targets: ["."],
        fix: false,
        format: "json",
        maxTier: 3,
        cwd: tmpDir,
      });

      const [tier0Summary] = result.summaries;
      expect(result.passed).toBe(false);
      expect(result.failedTier).toBe(0);
      expect(result.summaries).toHaveLength(1);
      expect(tier0Summary?.tier).toBe(0);
      expect(tier0Summary?.errorCount).toBe(1);
      expect(tier0Summary?.output).toContain("TS2322");

      const cliEntry = path.resolve(import.meta.dirname, "../dist/cli/strict-fp-lint.js");
      const cliRun = spawnSync(process.execPath, [cliEntry], { cwd: tmpDir, encoding: "utf8" });
      expect(cliRun.status).toBe(1);
      expect(cliRun.stderr).toContain("FAILED at Tier 0 (Type Checker — tsc --noEmit)");
      expect(cliRun.stderr).toContain("TS2322");

      const customTsconfig = JSON.stringify({
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
        include: ["valid.ts"],
      });
      fs.writeFileSync(path.join(tmpDir, "tsconfig.valid.json"), customTsconfig);
      fs.writeFileSync(path.join(tmpDir, "valid.ts"), "export const answer = 42;\n");

      const tier0OnlyPass = await runPhasedLint({
        targets: ["."],
        fix: false,
        format: "json",
        maxTier: 3,
        onlyTier: 0,
        tsconfig: "tsconfig.valid.json",
        cwd: tmpDir,
      });
      const [onlyTier0Summary] = tier0OnlyPass.summaries;
      expect(tier0OnlyPass.passed).toBe(true);
      expect(tier0OnlyPass.summaries).toHaveLength(1);
      expect(onlyTier0Summary?.tier).toBe(0);
      expect(onlyTier0Summary?.errorCount).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("passes Tier 0 then stops at Tier 1 on architectural or React/TSX boundary errors and ignores *.config.ts", async () => {
    const tmpDir = createTempProjectDir();
    try {
      const distEntry = path.resolve(import.meta.dirname, "../dist/index.js");
      const tsconfigJson = JSON.stringify({
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, jsx: "preserve" },
        include: ["**/*.ts", "**/*.tsx", "**/*.d.ts"],
      });
      fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), tsconfigJson);
      fs.writeFileSync(
        path.join(tmpDir, "jsx.d.ts"),
        "declare namespace JSX { interface IntrinsicElements { readonly div: Readonly<Record<string, unknown>>; } }\n",
      );
      fs.writeFileSync(
        path.join(tmpDir, "eslint.config.mjs"),
        `import strictFp from ${JSON.stringify(distEntry)};
export default [
  ...strictFp.createTieredConfig({ maxTier: 3 }),
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
];
`,
      );
      fs.writeFileSync(path.join(tmpDir, "App.tsx"), "export const App = () => <div />;\n");
      fs.writeFileSync(path.join(tmpDir, "BadApp.tsx"), "const helper = (n: number) => n + 1; export const BadApp = () => <div>{helper(1)}</div>;\n");
      fs.writeFileSync(path.join(tmpDir, "app.config.ts"), "let cfg: any = { name: 'app' }; export default cfg;\n");
      fs.writeFileSync(path.join(tmpDir, "logic.ts"), "export type Retry = { readonly timeoutMs: number };\nexport const fn = () => { let count = 1; return count; };\n");

      const result = await runPhasedLint({
        targets: ["."],
        fix: false,
        format: "json",
        maxTier: 3,
        cwd: tmpDir,
      });

      const [tier0Summary, tier1Summary] = result.summaries;
      expect(result.passed).toBe(false);
      expect(result.failedTier).toBe(1);
      expect(result.summaries).toHaveLength(2);
      expect(tier0Summary?.tier).toBe(0);
      expect(tier0Summary?.errorCount).toBe(0);
      expect(tier1Summary?.tier).toBe(1);
      expect(tier1Summary?.errorCount).toBeGreaterThan(0);

      const cleanTsxAndConfigResult = await runPhasedLint({
        targets: ["App.tsx", "app.config.ts"],
        fix: false,
        format: "json",
        maxTier: 3,
        cwd: tmpDir,
      });
      expect(cleanTsxAndConfigResult.passed).toBe(true);
      expect(RA.map((s: { readonly tier: number }) => s.tier)(cleanTsxAndConfigResult.summaries)).toEqual([
        0, 1, 2, 3,
      ]);

      const badTsxResult = await runPhasedLint({
        targets: ["BadApp.tsx"],
        fix: false,
        format: "json",
        maxTier: 3,
        cwd: tmpDir,
      });
      expect(badTsxResult.passed).toBe(false);
      expect(badTsxResult.failedTier).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
