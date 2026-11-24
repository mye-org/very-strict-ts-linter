import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flow, pipe } from "fp-ts/lib/function.js";
import { describe, expect, it, onTestFinished } from "vitest";
import { parseInitArgs, runInit } from "../src/cli/strict-fp-init.js";

const makeTempDir = () =>
  pipe(
    os.tmpdir(),
    (dir) => path.join(dir, "strict-fp-init-"),
    (prefix) => fs.mkdtempSync(prefix),
  );

const joinInDir = (dir: string) => (file: string) => path.join(dir, file);
const readUtf8 = (filePath: string) => fs.readFileSync(filePath, "utf8");

const readInDir = (dir: string) => flow(joinInDir(dir), readUtf8);

const writeInDir = (dir: string) => (file: string) => (content: string) => {
  fs.writeFileSync(path.join(dir, file), content, "utf8");
};

const existsInDir = (dir: string) => flow(joinInDir(dir), fs.existsSync);

describe("strict-fp-init CLI", () => {
  it("parses CLI flags with defaults and overrides", () => {
    expect(parseInitArgs([], "/tmp/project")).toEqual({
      cwd: "/tmp/project",
      force: false,
      maxTier: 3,
      help: false,
    });

    expect(parseInitArgs(["--force", "--max-tier", "2", "--cwd", "sub"], "/tmp/project")).toEqual({
      cwd: "/tmp/project/sub",
      force: true,
      maxTier: 2,
      help: false,
    });

    expect(parseInitArgs(["-h", "--tier", "1"], "/tmp/project")).toEqual({
      cwd: "/tmp/project",
      force: false,
      maxTier: 1,
      help: true,
    });

    expect(parseInitArgs(["--max-tier", "0"], "/tmp/project")).toEqual({
      cwd: "/tmp/project",
      force: false,
      maxTier: 0,
      help: false,
    });
  });

  it("scaffolds eslint.config.ts and sets scripts.lint to strict-fp-lint", () => {
    const tmpDir = makeTempDir();
    onTestFinished(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    writeInDir(tmpDir)("package.json")(
      JSON.stringify({ name: "consumer-app", private: true, scripts: { test: "vitest" } }, null, 2),
    );

    const result = runInit({ cwd: tmpDir, force: false, maxTier: 3, help: false });

    expect(result.eslintConfigStatus).toBe("created");
    expect(result.packageJsonStatus).toBe("updated");
    expect(result.previousLintScript).toBeUndefined();
    expect(result.existingOtherConfigs).toEqual([]);

    const eslintConfig = readInDir(tmpDir)("eslint.config.ts");
    expect(eslintConfig).toContain('import strictFp from "@mye-org/eslint-plugin-strict-fp"');
    expect(eslintConfig).toContain("strictFp.createStrictFpConfig(");
    expect(eslintConfig).toContain("projectService: true");

    const parsedPkg: unknown = JSON.parse(readInDir(tmpDir)("package.json"));
    const scripts =
      typeof parsedPkg === "object" &&
      parsedPkg !== null &&
      "scripts" in parsedPkg &&
      typeof parsedPkg.scripts === "object" &&
      parsedPkg.scripts !== null
        ? parsedPkg.scripts
        : {};
    expect(scripts).toMatchObject({ lint: "strict-fp-lint", test: "vitest" });
  });

  it("skips existing eslint.config.ts unless --force is passed and updates existing lint script", () => {
    const tmpDir = makeTempDir();
    onTestFinished(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    writeInDir(tmpDir)("eslint.config.ts")("// custom config\n");
    writeInDir(tmpDir)("package.json")(
      JSON.stringify({ name: "consumer-app", scripts: { lint: "eslint ." } }, null, 2),
    );

    const firstRun = runInit({ cwd: tmpDir, force: false, maxTier: 3, help: false });
    expect(firstRun.eslintConfigStatus).toBe("skipped");
    expect(firstRun.packageJsonStatus).toBe("updated");
    expect(firstRun.previousLintScript).toBe("eslint .");
    expect(readInDir(tmpDir)("eslint.config.ts")).toBe("// custom config\n");

    const secondRun = runInit({ cwd: tmpDir, force: true, maxTier: 2, help: false });
    expect(secondRun.eslintConfigStatus).toBe("overwritten");
    expect(secondRun.packageJsonStatus).toBe("unchanged");
    const overwritten = readInDir(tmpDir)("eslint.config.ts");
    expect(overwritten).toContain("maxTier: 2,");
  });

  it("reports missing package.json and detects other ESLint config files", () => {
    const tmpDir = makeTempDir();
    onTestFinished(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    writeInDir(tmpDir)("eslint.config.mjs")("export default [];\n");

    const result = runInit({ cwd: tmpDir, force: false, maxTier: 3, help: false });
    expect(result.eslintConfigStatus).toBe("created");
    expect(result.packageJsonStatus).toBe("missing");
    expect(result.existingOtherConfigs).toEqual(["eslint.config.mjs"]);
  });

  it("runs compiled strict-fp-init CLI binary end-to-end", () => {
    const tmpDir = makeTempDir();
    onTestFinished(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    writeInDir(tmpDir)("package.json")(JSON.stringify({ name: "cli-e2e" }, null, 2));
    const cliEntry = path.resolve(import.meta.dirname, "../dist/cli/strict-fp-init.js");

    const stdout = execFileSync(process.execPath, [cliEntry, "--cwd", tmpDir], { encoding: "utf8" });

    expect(stdout).toContain("[strict-fp-init] Created");
    expect(stdout).toContain('Set "scripts.lint": "strict-fp-lint"');
    expect(stdout).toContain("strict-fp-lint");
    expect(existsInDir(tmpDir)("eslint.config.ts")).toBe(true);
  });
});
