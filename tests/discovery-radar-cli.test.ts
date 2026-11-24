import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { describe, expect, it, onTestFinished } from "vitest";
import { formatDiscoveryReport } from "../src/analyzers/radar-report.js";
import { buildDiscoveryRadarReport } from "../src/cli/discovery-radar.js";

const loadSampleProgram = (tsconfigPath: string) => {
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(tsconfigPath, (f) => ts.sys.readFile(f)).config,
    ts.sys,
    path.dirname(tsconfigPath),
  );
  return ts.createProgram(parsed.fileNames, parsed.options);
};

describe("discovery-radar analyzer & report", () => {
  const report = pipe(
    path.resolve(import.meta.dirname, "ddd-sample/tsconfig.json"),
    loadSampleProgram,
    buildDiscoveryRadarReport,
  );

  it("detects cross-file data clumps, polysemy, repeated guards, and aggregate children", () => {
    expect(pipe(report.dataClumps, RA.some((c) => c.fields.join(",") === "amount,currency"))).toBe(true);
    expect(pipe(report.polysemyModels, RA.some((m) => m.modelName === "Customer"))).toBe(true);
    expect(report.repeatedGuards.length).toBeGreaterThanOrEqual(1);
    expect(pipe(report.aggregateChildren, RA.some((e) => e.child === "OrderItem"))).toBe(true);
  });

  it("formats both Markdown and JSON reports", () => {
    const md = formatDiscoveryReport(report, "markdown");
    expect(md).toContain("# DDD Concept Discovery Radar");
    expect(md).toContain("# FP Abstraction Discovery Radar");
    expect(md).toContain("Customer");
    expect(md).toContain("Money");
    const parsed: unknown = JSON.parse(formatDiscoveryReport(report, "json"));
    const polysemyModels =
      typeof parsed === "object" &&
      parsed !== null &&
      "polysemyModels" in parsed &&
      Array.isArray(parsed.polysemyModels)
        ? parsed.polysemyModels
        : [];
    expect(polysemyModels.length).toBeGreaterThanOrEqual(1);
  });

  it("detects cross-file context drilling, skeleton duplication, and recursive ADT walkers", () => {
    const tmpDir = pipe(
      os.tmpdir(),
      (dir) => path.join(dir, "strict-fp-radar-"),
      (prefix) => fs.mkdtempSync(prefix),
    );
    onTestFinished(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
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
    fs.writeFileSync(
      path.join(tmpDir, "skeletons.ts"),
      `
          declare const pipe: (...args: ReadonlyArray<unknown>) => unknown;
          declare const TE: {
            tryCatch: (a: unknown, b: unknown) => unknown;
            flatMap: (f: unknown) => unknown;
            map: (f: unknown) => unknown;
            mapLeft: (f: unknown) => unknown;
          };
          export const loadOrder = (id: string) =>
            pipe(TE.tryCatch(() => id, (e: unknown) => e), TE.flatMap((x: unknown) => x), TE.map((x: unknown) => x), TE.mapLeft((e: unknown) => e));
          export const loadInvoice = (id: string) =>
            pipe(TE.tryCatch(() => id, (e: unknown) => e), TE.flatMap((x: unknown) => x), TE.map((x: unknown) => x), TE.mapLeft((e: unknown) => e));
        `,
    );
    fs.writeFileSync(
      path.join(tmpDir, "expr.ts"),
      `
          export type Expr =
            | { readonly _tag: "Lit"; readonly value: number }
            | { readonly _tag: "Add"; readonly left: Expr; readonly right: Expr };
          export const evalExpr = (e: Expr): number =>
            e._tag === "Lit" ? e.value : evalExpr(e.left) + evalExpr(e.right);
          export const showExpr = (e: Expr): string =>
            e._tag === "Lit" ? String(e.value) : showExpr(e.left) + "+" + showExpr(e.right);
        `,
    );

    const fpReport = pipe(
      path.join(tmpDir, "tsconfig.json"),
      loadSampleProgram,
      buildDiscoveryRadarReport,
    );

    expect(pipe(fpReport.contextDrillingChains, RA.some((c) => c.typeName === "AppEnv" && c.depth === 3))).toBe(true);
    expect(fpReport.skeletonDuplications.length).toBeGreaterThanOrEqual(1);
    expect(pipe(fpReport.catamorphismCandidates, RA.some((c) => c.adtName === "Expr" && c.walkers.length === 2))).toBe(true);

    const md = formatDiscoveryReport(fpReport, "markdown");
    expect(md).toContain("AppEnv");
    expect(md).toContain("foldExpr");
    expect(md).toContain("TE.tryCatch(2)");
  });
});
