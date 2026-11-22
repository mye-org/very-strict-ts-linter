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

describe("tiered configs and React/Expo exclusions", () => {
  it("excludes .tsx and *.config.ts by default and scopes to .ts", () => {
    expect(defaultStrictFpFiles).toEqual(["**/*.ts"]);
    expect(defaultStrictFpIgnores).toEqual(["**/*.tsx", "**/*.config.ts"]);

    const mainBlock = findTierBlock(createTieredConfig(strictFp, { maxTier: 1 }), "strict-fp/tier-1");
    expect(mainBlock?.files).toEqual(["**/*.ts"]);
    expect(mainBlock?.ignores).toEqual(["**/*.tsx", "**/*.config.ts"]);
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

  it("maps every plugin rule in ruleTiers with no missing or extra entries", () => {
    expect(pipe(RR.keys(ruleTiers), RA.sort(S.Ord))).toEqual(pipe(RR.keys(rules), RA.sort(S.Ord)));
  });
});

describe("strict-fp-lint CLI helpers and phased runner", () => {
  it("filters rules accurately per tier", () => {
    const t1Filter = createTierRuleFilter(1);
    const t2Filter = createTierRuleFilter(2);

    expect(t1Filter({ ruleId: "strict-fp/domain-layer-purity" })).toBe(true);
    expect(t1Filter({ ruleId: "strict-fp/no-any-or-unknown" })).toBe(false);
    expect(t1Filter({ ruleId: "strict-fp/no-let-or-var" })).toBe(false);
    expect(t1Filter({ ruleId: "@typescript-eslint/no-unsafe-assignment" })).toBe(false);

    expect(t2Filter({ ruleId: "strict-fp/domain-layer-purity" })).toBe(true);
    expect(t2Filter({ ruleId: "strict-fp/no-any-or-unknown" })).toBe(true);
    expect(t2Filter({ ruleId: "@typescript-eslint/no-unsafe-assignment" })).toBe(true);
    expect(t2Filter({ ruleId: "strict-fp/no-let-or-var" })).toBe(false);

    expect(createTierRuleFilter(3)({ ruleId: "strict-fp/no-let-or-var" })).toBe(true);
  });

  it("parses CLI flags", () => {
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
  });

  it("stops at Tier 1 on architectural error and ignores .tsx and *.config.ts", async () => {
    const tmpDir = pipe(
      os.tmpdir(),
      (dir) => path.join(dir, "strict-fp-phased-"),
      (prefix) => fs.mkdtempSync(prefix),
    );
    try {
      const distEntry = path.resolve(import.meta.dirname, "../dist/index.js");
      const tsconfigJson = JSON.stringify({
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, jsx: "react-jsx" },
        include: ["**/*.ts", "**/*.tsx"],
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
      fs.writeFileSync(path.join(tmpDir, "App.tsx"), "export const App = () => { let x: any = 1; return x; };\n");
      fs.writeFileSync(path.join(tmpDir, "app.config.ts"), "let cfg: any = { name: 'app' }; export default cfg;\n");
      fs.writeFileSync(path.join(tmpDir, "logic.ts"), "export type Retry = { readonly timeoutMs: number };\nexport const fn = () => { let count = 1; return count; };\n");

      const result = await runPhasedLint({
        targets: ["."],
        fix: false,
        format: "json",
        maxTier: 3,
        cwd: tmpDir,
      });

      const [firstSummary] = result.summaries;
      expect(result.passed).toBe(false);
      expect(result.failedTier).toBe(1);
      expect(result.summaries).toHaveLength(1);
      expect(firstSummary?.errorCount).toBeGreaterThan(0);

      const tsxOnlyResult = await runPhasedLint({
        targets: ["App.tsx", "app.config.ts"],
        fix: false,
        format: "json",
        maxTier: 3,
        cwd: tmpDir,
      });
      expect(tsxOnlyResult.passed).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
