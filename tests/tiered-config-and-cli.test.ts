import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearCaches } from "@typescript-eslint/parser";
import type { TSESLint } from "@typescript-eslint/utils";
import { ESLint } from "eslint";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { pipe } from "fp-ts/lib/function.js";
import * as S from "fp-ts/lib/string.js";
import { afterAll, describe, expect, it } from "vitest";
import strictFp, {
  configs,
  createTieredConfig,
  defaultStrictFpFiles,
  defaultStrictFpIgnores,
  rules,
  ruleTiers,
  tier0TypeChecker,
  tier1Rules,
  tier2Rules,
  tier3Rules,
} from "../src/index.js";
import {
  classifyMessageTier,
  classifyRuleTier,
  createExactTierRuleFilter,
  createTierRuleFilter,
  parseCliArgs,
  runPhasedLint,
  sliceLintResultsForTier,
  type TierRunSummary,
} from "../src/cli/strict-fp-lint.js";

const findTierBlock = (configList: ReadonlyArray<TSESLint.FlatConfig.Config>, name: string) =>
  pipe(
    configList,
    RA.findFirst((c) => c.name === name),
    O.toUndefined,
  );

const tmpRoot = os.tmpdir();

const createTempProjectDir = () =>
  pipe(
    "strict-fp-phased-",
    (prefix: string) => path.join(tmpRoot, prefix),
    (dirPath) => fs.mkdtempSync(dirPath),
  );

const readProjectFile = (dir: string, name: string) =>
  fs.readFileSync(path.join(dir, name), "utf8");

const extractSummaryTiers = RA.map((s: TierRunSummary) => s.tier);

const extractFixFlags = RA.map((c: ESLint.Options) => c.fix);

