import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import type { CatamorphismFinding } from "./catamorphism-analyzer.js";
import type { ContextDrillingFinding } from "./context-drilling-analyzer.js";
import type { ClumpFinding } from "./data-clump-analyzer.js";
import type { GuardCluster } from "./guard-clause-analyzer.js";
import type { PolysemyFinding } from "./polysemy-analyzer.js";
import type { SkeletonCluster } from "./skeleton-duplication-analyzer.js";
import type { DiscriminantCluster } from "./stringly-typed-analyzer.js";

export type DiscoveryRadarReport = {
  readonly dataClumps: ReadonlyArray<ClumpFinding>;
  readonly polysemyModels: ReadonlyArray<PolysemyFinding>;
  readonly repeatedGuards: ReadonlyArray<GuardCluster>;
  readonly stringlyTypedDiscriminants: ReadonlyArray<DiscriminantCluster>;
  readonly aggregateChildren: ReadonlyArray<
    Readonly<Record<"child", string> & { readonly parents: ReadonlyArray<string> }>
  >;
  readonly contextDrillingChains: ReadonlyArray<ContextDrillingFinding>;
  readonly skeletonDuplications: ReadonlyArray<SkeletonCluster>;
  readonly catamorphismCandidates: ReadonlyArray<CatamorphismFinding>;
};

const joinLines = (lines: ReadonlyArray<string>) => lines.join("\n");
const joinComma = (items: ReadonlyArray<string>) => items.join(", ");

const renderSectionBody = (lines: ReadonlyArray<string>) =>
  lines.length === 0 ? "- None detected." : lines.join("\n");

const renderSection = (heading: string) => (body: string) => `\n${heading}\n${body}`;
const renderTrailingSection = (heading: string) => (body: string) => `\n${heading}\n${body}\n`;

const formatLocation = (loc: Readonly<Record<"file", string> & Record<"line", number>>) =>
  `${loc.file}:${String(loc.line)}`;

const formatLocations = flow(RA.map(formatLocation), joinComma);

const prepareClumpLine = (clump: ClumpFinding) => ({
  fieldsText: joinComma(clump.fields),
  suggestedName: clump.suggestedName,
  clumpSiteCount: clump.locations.length,
  clumpSitesText: formatLocations(clump.locations),
});

const renderClumpLine = (
  entry: Readonly<
    Record<"fieldsText" | "suggestedName" | "clumpSitesText", string> &
      Record<"clumpSiteCount", number>
  >,
) =>
  `- **(${entry.fieldsText})** → suggest \`${entry.suggestedName}\` (${String(entry.clumpSiteCount)} sites: ${entry.clumpSitesText})`;

const formatClumpLine = flow(prepareClumpLine, renderClumpLine);

const formatClumpSection = flow(
  RA.map(formatClumpLine),
  renderSectionBody,
  renderSection("## 1. Data Clumps (Missing Value Objects)"),
);

const formatPolysemyCluster = (cluster: PolysemyFinding["clusters"][number]) =>
  `  - \`${cluster.modulePath}\`: {${cluster.fields.join(", ")}}`;

const formatPolysemyClusters = flow(RA.map(formatPolysemyCluster), joinLines);

const preparePolysemyLine = (model: PolysemyFinding) => ({
  modelName: model.modelName,
  modelLocation: formatLocation(model.location),
  clustersText: formatPolysemyClusters(model.clusters),
});

const renderPolysemyLine = (
  entry: Readonly<Record<"modelName" | "modelLocation" | "clustersText", string>>,
) => `- **${entry.modelName}** (${entry.modelLocation}):\n${entry.clustersText}`;

const formatPolysemyLine = flow(preparePolysemyLine, renderPolysemyLine);

const formatPolysemySection = flow(
  RA.map(formatPolysemyLine),
  renderSectionBody,
  renderSection("## 2. Model Polysemy (Bounded Context Splits)"),
);

const prepareGuardLine = (guard: GuardCluster) => ({
  guardPreview: guard.preview,
  guardSiteCount: guard.locations.length,
  guardSitesText: formatLocations(guard.locations),
});

const renderGuardLine = (
  entry: Readonly<Record<"guardPreview" | "guardSitesText", string> & Record<"guardSiteCount", number>>,
) => `- \`${entry.guardPreview}\` (${String(entry.guardSiteCount)} sites: ${entry.guardSitesText})`;

const formatGuardLine = flow(prepareGuardLine, renderGuardLine);

const formatGuardsSection = flow(
  RA.map(formatGuardLine),
  renderSectionBody,
  renderSection("## 3. Repeated Guard Clauses (Missing Specifications)"),
);

