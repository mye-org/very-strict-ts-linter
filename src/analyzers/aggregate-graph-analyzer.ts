import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import * as S from "fp-ts/lib/string.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { memoizeByProgram, memoizeByProgramAndKey } from "../lib/program-memo.js";
import { collectProjectSourceFiles, isMatchingAnyPattern } from "../lib/source-paths.js";
import { unwrapContainerTsTypes } from "../lib/ts-container-types.js";
import { collectTsNodes } from "../lib/ts-node-traversal.js";
import { isBrandedOrNewtypeTsType } from "../lib/ts-primitive-types.js";
import { resolveTsTypeName } from "../lib/ts-type-name.js";

type AggregateCandidate = Readonly<
  Record<"name" | "fileName", string> & {
    readonly origin: "explicit" | "inferred";
    readonly referencedTypes: ReadonlyArray<string>;
  }
>;

type RepoCandidate = Readonly<
  Record<"repoName" | "fileName", string> & {
    readonly entityTypes: ReadonlyArray<string>;
  }
>;

type ProgramAggregateGraph = Readonly<{
  readonly candidates: ReadonlyArray<AggregateCandidate>;
  readonly repos: ReadonlyArray<RepoCandidate>;
}>;

const aggregateGraphCache = new WeakMap<ts.Program, ProgramAggregateGraph>();

const DEFAULT_AGGREGATE_PATHS = ["**/aggregates/**", "**/aggregate/**"];
const REPO_SUFFIXES = ["Repository", "Repo"];
const AGGREGATE_SUFFIX = "Aggregate";
const AGGREGATE_TAGS: ReadonlySet<string> = new Set(["aggregateRoot", "aggregate"]);
const IGNORED_ENTITY_NAMES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "Date",
  "RegExp",
  "Error",
  "Promise",
  "Option",
  "Either",
  "TaskEither",
  "ReadonlyArray",
  "Array",
  "ReadonlyMap",
  "ReadonlySet",
  "Record",
]);

const hasRepoSuffix = (name: string) => RA.some((s: string) => name.endsWith(s))(REPO_SUFFIXES);

const hasAggregateSuffix = (name: string) => name.endsWith(AGGREGATE_SUFFIX);

const hasIdSuffix = (name: string) => name.endsWith("Id");

const hasAggregateJsDoc = flow(
  ts.getJSDocTags,
  RA.some((tag) => AGGREGATE_TAGS.has(tag.tagName.text)),
);

const isEntityDecl = (
  node: ts.Node,
): node is ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration =>
  ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node);

const isComplexDomainType = (t: ts.Type) =>
  !isBrandedOrNewtypeTsType(t) && t.getProperties().length > 0;

const isDomainEntityName = (name: string) => !IGNORED_ENTITY_NAMES.has(name);

const extractComplexEntityNames = flow(
  RA.filter(isComplexDomainType),
  RA.filterMap(resolveTsTypeName),
  RA.filter(isDomainEntityName),
);

const resolveSymbolDecl = (sym: ts.Symbol) =>
  O.fromNullable(sym.valueDeclaration ?? sym.declarations?.[0]);

const resolveUnwrappedAtDecl = (sym: ts.Symbol, checker: ts.TypeChecker) =>
  flow(
    (decl: ts.Declaration) => checker.getTypeOfSymbolAtLocation(sym, decl),
    (t) => unwrapContainerTsTypes(t, checker),
  );

const resolveSymbolUnwrappedTypesFor = (sym: ts.Symbol, checker: ts.TypeChecker) =>
  flow(
    resolveSymbolDecl,
    O.map(resolveUnwrappedAtDecl(sym, checker)),
    O.getOrElseW(() => []),
  );

const resolveSymbolUnwrappedTypes = (sym: ts.Symbol, checker: ts.TypeChecker) =>
  resolveSymbolUnwrappedTypesFor(sym, checker)(sym);

const collectPropUnwrappedNames = (prop: ts.Symbol, checker: ts.TypeChecker) =>
  extractComplexEntityNames(resolveSymbolUnwrappedTypes(prop, checker));

type NodeAndFile = Readonly<{ node: ts.Node; sf: ts.SourceFile }>;

const classifyCandidateOrigin = (
  node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration,
  fileName: string,
) =>
  hasAggregateSuffix(node.name?.text ?? "") ||
  hasAggregateJsDoc(node) ||
  isMatchingAnyPattern(fileName, DEFAULT_AGGREGATE_PATHS)
    ? ("explicit" as const)
    : ("inferred" as const);

const extractPropNamesForNode = (checker: ts.TypeChecker) =>
  flow(
    (node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration) =>
      checker.getTypeAtLocation(node).getProperties(),
    RA.flatMap((prop: ts.Symbol) => collectPropUnwrappedNames(prop, checker)),
    RA.uniq(S.Eq),
  );

