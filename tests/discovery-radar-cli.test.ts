import path from "node:path";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildDiscoveryRadarReport, formatDiscoveryReport } from "../src/analyzers/radar-report.js";

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
    expect(md).toContain("Customer");
    expect(md).toContain("Money");
    expect(
      (JSON.parse(formatDiscoveryReport(report, "json")) as typeof report).polysemyModels.length,
    ).toBeGreaterThanOrEqual(1);
  });
});