const prepareDiscriminantLine = (cluster: DiscriminantCluster) => ({
  targetKey: cluster.targetKey,
  literalsText: joinComma(cluster.literals),
  discriminantSitesText: formatLocations(cluster.locations),
});

const renderDiscriminantLine = (
  entry: Readonly<Record<"targetKey" | "literalsText" | "discriminantSitesText", string>>,
) => `- **${entry.targetKey}** compared against [${entry.literalsText}] (${entry.discriminantSitesText})`;

const formatDiscriminantLine = flow(prepareDiscriminantLine, renderDiscriminantLine);

const formatDiscriminantsSection = flow(
  RA.map(formatDiscriminantLine),
  renderSectionBody,
  renderSection("## 4. Stringly-Typed Discriminants (Missing Unions / Enums)"),
);

const formatAggregateLine = (edge: DiscoveryRadarReport["aggregateChildren"][number]) =>
  `- **${edge.child}** owned by [${edge.parents.join(", ")}]`;

const formatAggregatesSection = flow(
  RA.map(formatAggregateLine),
  renderSectionBody,
  renderSection("## 5. Aggregate Child Entity Ownership"),
);

const formatContextDrillingLine = (chain: ContextDrillingFinding) =>
  `- **${chain.paramName}: ${chain.typeName}** drilled across ${String(chain.depth)} hops (${chain.chain.join(" -> ")}) at ${chain.rootLocation.file}:${String(chain.rootLocation.line)}`;

const formatContextDrillingSection = flow(
  RA.map(formatContextDrillingLine),
  renderSectionBody,
  renderSection("## 6. Context Drilling Chains (Missing Reader / ReaderTaskEither)"),
);

const formatSiteLocations = flow(
  RA.map((site: SkeletonCluster["sites"][number]) => site.location),
  formatLocations,
);

const prepareSkeletonLine = (cluster: SkeletonCluster) => ({
  skeletonPreview: cluster.preview,
  skeletonSiteCount: cluster.sites.length,
  skeletonSitesText: formatSiteLocations(cluster.sites),
});

const renderSkeletonLine = (
  entry: Readonly<
    Record<"skeletonPreview" | "skeletonSitesText", string> & Record<"skeletonSiteCount", number>
  >,
) => `- \`${entry.skeletonPreview}\` (${String(entry.skeletonSiteCount)} sites: ${entry.skeletonSitesText})`;

const formatSkeletonLine = flow(prepareSkeletonLine, renderSkeletonLine);

const formatSkeletonSection = flow(
  RA.map(formatSkeletonLine),
  renderSectionBody,
  renderSection("## 7. Structural Skeleton Duplication (Missing Higher-Order Combinators)"),
);

const formatWalkerNames = flow(
  RA.map((walker: CatamorphismFinding["walkers"][number]) => walker.functionName),
  joinComma,
);

const prepareCatamorphismLine = (finding: CatamorphismFinding) => ({
  adtName: finding.adtName,
  walkerCount: finding.walkers.length,
  walkerNamesText: formatWalkerNames(finding.walkers),
});

const renderCatamorphismLine = (
  entry: Readonly<Record<"adtName" | "walkerNamesText", string> & Record<"walkerCount", number>>,
) =>
  `- **${entry.adtName}** → suggest \`fold${entry.adtName}\` (${String(entry.walkerCount)} recursive walkers: ${entry.walkerNamesText})`;

const formatCatamorphismLine = flow(prepareCatamorphismLine, renderCatamorphismLine);

const formatCatamorphismSection = flow(
  RA.map(formatCatamorphismLine),
  renderSectionBody,
  renderTrailingSection("## 8. Recursive ADT Walkers (Missing Catamorphisms / fold)"),
);

const formatMarkdownReport = (report: DiscoveryRadarReport) =>
  joinLines([
    "# DDD Concept Discovery Radar",
    formatClumpSection(report.dataClumps),
    formatPolysemySection(report.polysemyModels),
    formatGuardsSection(report.repeatedGuards),
    formatDiscriminantsSection(report.stringlyTypedDiscriminants),
    formatAggregatesSection(report.aggregateChildren),
    "\n# FP Abstraction Discovery Radar",
    formatContextDrillingSection(report.contextDrillingChains),
    formatSkeletonSection(report.skeletonDuplications),
    formatCatamorphismSection(report.catamorphismCandidates),
  ]);

export const formatDiscoveryReport = (
  report: DiscoveryRadarReport,
  format: "markdown" | "json",
): string =>
  match(format)
    .with("json", () => JSON.stringify(report, undefined, 2))
    .with("markdown", () => formatMarkdownReport(report))
    .exhaustive();