const collectReferencedTypes = (
  node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration,
  checker: ts.TypeChecker,
) => extractPropNamesForNode(checker)(node);

const buildAggregateCandidate =
  (checker: ts.TypeChecker) =>
  (
    name: string,
    {
      node,
      sf,
    }: Readonly<{
      node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration;
      sf: ts.SourceFile;
    }>,
  ) => ({
    name,
    fileName: sf.fileName,
    origin: classifyCandidateOrigin(node, sf.fileName),
    referencedTypes: collectReferencedTypes(node, checker),
  });

const extractCandidate =
  (checker: ts.TypeChecker) =>
  ({ node, sf }: NodeAndFile) =>
    isEntityDecl(node) && node.name && !hasRepoSuffix(node.name.text)
      ? O.some<AggregateCandidate>(buildAggregateCandidate(checker)(node.name.text, { node, sf }))
      : O.none;

const extractCallSignaturesForProp = (prop: ts.Symbol, checker: ts.TypeChecker) =>
  flow(
    resolveSymbolDecl,
    O.map((decl: ts.Declaration) =>
      checker.getTypeOfSymbolAtLocation(prop, decl).getCallSignatures(),
    ),
    O.getOrElseW(() => []),
  );

const collectSymbolCallSignatures = (prop: ts.Symbol, checker: ts.TypeChecker) =>
  extractCallSignaturesForProp(prop, checker)(prop);

const collectSigParamUnwrappedTypes = (sig: ts.Signature, checker: ts.TypeChecker) =>
  RA.flatMap((p: ts.Symbol) => resolveSymbolUnwrappedTypes(p, checker))(sig.getParameters());

const collectSignatureDomainTypes = (sig: ts.Signature, checker: ts.TypeChecker) => [
  ...unwrapContainerTsTypes(checker.getReturnTypeOfSignature(sig), checker),
  ...collectSigParamUnwrappedTypes(sig, checker),
];

const filterRepoEntities = (checker: ts.TypeChecker) =>
  flow(
    RA.flatMap((prop: ts.Symbol) => collectSymbolCallSignatures(prop, checker)),
    RA.flatMap((sig: ts.Signature) => collectSignatureDomainTypes(sig, checker)),
    extractComplexEntityNames,
    RA.filter((name) => !hasRepoSuffix(name)),
    RA.uniq(S.Eq),
  );

const extractRepoSignatureEntities = (type: ts.Type, checker: ts.TypeChecker) =>
  filterRepoEntities(checker)(type.getProperties());

const extractRepoCandidate =
  (checker: ts.TypeChecker) =>
  ({ node, sf }: NodeAndFile) =>
    isEntityDecl(node) && node.name && hasRepoSuffix(node.name.text)
      ? O.some<RepoCandidate>({
          repoName: node.name.text,
          fileName: sf.fileName,
          entityTypes: extractRepoSignatureEntities(checker.getTypeAtLocation(node), checker),
        })
      : O.none;

const collectFileNodes = (sf: ts.SourceFile) => collectTsNodes(sf, sf);

const pairFileNodes = flow(
  (sf: ts.SourceFile) => ({ sf, nodes: collectFileNodes(sf) }),
  ({ sf, nodes }) => RA.map((node: ts.Node) => ({ node, sf }))(nodes),
);

const collectNodesAndFiles = flow(collectProjectSourceFiles, RA.flatMap(pairFileNodes));

const collectAggregateGraph = (program: ts.Program) => {
  const checker = program.getTypeChecker();
  const nodesAndFiles = collectNodesAndFiles(program);
  return {
    candidates: RA.filterMap(extractCandidate(checker))(nodesAndFiles),
    repos: RA.filterMap(extractRepoCandidate(checker))(nodesAndFiles),
  };
};

const resolveProgramGraph = memoizeByProgram(aggregateGraphCache, collectAggregateGraph);

const toOwnedChildPair =
  (aggName: string, aggregateRoots: ReadonlySet<string>) => (child: string) =>
    child !== aggName && !aggregateRoots.has(child) ? O.some([child, aggName] as const) : O.none;

const extractAggregateChildPairs = (
  agg: AggregateCandidate,
  aggregateRoots: ReadonlySet<string>,
) => RA.filterMap(toOwnedChildPair(agg.name, aggregateRoots))(agg.referencedTypes);

const extractUniqueParents = flow(
  RA.map(([, parent]: readonly [string, string]) => parent),
  RA.uniq(S.Eq),
);