const createTrackingEslint = () => {
  let ctorCalls: ReadonlyArray<ESLint.Options> = [];
  let lintFilesCalls: ReadonlyArray<Parameters<ESLint["lintFiles"]>[0]> = [];

  class TrackingESLint extends ESLint {
    constructor(options?: ESLint.Options) {
      super(options);
      ctorCalls = RA.append(options ?? {})(ctorCalls);
    }

    override lintFiles(patterns: Parameters<ESLint["lintFiles"]>[0]) {
      lintFilesCalls = RA.append(patterns)(lintFilesCalls);
      return super.lintFiles(patterns);
    }
  }

  return {
    TrackingESLint,
    get ctorCalls() {
      return ctorCalls;
    },
    get lintFilesCalls() {
      return lintFilesCalls;
    },
  };
};

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

  it("excludes .tsx and *.config.ts from strict .ts rules and includes thin-tsx block in Tier 2+", () => {
    expect(defaultStrictFpFiles).toEqual(["**/*.ts"]);
    expect(defaultStrictFpIgnores).toEqual(["**/*.tsx", "**/*.config.ts"]);

    const tiered1 = createTieredConfig(strictFp, { maxTier: 1 });
    expect(findTierBlock(tiered1, "strict-fp/react-thin-tsx")).toBeUndefined();

    const tiered2 = createTieredConfig(strictFp, { maxTier: 2 });
    const mainBlock = findTierBlock(tiered2, "strict-fp/tier-2");
    const tsxBlock = findTierBlock(tiered2, "strict-fp/react-thin-tsx");
    expect(mainBlock?.files).toEqual(["**/*.ts"]);
    expect(mainBlock?.ignores).toEqual(["**/*.tsx", "**/*.config.ts"]);
    expect(tsxBlock?.files).toEqual(["**/*.tsx"]);
    expect(tsxBlock?.rules).toEqual({
      "no-sequences": "error",
      "strict-fp/no-unsafe-react-hooks": "error",
      "strict-fp/require-js-thread-schedule-on-rn": "error",
      "strict-fp/thin-react-component": "error",
    });
  });

  it("builds cumulative tier1, tier2, and tier3 presets with all plugin rules at error severity and no duplicate consistent-type-definitions", () => {
    const t1Rules = findTierBlock(configs.tier1, "strict-fp/tier-1")?.rules;
    const t2Rules = findTierBlock(configs.tier2, "strict-fp/tier-2")?.rules;
    const t3Rules = findTierBlock(configs.tier3, "strict-fp/tier-3")?.rules;

    expect(t1Rules).toBeDefined();
    expect(t2Rules).toBeDefined();
    expect(t3Rules).toBeDefined();
    expect(t1Rules?.["no-sequences"]).toBe("error");
    expect(t1Rules?.["@typescript-eslint/consistent-type-definitions"]).toBeUndefined();
    expect(t1Rules?.["@typescript-eslint/use-unknown-in-catch-callback-variable"]).toBe("off");
    expect(t1Rules?.["@typescript-eslint/no-unnecessary-type-parameters"]).toBe("off");

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

  it("enables all 4 ts-unit architectural rules as error in Tier 2 with entryPoints, boundaryFiles, and testFiles overrides", () => {
    const tiered = createTieredConfig(strictFp, {
      maxTier: 2,
      entryPoints: ["src/index.ts"],
      boundaryFiles: ["src/cli/**"],
      testFiles: ["tests/**/*.ts"],
    });
    const mainBlock = findTierBlock(tiered, "strict-fp/tier-2");
    const boundaryBlock = findTierBlock(tiered, "strict-fp/boundary-overrides");
    const testBlock = findTierBlock(tiered, "strict-fp/test-overrides");

    const mainRules = mainBlock?.rules;
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

    const boundaryRules = boundaryBlock?.rules;
    expect(boundaryRules?.["strict-fp/functional-core-boundary"]).toBe("off");

    const testRules = testBlock?.rules;
    expect(testRules?.["strict-fp/module-cohesion"]).toBe("off");
    expect(testRules?.["strict-fp/functional-core-boundary"]).toBe("off");
    expect(testRules?.["strict-fp/no-single-caller-export"]).toBe("off");
    expect(testRules?.["strict-fp/common-reuse-cohesion"]).toBe("off");
  });

  it("enables all 3 TestScope rules as error in Tier 2, forwards testFiles as testPatterns, and keeps them active in test-overrides", () => {
    const tiered = createTieredConfig(strictFp, {
      maxTier: 2,
      testFiles: ["tests/**/*.ts"],
    });
    const mainBlock = findTierBlock(tiered, "strict-fp/tier-2");
    const testBlock = findTierBlock(tiered, "strict-fp/test-overrides");
    const testScopeBlock = findTierBlock(configs.testScope, "strict-fp/test-scope");

    const mainRules = mainBlock?.rules;
    expect(mainRules?.["strict-fp/no-redundant-test-scope"]).toEqual([
      "error",
      { testPatterns: ["tests/**/*.ts"] },
    ]);
    expect(mainRules?.["strict-fp/prefer-lowest-test-level"]).toEqual([
      "error",
      { testPatterns: ["tests/**/*.ts"] },
    ]);
    expect(mainRules?.["strict-fp/single-test-responsibility"]).toEqual([
      "error",
      { testPatterns: ["tests/**/*.ts"] },
    ]);

    const testRules = testBlock?.rules;
    expect(testRules?.["strict-fp/no-redundant-test-scope"]).toBeUndefined();
    expect(testRules?.["strict-fp/prefer-lowest-test-level"]).toBeUndefined();
    expect(testRules?.["strict-fp/single-test-responsibility"]).toBeUndefined();

    expect(testScopeBlock?.rules).toEqual({
      "strict-fp/no-redundant-test-scope": "error",
      "strict-fp/prefer-lowest-test-level": "error",
      "strict-fp/single-test-responsibility": "error",
    });
  });
});

