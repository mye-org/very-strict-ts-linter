import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearCaches } from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { afterEach, describe, expect, it } from "vitest";
import { runDiscoveryRadar } from "../src/cli/discovery-radar.js";
import {
  requestDaemonStatus,
  stopWorkspaceDaemon,
} from "../src/cli/strict-fp-daemon.js";
import {
  parseCliArgs,
  runPhasedLint,
  type TierRunSummary,
} from "../src/cli/strict-fp-lint.js";

const tmpRoot = os.tmpdir();

const createTempWorkspace = flow(
  (prefix: string) => path.join(tmpRoot, prefix),
  (prefixPath) => fs.mkdtempSync(prefixPath),
);

const extractSummaryTiers = RA.map((s: TierRunSummary) => s.tier);

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

const writeStandardProject = (tmpDir: string) => {
  const distEntry = path.resolve(import.meta.dirname, "../dist/index.js");
  fs.writeFileSync(
    path.join(tmpDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
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
};

describe("incremental caching, tsbuildinfo reuse, and workspace daemon", () => {
  let daemonWorkspacesToCleanup: ReadonlyArray<string> = [];

  afterEach(clearCaches);
  afterEach(async () => {
    for (const dir of daemonWorkspacesToCleanup) {
      await stopWorkspaceDaemon(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    daemonWorkspacesToCleanup = [];
  });

  it("parses incremental caching and daemon CLI flags without altering defaults", () => {
    expect(
      parseCliArgs([
        "--no-cache",
        "--cache-location",
        ".custom-cache",
        "--eslint-cache",
        "--daemon",
      ]),
    ).toEqual({
      targets: ["."],
      fix: false,
      format: "stylish",
      maxTier: 3,
      cache: false,
      cacheLocation: ".custom-cache",
      eslintCache: true,
      daemon: true,
    });

    expect(parseCliArgs(["--daemon-status"])).toEqual({
      targets: ["."],
      fix: false,
      format: "stylish",
      maxTier: 3,
      daemonStatus: true,
    });

    expect(parseCliArgs(["--daemon-stop"])).toEqual({
      targets: ["."],
      fix: false,
      format: "stylish",
      maxTier: 3,
      daemonStop: true,
    });
  });

  it("persists Tier 0 .tsbuildinfo, serves sound content-hashed cache hits, and invalidates on cross-file dependency edits", async () => {
    const tmpDir = createTempWorkspace("strict-fp-cache-");
    const cacheDir = path.join(tmpDir, ".cache-store");
    try {
      writeStandardProject(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "dep.ts"), "export const baseValue = 10;\n");
      fs.writeFileSync(
        path.join(tmpDir, "consumer.ts"),
        'import { baseValue } from "./dep.js";\nexport const doubled: number = baseValue * 2;\n',
      );

      // 1. Cold run: builds .tsbuildinfo and executes ESLint once
      const coldTracker = createTrackingEslint();
      const coldResult = await runPhasedLint(
        {
          targets: ["consumer.ts"],
          fix: false,
          format: "json",
          maxTier: 3,
          cwd: tmpDir,
          cacheLocation: cacheDir,
        },
        { ESLintClass: coldTracker.TrackingESLint },
      );
      expect(coldResult.passed).toBe(true);
      expect(coldResult.cacheHit).toBeUndefined();
      expect(coldTracker.ctorCalls).toHaveLength(1);
      const cacheFiles = fs.readdirSync(cacheDir);
      expect(
        RA.some((name: string) => name.endsWith(".tsbuildinfo"))(cacheFiles),
      ).toBe(true);

      // 2. Unchanged consecutive run: content-hashed cache hit skips tsc and ESLint completely
      const warmTracker = createTrackingEslint();
      const warmResult = await runPhasedLint(
        {
          targets: ["consumer.ts"],
          fix: false,
          format: "json",
          maxTier: 3,
          cwd: tmpDir,
          cacheLocation: cacheDir,
        },
        { ESLintClass: warmTracker.TrackingESLint },
      );
      expect(warmResult.passed).toBe(true);
      expect(warmResult.cacheHit).toBe(true);
      expect(warmTracker.ctorCalls).toHaveLength(0);
      expect(warmResult.summaries).toEqual(coldResult.summaries);

      // 3. --no-cache forces a fresh execution even when files are unchanged
      const noCacheTracker = createTrackingEslint();
      const noCacheResult = await runPhasedLint(
        {
          targets: ["consumer.ts"],
          fix: false,
          format: "json",
          maxTier: 3,
          cwd: tmpDir,
          cache: false,
          cacheLocation: cacheDir,
        },
        { ESLintClass: noCacheTracker.TrackingESLint },
      );
      expect(noCacheResult.passed).toBe(true);
      expect(noCacheResult.cacheHit).toBeUndefined();
      expect(noCacheTracker.ctorCalls).toHaveLength(1);

      // 4. Editing imported dep.ts (without touching consumer.ts!) invalidates cache and catches TS error
      fs.writeFileSync(path.join(tmpDir, "dep.ts"), 'export const baseValue = "not-a-number";\n');
      const invalidatedTracker = createTrackingEslint();
      const invalidatedResult = await runPhasedLint(
        {
          targets: ["consumer.ts"],
          fix: false,
          format: "json",
          maxTier: 3,
          cwd: tmpDir,
          cacheLocation: cacheDir,
        },
        { ESLintClass: invalidatedTracker.TrackingESLint },
      );
      expect(invalidatedResult.passed).toBe(false);
      expect(invalidatedResult.cacheHit).toBeUndefined();
      expect(invalidatedResult.failedTier).toBe(0);
      expect(invalidatedResult.summaries[0]?.output).toContain("TS2362");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 45_000);

  it("uses ts.createIncrementalProgram with .tsbuildinfo and content-hashed report caching in discovery-radar", () => {
    const tmpDir = createTempWorkspace("strict-fp-radar-inc-");
    const cacheDir = path.join(tmpDir, ".radar-cache");
    try {
      fs.writeFileSync(
        path.join(tmpDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
          },
          include: ["*.ts"],
        }),
      );
      fs.writeFileSync(
        path.join(tmpDir, "drilling.ts"),
        `
          export type AppEnv = { readonly apiUrl: string; readonly timeoutMs: number };
          export const leaf = (env: AppEnv) => env.apiUrl;
          export const layer3 = (env: AppEnv) => leaf(env);
          export const layer2 = (env: AppEnv) => layer3(env);
          export const layer1 = (env: AppEnv) => layer2(env);
        `,
      );

      // 1. Cold run persists .tsbuildinfo and cached report
      const first = runDiscoveryRadar({
        cwd: tmpDir,
        tsconfig: "tsconfig.json",
        format: "json",
        cacheLocation: cacheDir,
      });
      expect(first.cacheHit).toBe(false);
      expect(first.tsBuildInfoPath).toBeDefined();
      expect(first.tsBuildInfoPath && fs.existsSync(first.tsBuildInfoPath)).toBe(true);
      expect(first.report.contextDrillingChains.length).toBeGreaterThanOrEqual(1);

      // 2. Unchanged run hits cached report
      const second = runDiscoveryRadar({
        cwd: tmpDir,
        tsconfig: "tsconfig.json",
        format: "json",
        cacheLocation: cacheDir,
      });
      expect(second.cacheHit).toBe(true);
      expect(second.report).toEqual(first.report);

      // 3. Editing source invalidates report cache and updates findings via incremental program
      fs.writeFileSync(path.join(tmpDir, "drilling.ts"), "export const simple = 42;\n");
      const third = runDiscoveryRadar({
        cwd: tmpDir,
        tsconfig: "tsconfig.json",
        format: "json",
        cacheLocation: cacheDir,
      });
      expect(third.cacheHit).toBe(false);
      expect(third.report.contextDrillingChains).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps Tier 0 BuilderProgram and ESLint warm in a workspace daemon across edits", async () => {
    const tmpDir = createTempWorkspace("strict-fp-daemon-test-");
    const cacheDir = path.join(tmpDir, ".daemon-cache");
    daemonWorkspacesToCleanup = RA.append(tmpDir)(daemonWorkspacesToCleanup);
    writeStandardProject(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "sample.ts"), "export const answer = 42;\n");

    // 1. First daemon call boots workspace daemon and passes all tiers
    const first = await runPhasedLint({
      targets: ["sample.ts"],
      fix: false,
      format: "json",
      maxTier: 3,
      cwd: tmpDir,
      cacheLocation: cacheDir,
      daemon: true,
    });
    expect(first.passed).toBe(true);
    expect(extractSummaryTiers(first.summaries)).toEqual([0, 1, 2, 3]);

    // 2. Unchanged consecutive call via daemon returns cached result immediately
    const second = await runPhasedLint({
      targets: ["sample.ts"],
      fix: false,
      format: "json",
      maxTier: 3,
      cwd: tmpDir,
      cacheLocation: cacheDir,
      daemon: true,
    });
    expect(second.passed).toBe(true);
    expect(second.cacheHit).toBe(true);

    // 3. Edit introduces Tier 0 TS error -> warm BuilderProgram catches it
    fs.writeFileSync(path.join(tmpDir, "sample.ts"), 'export const answer: number = "oops";\n');
    const tier0Fail = await runPhasedLint({
      targets: ["sample.ts"],
      fix: false,
      format: "json",
      maxTier: 3,
      cwd: tmpDir,
      cacheLocation: cacheDir,
      daemon: true,
    });
    expect(tier0Fail.passed).toBe(false);
    expect(tier0Fail.failedTier).toBe(0);
    expect(tier0Fail.summaries[0]?.output).toContain("TS2322");

    // 4. Edit fixes TS error but introduces Tier 3 ESLint error -> warm ESLint catches it
    fs.writeFileSync(
      path.join(tmpDir, "sample.ts"),
      "export const compute = (n: number): number => { let count = n; count += 1; return count; };\n",
    );
    const tier3Fail = await runPhasedLint({
      targets: ["sample.ts"],
      fix: false,
      format: "json",
      maxTier: 3,
      cwd: tmpDir,
      cacheLocation: cacheDir,
      daemon: true,
    });
    expect(tier3Fail.passed).toBe(false);
    expect(tier3Fail.failedTier).toBe(3);
    expect(tier3Fail.summaries[3]?.output).toContain("strict-fp/no-let-or-var");

    // 5. Fixing the file passes all tiers on the same warm daemon
    fs.writeFileSync(path.join(tmpDir, "sample.ts"), "export const compute = (n: number): number => n + 1;\n");
    const recovered = await runPhasedLint({
      targets: ["sample.ts"],
      fix: false,
      format: "json",
      maxTier: 3,
      cwd: tmpDir,
      cacheLocation: cacheDir,
      daemon: true,
    });
    expect(recovered.passed).toBe(true);
    expect(recovered.cacheHit).toBeUndefined();
  }, 45_000);

  it("reports workspace daemon status and shuts down cleanly", async () => {
    const tmpDir = createTempWorkspace("strict-fp-daemon-lifecycle-");
    const cacheDir = path.join(tmpDir, ".daemon-cache");
    daemonWorkspacesToCleanup = RA.append(tmpDir)(daemonWorkspacesToCleanup);
    writeStandardProject(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "sample.ts"), "export const answer = 42;\n");

    await runPhasedLint({
      targets: ["sample.ts"],
      fix: false,
      format: "json",
      maxTier: 3,
      cwd: tmpDir,
      cacheLocation: cacheDir,
      daemon: true,
    });

    const status = await requestDaemonStatus(tmpDir);
    expect(status.running).toBe(true);
    expect(status.pid).toBeGreaterThan(0);
    expect(status.requestsServed).toBe(1);

    const stopped = await stopWorkspaceDaemon(tmpDir);
    expect(stopped).toBe(true);
    const afterStop = await requestDaemonStatus(tmpDir);
    expect(afterStop.running).toBe(false);
  }, 45_000);
});