const groupChildParents = (aggregateRoots: ReadonlySet<string>) =>
  flow(
    RA.filter((c: AggregateCandidate) => aggregateRoots.has(c.name)),
    RA.flatMap((agg: AggregateCandidate) => extractAggregateChildPairs(agg, aggregateRoots)),
    RNEA.groupBy(([child]) => child),
    RR.map(extractUniqueParents),
  );

const computeChildOwnership = (
  candidates: ReadonlyArray<AggregateCandidate>,
  aggregateRoots: ReadonlySet<string>,
) => groupChildParents(aggregateRoots)(candidates);

type RootResolutionConfig = Readonly<{
  readonly explicitOptionRoots: ReadonlyArray<string>;
  readonly aggregatePathPatterns: ReadonlyArray<string>;
}>;

const isExplicitCandidate = (
  c: AggregateCandidate,
  aggregatePathPatterns: ReadonlyArray<string>,
) =>
  c.origin === "explicit" ||
  (aggregatePathPatterns.length > 0 && isMatchingAnyPattern(c.fileName, aggregatePathPatterns));

const extractExplicitCandidateName =
  (aggregatePathPatterns: ReadonlyArray<string>) => (c: AggregateCandidate) =>
    isExplicitCandidate(c, aggregatePathPatterns) ? O.some(c.name) : O.none;

const collectExplicitRootSet = (
  candidates: ReadonlyArray<AggregateCandidate>,
  { explicitOptionRoots, aggregatePathPatterns }: RootResolutionConfig,
) =>
  new Set([
    ...explicitOptionRoots,
    ...RA.filterMap(extractExplicitCandidateName(aggregatePathPatterns))(candidates),
  ]);

const collectOwnedByExplicitSet = (
  candidates: ReadonlyArray<AggregateCandidate>,
  explicitSet: ReadonlySet<string>,
) =>
  new Set(
    RA.flatMap((c: AggregateCandidate) => c.referencedTypes)(
      RA.filter((c: AggregateCandidate) => explicitSet.has(c.name))(candidates),
    ),
  );

const isInferredRepoRoot = (name: string, ownedByExplicit: ReadonlySet<string>) =>
  !ownedByExplicit.has(name) && !hasIdSuffix(name);

const collectInferredRepoRoots = (
  repos: ReadonlyArray<RepoCandidate>,
  ownedByExplicit: ReadonlySet<string>,
) =>
  RA.filter((name: string) => isInferredRepoRoot(name, ownedByExplicit))(
    RA.flatMap((r: RepoCandidate) => r.entityTypes)(repos),
  );

const resolveAggregateRoots = (
  graph: ProgramAggregateGraph,
  config: RootResolutionConfig,
) => {
  const explicitSet = collectExplicitRootSet(graph.candidates, config);
  return new Set([
    ...explicitSet,
    ...collectInferredRepoRoots(graph.repos, collectOwnedByExplicitSet(graph.candidates, explicitSet)),
  ]);
};

const indexCandidates = flow(
  RA.map((c: AggregateCandidate) => [c.name, c] as const),
  RR.fromEntries,
);

const buildGraphSummary = (
  graph: ProgramAggregateGraph,
  aggregateRoots: ReadonlySet<string>,
) => {
  const childOwnership = computeChildOwnership(graph.candidates, aggregateRoots);
  return {
    aggregateRoots,
    childToParentAggregates: childOwnership,
    repos: graph.repos,
    isChildEntity: flow(
      (name: string) => O.fromNullable(childOwnership[name]),
      O.filter((parents) => parents.length > 0),
    ),
    candidateMap: indexCandidates(graph.candidates),
  };
};

type AggregateGraphSummary = ReturnType<typeof buildGraphSummary>;

const aggregateSummaryCache = new WeakMap<
  ts.Program,
  Readonly<Record<string, AggregateGraphSummary>>
>();

const summarizeWithConfig = (config: RootResolutionConfig) =>
  flow(
    (graph: ProgramAggregateGraph) => ({ graph, roots: resolveAggregateRoots(graph, config) }),
    ({ graph, roots }) => buildGraphSummary(graph, roots),
  );

const makeAggregateCacheKey = (config: RootResolutionConfig) =>
  `${config.explicitOptionRoots.join(",")}|${config.aggregatePathPatterns.join(",")}`;

export const analyzeAggregateGraph = (
  program: ts.Program,
  config: Partial<RootResolutionConfig> = {},
): AggregateGraphSummary => {
  const resolved: RootResolutionConfig = {
    explicitOptionRoots: config.explicitOptionRoots ?? [],
    aggregatePathPatterns: config.aggregatePathPatterns ?? DEFAULT_AGGREGATE_PATHS,
  };
  return memoizeByProgramAndKey(
    aggregateSummaryCache,
    flow(resolveProgramGraph, summarizeWithConfig(resolved)),
  )(program, makeAggregateCacheKey(resolved));
};