describe("strict-fp-lint CLI helpers and phased runner", () => {
  afterAll(clearCaches);

  it("filters rules accurately per tier", () => {
    const t0Filter = createTierRuleFilter(0);
    const t1Filter = createTierRuleFilter(1);
    const t2Filter = createTierRuleFilter(2);

    expect(t0Filter({ ruleId: "strict-fp/domain-layer-purity" })).toBe(false);
    expect(t0Filter({ ruleId: "@typescript-eslint/no-unsafe-assignment" })).toBe(false);

    expect(t1Filter({ ruleId: "strict-fp/no-any-or-unknown" })).toBe(true);
    expect(t1Filter({ ruleId: "@typescript-eslint/no-unsafe-assignment" })).toBe(true);
    expect(t1Filter({ ruleId: "strict-fp/domain-layer-purity" })).toBe(false);
    expect(t1Filter({ ruleId: "strict-fp/no-react-in-ts" })).toBe(false);
    expect(t1Filter({ ruleId: "strict-fp/thin-react-component" })).toBe(false);
    expect(t1Filter({ ruleId: "strict-fp/no-let-or-var" })).toBe(false);

    expect(t2Filter({ ruleId: "strict-fp/no-any-or-unknown" })).toBe(true);
    expect(t2Filter({ ruleId: "@typescript-eslint/no-unsafe-assignment" })).toBe(true);
    expect(t2Filter({ ruleId: "strict-fp/domain-layer-purity" })).toBe(true);
    expect(t2Filter({ ruleId: "strict-fp/no-react-in-ts" })).toBe(true);
    expect(t2Filter({ ruleId: "strict-fp/thin-react-component" })).toBe(true);
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
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022"], types: [], strict: true, skipLibCheck: true },
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
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022"], types: [], strict: true, skipLibCheck: true },
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

  it("passes Tier 0 and Tier 1 then stops at Tier 2 on architectural or React/TSX boundary errors and ignores *.config.ts", async () => {
    const tmpDir = createTempProjectDir();
    try {
      const distEntry = path.resolve(import.meta.dirname, "../dist/index.js");
      const tsconfigJson = JSON.stringify({
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022"], types: [], strict: true, skipLibCheck: true, jsx: "preserve" },
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
  { ignores: ["jsx.d.ts"] },
  ...strictFp.createTieredConfig({ maxTier: 3 }),
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
];
`,
      );
      fs.writeFileSync(path.join(tmpDir, "App.tsx"), "export const App = () => <div />;\n");
      fs.writeFileSync(path.join(tmpDir, "BadApp.tsx"), "const helper = (n: number) => n + 1; export const BadApp = () => <div>{helper(1)}</div>;\n");
      fs.writeFileSync(path.join(tmpDir, "app.config.ts"), "let cfg: any = { name: 'app' }; export default cfg;\n");
      fs.writeFileSync(path.join(tmpDir, "logic.ts"), "export type Retry = { readonly timeoutMs: number };\nexport const fn = (): number => { let count = 1; count += 1; return count; };\n");

      const result = await runPhasedLint({
        targets: ["."],
        fix: false,
        format: "json",
        maxTier: 3,
        cwd: tmpDir,
      });

      const [tier0Summary, tier1Summary, tier2Summary] = result.summaries;
      expect(result.passed).toBe(false);
      expect(result.failedTier).toBe(2);
      expect(result.summaries).toHaveLength(3);
      expect(tier0Summary?.tier).toBe(0);
      expect(tier0Summary?.errorCount).toBe(0);
      expect(tier1Summary?.tier).toBe(1);
      expect(tier1Summary?.errorCount).toBe(0);
      expect(tier2Summary?.tier).toBe(2);
      expect(tier2Summary?.errorCount).toBeGreaterThan(0);

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
      expect(badTsxResult.failedTier).toBe(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("classifies rules/messages by tier, filters exact tiers, and slices LintResult stats accurately", () => {
    expect(classifyRuleTier("strict-fp/no-any-or-unknown")).toBe(1);
    expect(classifyRuleTier("@typescript-eslint/no-unsafe-assignment")).toBe(1);
    expect(classifyRuleTier("no-console")).toBe(1);
    expect(classifyRuleTier("strict-fp/domain-layer-purity")).toBe(2);
    expect(classifyRuleTier("strict-fp/no-let-or-var")).toBe(3);
    expect(classifyRuleTier("strict-fp/unknown-future-rule")).toBe(3);

    expect(classifyMessageTier({ ruleId: null, fatal: true })).toBe(1);
    expect(classifyMessageTier({ ruleId: null })).toBe(1);
    expect(classifyMessageTier({ ruleId: "strict-fp/no-let-or-var", fatal: true })).toBe(1);
    expect(classifyMessageTier({ ruleId: "strict-fp/no-any-or-unknown" })).toBe(1);
    expect(classifyMessageTier({ ruleId: "strict-fp/domain-layer-purity" })).toBe(2);
    expect(classifyMessageTier({ ruleId: "strict-fp/no-let-or-var" })).toBe(3);

    const exact0 = createExactTierRuleFilter(0);
    const exact1 = createExactTierRuleFilter(1);
    const exact2 = createExactTierRuleFilter(2);
    const exact3 = createExactTierRuleFilter(3);

    expect(exact0({ ruleId: "strict-fp/domain-layer-purity" })).toBe(false);
    expect(exact1({ ruleId: "strict-fp/no-any-or-unknown" })).toBe(true);
    expect(exact1({ ruleId: "@typescript-eslint/no-unsafe-assignment" })).toBe(true);
    expect(exact1({ ruleId: "strict-fp/domain-layer-purity" })).toBe(false);

    expect(exact2({ ruleId: "strict-fp/domain-layer-purity" })).toBe(true);
    expect(exact2({ ruleId: "strict-fp/no-any-or-unknown" })).toBe(false);
    expect(exact2({ ruleId: "@typescript-eslint/no-unsafe-assignment" })).toBe(false);
    expect(exact2({ ruleId: "strict-fp/no-let-or-var" })).toBe(false);

    expect(exact3({ ruleId: "strict-fp/domain-layer-purity" })).toBe(false);
    expect(exact3({ ruleId: "strict-fp/no-any-or-unknown" })).toBe(false);
    expect(exact3({ ruleId: "@typescript-eslint/no-unsafe-assignment" })).toBe(false);
    expect(exact3({ ruleId: "strict-fp/no-let-or-var" })).toBe(true);

    const sampleResult: ESLint.LintResult = {
      filePath: "/tmp/sample.ts",
      source: "let x: any = 1;",
      messages: [
        { ruleId: null, fatal: true, severity: 2, message: "Parsing error", line: 1, column: 1 },
        {
          ruleId: "strict-fp/no-any-or-unknown",
          severity: 1,
          message: "Tier 1 warning",
          line: 1,
          column: 8,
        },
        {
          ruleId: "strict-fp/no-unit-suffixed-primitives",
          severity: 2,
          message: "Tier 2 error",
          line: 1,
          column: 1,
          fix: { range: [7, 10], text: "number" },
        },
        {
          ruleId: "strict-fp/no-let-or-var",
          severity: 1,
          message: "Tier 3 fixable warning",
          line: 1,
          column: 1,
          fix: { range: [0, 3], text: "const" },
        },
      ],
      suppressedMessages: [
        {
          ruleId: "strict-fp/no-let-or-var",
          severity: 2,
          message: "Suppressed Tier 3",
          line: 1,
          column: 1,
          suppressions: [{ kind: "directive", justification: "" }],
        },
      ],
      errorCount: 2,
      fatalErrorCount: 1,
      warningCount: 2,
      fixableErrorCount: 1,
      fixableWarningCount: 1,
      usedDeprecatedRules: [
        { ruleId: "strict-fp/no-unit-suffixed-primitives", replacedBy: [] },
        { ruleId: "strict-fp/no-let-or-var", replacedBy: [] },
      ],
    };

    const [t1] = sliceLintResultsForTier([sampleResult], 1);
    expect(t1?.errorCount).toBe(1);
    expect(t1?.fatalErrorCount).toBe(1);
    expect(t1?.warningCount).toBe(1);
    expect(t1?.fixableErrorCount).toBe(0);
    expect(t1?.fixableWarningCount).toBe(0);
    expect(t1?.messages).toHaveLength(2);
    expect(t1?.source).toBe("let x: any = 1;");
    expect(t1?.usedDeprecatedRules).toEqual([]);

    const [t2] = sliceLintResultsForTier([sampleResult], 2);
    expect(t2?.errorCount).toBe(1);
    expect(t2?.fatalErrorCount).toBe(0);
    expect(t2?.warningCount).toBe(0);
    expect(t2?.fixableErrorCount).toBe(1);
    expect(t2?.usedDeprecatedRules).toEqual([{ ruleId: "strict-fp/no-unit-suffixed-primitives", replacedBy: [] }]);

    const [t3] = sliceLintResultsForTier([sampleResult], 3);
    expect(t3?.errorCount).toBe(0);
    expect(t3?.warningCount).toBe(1);
    expect(t3?.fixableWarningCount).toBe(1);
    expect(t3?.suppressedMessages).toHaveLength(1);
    expect(t3?.usedDeprecatedRules).toEqual([{ ruleId: "strict-fp/no-let-or-var", replacedBy: [] }]);

    const cleanSliceResult: ESLint.LintResult = {
      ...sampleResult,
      messages: [
        {
          ruleId: "strict-fp/no-let-or-var",
          severity: 2,
          message: "Tier 3 only",
          line: 1,
          column: 1,
        },
      ],
      suppressedMessages: [],
    };
    const [emptyT1] = sliceLintResultsForTier([cleanSliceResult], 1);
    expect(emptyT1?.errorCount).toBe(0);
    expect(emptyT1?.messages).toEqual([]);
    expect(emptyT1?.source).toBeUndefined();
  });

  it("executes ESLint in a single pass for non---fix runs and gates Tier 1, Tier 2, Tier 3, and --tier <N> isolation", async () => {
    const tmpDir = createTempProjectDir();
    try {
      const distEntry = path.resolve(import.meta.dirname, "../dist/index.js");
      const tsconfigJson = JSON.stringify({
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022"], types: [], strict: true, skipLibCheck: true },
        include: ["**/*.ts"],
      });
      fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), tsconfigJson);
      fs.writeFileSync(
        path.join(tmpDir, "eslint.config.mjs"),
        `import strictFp from ${JSON.stringify(distEntry)};
export default [
  ...strictFp.createTieredConfig({ maxTier: 3, entryPoints: ["**/*.ts"] }),
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
];
`,
      );
      fs.writeFileSync(path.join(tmpDir, "clean.ts"), "export const answer = 42;\n");
      fs.writeFileSync(
        path.join(tmpDir, "all-tiers.ts"),
        [
          "export type Retry = { readonly timeoutMs: number };",
          "export const unsafeValue: any = 1;",
          "export const makeCount = () => { let count = 1; return count; };",
        ].join("\n") + "\n",
      );
      fs.writeFileSync(
        path.join(tmpDir, "tier2-and-3.ts"),
        "export type Retry = { readonly timeoutMs: number };\nexport const compute = (input: Retry): number => { let count = 1; count += 1; return input.timeoutMs + count; };\n",
      );

      // 1. Clean run (maxTier: 3) invokes ESLint & lintFiles exactly once while reporting Tiers 0..3
      const cleanTracker = createTrackingEslint();
      const cleanResult = await runPhasedLint(
        { targets: ["clean.ts"], fix: false, format: "json", maxTier: 3, cwd: tmpDir },
        { ESLintClass: cleanTracker.TrackingESLint },
      );
      expect(cleanResult.passed).toBe(true);
      expect(extractSummaryTiers(cleanResult.summaries)).toEqual([0, 1, 2, 3]);
      expect(cleanTracker.ctorCalls).toHaveLength(1);
      expect(cleanTracker.lintFilesCalls).toHaveLength(1);

      // 2. Failing at Tier 1 (Type Safety) hides Tier 2 and Tier 3 errors, still running ESLint once
      const t1FailTracker = createTrackingEslint();
      const t1Fail = await runPhasedLint(
        { targets: ["all-tiers.ts"], fix: false, format: "json", maxTier: 3, cwd: tmpDir },
        { ESLintClass: t1FailTracker.TrackingESLint },
      );
      expect(t1Fail.passed).toBe(false);
      expect(t1Fail.failedTier).toBe(1);
      expect(extractSummaryTiers(t1Fail.summaries)).toEqual([0, 1]);
      expect(t1Fail.summaries[1]?.output).toContain("strict-fp/no-any-or-unknown");
      expect(t1Fail.summaries[1]?.output).not.toContain("strict-fp/no-unit-suffixed-primitives");
      expect(t1Fail.summaries[1]?.output).not.toContain("strict-fp/no-let-or-var");
      expect(t1FailTracker.ctorCalls).toHaveLength(1);
      expect(t1FailTracker.lintFilesCalls).toHaveLength(1);

      // 3. Failing at Tier 2 (Architecture) includes passing Tier 1 and failing Tier 2, hides Tier 3, runs ESLint once
      const t2FailTracker = createTrackingEslint();
      const t2Fail = await runPhasedLint(
        { targets: ["tier2-and-3.ts"], fix: false, format: "json", maxTier: 3, cwd: tmpDir },
        { ESLintClass: t2FailTracker.TrackingESLint },
      );
      expect(t2Fail.passed).toBe(false);
      expect(t2Fail.failedTier).toBe(2);
      expect(extractSummaryTiers(t2Fail.summaries)).toEqual([0, 1, 2]);
      expect(t2Fail.summaries[1]?.errorCount).toBe(0);
      expect(t2Fail.summaries[2]?.errorCount).toBeGreaterThan(0);
      expect(t2Fail.summaries[2]?.output).toContain("strict-fp/no-unit-suffixed-primitives");
      expect(t2Fail.summaries[2]?.output).not.toContain("strict-fp/no-let-or-var");
      expect(t2FailTracker.ctorCalls).toHaveLength(1);
      expect(t2FailTracker.lintFilesCalls).toHaveLength(1);

      // 4. --tier 2 strictly isolates Tier 2 (ignores Tier 1 and Tier 3 rules)
      const onlyTier2 = await runPhasedLint({
        targets: ["all-tiers.ts"],
        fix: false,
        format: "json",
        maxTier: 3,
        onlyTier: 2,
        cwd: tmpDir,
      });
      expect(onlyTier2.passed).toBe(false);
      expect(onlyTier2.failedTier).toBe(2);
      expect(onlyTier2.summaries).toHaveLength(1);
      expect(onlyTier2.summaries[0]?.output).toContain("strict-fp/no-unit-suffixed-primitives");
      expect(onlyTier2.summaries[0]?.output).not.toContain("strict-fp/no-any-or-unknown");
      expect(onlyTier2.summaries[0]?.output).not.toContain("strict-fp/no-let-or-var");

      // 5. --tier 3 strictly isolates Tier 3 (ignores Tier 1 and Tier 2 rules)
      const onlyTier3 = await runPhasedLint({
        targets: ["all-tiers.ts"],
        fix: false,
        format: "json",
        maxTier: 3,
        onlyTier: 3,
        cwd: tmpDir,
      });
      expect(onlyTier3.passed).toBe(false);
      expect(onlyTier3.failedTier).toBe(3);
      expect(onlyTier3.summaries).toHaveLength(1);
      expect(onlyTier3.summaries[0]?.output).toContain("strict-fp/no-let-or-var");
      expect(onlyTier3.summaries[0]?.output).not.toContain("strict-fp/no-unit-suffixed-primitives");
      expect(onlyTier3.summaries[0]?.output).not.toContain("strict-fp/no-any-or-unknown");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("preserves Tier 1 warnings without halting and always surfaces fatal parse errors", async () => {
    const tmpDir = createTempProjectDir();
    try {
      const distEntry = path.resolve(import.meta.dirname, "../dist/index.js");
      fs.writeFileSync(
        path.join(tmpDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022"], types: [], strict: true, skipLibCheck: true },
          include: ["warn-and-t2.ts"],
        }),
      );
      fs.writeFileSync(
        path.join(tmpDir, "eslint.config.mjs"),
        `import strictFp from ${JSON.stringify(distEntry)};
const tsParser = strictFp.configs.react[1].languageOptions.parser;
export default [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser, parserOptions: { tsconfigRootDir: import.meta.dirname } },
    plugins: { "strict-fp": strictFp },
    rules: {
      "strict-fp/no-any-or-unknown": "warn",
      "strict-fp/no-generic-utility-names": "error",
      "strict-fp/no-let-or-var": "error",
    },
  },
];
`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "warn-and-t2.ts"),
        "export const orderHelper: any = 1;\nexport const f = () => { let x = 1; return x; };\n",
      );
      fs.writeFileSync(path.join(tmpDir, "syntax-error.ts"), "export const broken = (\n");

      const warnResult = await runPhasedLint({
        targets: ["warn-and-t2.ts"],
        fix: false,
        format: "json",
        maxTier: 3,
        cwd: tmpDir,
      });
      expect(warnResult.passed).toBe(false);
      expect(warnResult.failedTier, JSON.stringify(warnResult.summaries)).toBe(2);
      expect(extractSummaryTiers(warnResult.summaries)).toEqual([0, 1, 2]);
      expect(warnResult.summaries[1]?.errorCount).toBe(0);
      expect(warnResult.summaries[1]?.warningCount).toBeGreaterThan(0);
      expect(warnResult.summaries[2]?.errorCount).toBeGreaterThan(0);

      // Fatal parse error surfaces immediately in Tier 1 on a full run
      const fatalFullRun = await runPhasedLint({
        targets: ["syntax-error.ts"],
        fix: false,
        format: "json",
        maxTier: 3,
        cwd: tmpDir,
      });
      expect(fatalFullRun.passed).toBe(false);
      expect(fatalFullRun.failedTier).toBe(1);
      expect(extractSummaryTiers(fatalFullRun.summaries)).toEqual([0, 1]);
      expect(fatalFullRun.summaries[1]?.errorCount).toBeGreaterThan(0);
      expect(fatalFullRun.summaries[1]?.output).toContain("Parsing error");

      // Fatal parse error also surfaces immediately under --tier 2
      const fatalTier2Run = await runPhasedLint({
        targets: ["syntax-error.ts"],
        fix: false,
        format: "json",
        maxTier: 3,
        onlyTier: 2,
        cwd: tmpDir,
      });
      expect(fatalTier2Run.passed).toBe(false);
      expect(fatalTier2Run.failedTier).toBe(2);
      expect(fatalTier2Run.summaries[0]?.errorCount).toBeGreaterThan(0);
      expect(fatalTier2Run.summaries[0]?.output).toContain("Parsing error");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs --fix tier by tier, skips re-verification when unmutated, and re-verifies earlier tiers on mutation", async () => {
    const tmpDir = createTempProjectDir();
    try {
      const distEntry = path.resolve(import.meta.dirname, "../dist/index.js");
      fs.writeFileSync(
        path.join(tmpDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022"], types: [], strict: true, skipLibCheck: true },
          include: ["**/*.ts"],
        }),
      );
      fs.writeFileSync(
        path.join(tmpDir, "eslint.config.mjs"),
        `import strictFp from ${JSON.stringify(distEntry)};
const tsParser = strictFp.configs.react[1].languageOptions.parser;

const customRules = {
  "fix-to-helper-name": {
    meta: { type: "problem", fixable: "code", schema: [] },
    create(context) {
      return {
        Identifier(node) {
          if (node.name === "needsRegression") {
            context.report({
              node,
              message: "Rename needsRegression to orderHelper",
              fix: (fixer) => fixer.replaceText(node, "orderHelper"),
            });
          }
        },
      };
    },
  },
  "fix-clean-rename": {
    meta: { type: "problem", fixable: "code", schema: [] },
    create(context) {
      return {
        Identifier(node) {
          if (node.name === "oldName") {
            context.report({
              node,
              message: "Rename oldName to newName",
              fix: (fixer) => fixer.replaceText(node, "newName"),
            });
          }
        },
      };
    },
  },
};

export default [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser, parserOptions: { tsconfigRootDir: import.meta.dirname } },
    plugins: { "strict-fp": { ...strictFp, rules: { ...strictFp.rules, ...customRules } } },
    rules: {
      "strict-fp/no-any-or-unknown": "error",
      "strict-fp/no-generic-utility-names": "error",
      "strict-fp/fix-to-helper-name": "error",
      "strict-fp/fix-clean-rename": "error",
      "strict-fp/no-let-or-var": "error",
    },
  },
];
`,
      );
      fs.writeFileSync(path.join(tmpDir, "clean.ts"), "export const stable = 1;\n");
      fs.writeFileSync(
        path.join(tmpDir, "unfixable-t1.ts"),
        "export const badAny: any = 1;\nexport const oldName = 1;\n",
      );
      fs.writeFileSync(path.join(tmpDir, "fixable-clean.ts"), "export const oldName = 1;\n");
      fs.writeFileSync(
        path.join(tmpDir, "fixable-regresses-t2.ts"),
        "export const needsRegression = 1;\n",
      );

      // 1. Clean --fix run executes 3 exact passes (Tiers 1, 2, 3) with 0 re-verification passes
      const cleanFixTracker = createTrackingEslint();
      const cleanFix = await runPhasedLint(
        { targets: ["clean.ts"], fix: true, format: "json", maxTier: 3, cwd: tmpDir },
        { ESLintClass: cleanFixTracker.TrackingESLint },
      );
      expect(cleanFix.passed, JSON.stringify(cleanFix.summaries)).toBe(true);
      expect(extractSummaryTiers(cleanFix.summaries)).toEqual([0, 1, 2, 3]);
      expect(cleanFixTracker.ctorCalls).toHaveLength(3);
      expect(RA.every((c: ESLint.Options) => c.fix === true)(cleanFixTracker.ctorCalls)).toBe(true);

      // 2. Unfixable Tier 1 error halts immediately at Tier 1 without running Tier 2 or Tier 3
      const haltTracker = createTrackingEslint();
      const haltResult = await runPhasedLint(
        { targets: ["unfixable-t1.ts"], fix: true, format: "json", maxTier: 3, cwd: tmpDir },
        { ESLintClass: haltTracker.TrackingESLint },
      );
      expect(haltResult.passed).toBe(false);
      expect(haltResult.failedTier).toBe(1);
      expect(extractSummaryTiers(haltResult.summaries)).toEqual([0, 1]);
      expect(haltTracker.ctorCalls).toHaveLength(1);
      // Tier 3 autofix must not have run
      expect(readProjectFile(tmpDir, "unfixable-t1.ts")).toContain("oldName");

      // 3. Fixable Tier 3 issue writes fix to disk, triggers 1 non-fix re-verification pass for Tiers 1..2
      const mutatePassTracker = createTrackingEslint();
      const mutatePass = await runPhasedLint(
        { targets: ["fixable-clean.ts"], fix: true, format: "json", maxTier: 3, cwd: tmpDir },
        { ESLintClass: mutatePassTracker.TrackingESLint },
      );
      expect(mutatePass.passed).toBe(true);
      expect(extractSummaryTiers(mutatePass.summaries)).toEqual([0, 1, 2, 3]);
      expect(readProjectFile(tmpDir, "fixable-clean.ts")).toContain("newName");
      // 3 fix passes (T1, T2, T3) + 1 read-only re-verification pass after Tier 3 mutated
      expect(mutatePassTracker.ctorCalls).toHaveLength(4);
      expect(extractFixFlags(mutatePassTracker.ctorCalls)).toEqual([true, true, true, false]);

      // 4. Tier 3 autofix that introduces a Tier 2 violation is caught by mutation-aware re-verification
      const regressTracker = createTrackingEslint();
      const regressResult = await runPhasedLint(
        { targets: ["fixable-regresses-t2.ts"], fix: true, format: "json", maxTier: 3, cwd: tmpDir },
        { ESLintClass: regressTracker.TrackingESLint },
      );
      expect(regressResult.passed).toBe(false);
      expect(regressResult.failedTier).toBe(2);
      expect(readProjectFile(tmpDir, "fixable-regresses-t2.ts")).toContain("orderHelper");
      const lastSummary = regressResult.summaries[regressResult.summaries.length - 1];
      expect(lastSummary?.tier).toBe(2);
      expect(lastSummary?.output).toContain("strict-fp/no-generic-utility-names");
      // T1 fix pass + T2 fix pass + T3 fix pass + read-only re-verification pass
      expect(extractFixFlags(regressTracker.ctorCalls)).toEqual([true, true, true, false]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("enforces strict-fp/no-fp-ts-hkt at Tier 3 without conflicting with any existing rules across Tiers 0..3", async () => {
    expect(classifyRuleTier("strict-fp/no-fp-ts-hkt")).toBe(3);

    const tmpDir = createTempProjectDir();
    try {
      const distEntry = path.resolve(import.meta.dirname, "../dist/index.js");
      const repoNodeModules = path.resolve(import.meta.dirname, "../node_modules");
      fs.symlinkSync(repoNodeModules, path.join(tmpDir, "node_modules"), "dir");
      fs.writeFileSync(
        path.join(tmpDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            lib: ["ES2022"],
            types: [],
            strict: true,
            skipLibCheck: true,
          },
          include: ["**/*.ts"],
        }),
      );
      fs.writeFileSync(
        path.join(tmpDir, "eslint.config.mjs"),
        `import strictFp from ${JSON.stringify(distEntry)};
export default [
  ...strictFp.createTieredConfig({ maxTier: 3, entryPoints: ["**/*.ts"] }),
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
];
`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "idiomatic.ts"),
        [
          'import * as Ap from "fp-ts/lib/Apply.js";',
          'import * as O from "fp-ts/lib/Option.js";',
          'import * as RA from "fp-ts/lib/ReadonlyArray.js";',
          'import { flow } from "fp-ts/lib/function.js";',
          "",
          "const wrapGeneric = <A>(payload: A) => ({ payload });",
          "",
          "const incrementAll = flow(",
          "  RA.traverse(O.Applicative)((n: number) => O.some(n + 1)),",
          "  O.map(wrapGeneric),",
          ");",
          "",
          "export const combineScoredBatch = <L>(values: ReadonlyArray<number>, label: O.Option<L>): O.Option<{ readonly batch: { readonly payload: ReadonlyArray<number> }; readonly label: L }> =>",
          "  Ap.sequenceS(O.Applicative)({ batch: incrementAll(values), label });",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(tmpDir, "uses-hkt.ts"),
        [
          'import type { Kind, URIS } from "fp-ts/HKT";',
          "export type Lifted<F extends URIS, A> = Kind<F, A>;",
          "",
        ].join("\n"),
      );

      const cleanRun = await runPhasedLint({
        targets: ["idiomatic.ts"],
        fix: false,
        format: "json",
        maxTier: 3,
        cwd: tmpDir,
      });
      expect(cleanRun.passed, JSON.stringify(cleanRun.summaries)).toBe(true);
      expect(extractSummaryTiers(cleanRun.summaries)).toEqual([0, 1, 2, 3]);

      const hktRun = await runPhasedLint({
        targets: ["uses-hkt.ts"],
        fix: false,
        format: "json",
        maxTier: 3,
        cwd: tmpDir,
      });
      expect(hktRun.passed).toBe(false);
      expect(hktRun.failedTier).toBe(3);
      expect(hktRun.summaries[3]?.output).toContain("strict-fp/no-fp-ts-hkt");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
