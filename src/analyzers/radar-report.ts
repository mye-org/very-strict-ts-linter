import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { listAggregateOwnershipEdges } from "./aggregate-graph-analyzer.js";
import { analyzeDataClumps, ClumpFinding } from "./data-clump-analyzer.js";
import { analyzeGuardClauses, GuardCluster } from "./guard-clause-analyzer.js";
import { analyzePolysemy, PolysemyFinding } from "./polysemy-analyzer.js";
import { analyzeStringlyTypedDiscriminants, DiscriminantCluster } from "./stringly-typed-analyzer.js";

export type DiscoveryRadarReport = Readonly<{
  readonly dataClumps: ReadonlyArray<ClumpFinding>;
  readonly polysemyModels: ReadonlyArray<PolysemyFinding>;
  readonly repeatedGuards: ReadonlyArray<GuardCluster>;
  readonly stringlyTypedDiscriminants: ReadonlyArray<DiscriminantCluster>;
  readonly aggregateChildren: ReadonlyArray<
    Readonly<Record<"child", string> & { readonly parents: ReadonlyArray<string> }>
  >;
}>;

export const buildDiscoveryRadarReport = (program: ts.Program) => ({
  dataClumps: analyzeDataClumps(program).findings,
  polysemyModels: analyzePolysemy(program).findings,
  repeatedGuards: analyzeGuardClauses(program).clusters,
  stringlyTypedDiscriminants: analyzeStringlyTypedDiscriminants(program).clusters,
  aggregateChildren: listAggregateOwnershipEdges(program),
});

const formatLocations = (locs: ReadonlyArray<Readonly<Record<"file", string> & Record<"line", number>>>) =>
  pipe(locs, RA.map((l) => `${l.file}:${String(l.line)}`)).join(", ");

const formatClumpSection = (clumps: ReadonlyArray<ClumpFinding>) =>
  clumps.length === 0
    ? "- None detected."
    : pipe(
        clumps,
        RA.map(
          (c) =>
            `- **(${c.fields.join(", ")})** → suggest \`${c.suggestedName}\` (${String(c.locations.length)} sites: ${formatLocations(c.locations)})`,
        ),
      ).join("\n");

const formatPolysemyClusters = (clusters: PolysemyFinding["clusters"]) =>
  pipe(
    clusters,
    RA.map((c) => `  - \`${c.modulePath}\`: {${c.fields.join(", ")}}`),
  ).join("\n");

const formatPolysemySection = (models: ReadonlyArray<PolysemyFinding>) =>
  models.length === 0
    ? "- None detected."
    : pipe(
        models,
        RA.map(
          (m) =>
            `- **${m.modelName}** (${m.location.file}:${String(m.location.line)}):\n${formatPolysemyClusters(m.clusters)}`,
        ),
      ).join("\n");

const formatGuardsSection = (guards: ReadonlyArray<GuardCluster>) =>
  guards.length === 0
    ? "- None detected."
    : pipe(
        guards,
        RA.map(
          (g) =>
            `- \`${g.preview}\` (${String(g.locations.length)} sites: ${formatLocations(g.locations)})`,
        ),
      ).join("\n");

const formatDiscriminantsSection = (clusters: ReadonlyArray<DiscriminantCluster>) =>
  clusters.length === 0
    ? "- None detected."
    : pipe(
        clusters,
        RA.map(
          (d) =>
            `- **${d.targetKey}** compared against [${d.literals.join(", ")}] (${formatLocations(d.locations)})`,
        ),
      ).join("\n");

const formatAggregatesSection = (
  edges: DiscoveryRadarReport["aggregateChildren"],
) =>
  edges.length === 0
    ? "- None detected."
    : pipe(
        edges,
        RA.map((e) => `- **${e.child}** owned by [${e.parents.join(", ")}]`),
      ).join("\n");

const formatMarkdownReport = (report: DiscoveryRadarReport) =>
  [
    "# DDD Concept Discovery Radar",
    `\n## 1. Data Clumps (Missing Value Objects)\n${formatClumpSection(report.dataClumps)}`,
    `\n## 2. Model Polysemy (Bounded Context Splits)\n${formatPolysemySection(report.polysemyModels)}`,
    `\n## 3. Repeated Guard Clauses (Missing Specifications)\n${formatGuardsSection(report.repeatedGuards)}`,
    `\n## 4. Stringly-Typed Discriminants (Missing Unions / Enums)\n${formatDiscriminantsSection(report.stringlyTypedDiscriminants)}`,
    `\n## 5. Aggregate Child Entity Ownership\n${formatAggregatesSection(report.aggregateChildren)}\n`,
  ].join("\n");

export const formatDiscoveryReport = (
  report: DiscoveryRadarReport,
  format: "markdown" | "json",
) =>
  match(format)
    .with("json", () => JSON.stringify(report, undefined, 2))
    .with("markdown", () => formatMarkdownReport(report))
    .exhaustive();
