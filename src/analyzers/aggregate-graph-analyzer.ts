import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
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

const resolveFirstSymbolDecl = flow(
  (sym: ts.Symbol) => O.fromNullable(sym.declarations),
  O.flatMap(RA.head),
);

const resolveValueDecl = flow(
  (sym: ts.Symbol) => sym.valueDeclaration,
  O.fromNullable,
);

const resolveSymbolDecl = (sym: ts.Symbol) =>
  O.alt(() => resolveFirstSymbolDecl(sym))(resolveValueDecl(sym));

const resolveUnwrappedAtDecl = (checker: ts.TypeChecker) => (sym: ts.Symbol) =>
  flow(
    (decl: ts.Declaration) => checker.getTypeOfSymbolAtLocation(sym, decl),
    unwrapContainerTsTypes(checker),
  );

const resolveSymbolUnwrappedTypesFor = (checker: ts.TypeChecker) => (sym: ts.Symbol) =>
  flow(
    resolveSymbolDecl,
    O.map(resolveUnwrappedAtDecl(checker)(sym)),
    O.getOrElseW(() => []),
  );

const resolveSymbolUnwrappedTypes = (checker: ts.TypeChecker) => (sym: ts.Symbol) =>
  resolveSymbolUnwrappedTypesFor(checker)(sym)(sym);

const collectPropUnwrappedNames = (checker: ts.TypeChecker) => (prop: ts.Symbol) =>
  extractComplexEntityNames(resolveSymbolUnwrappedTypes(checker)(prop));

type NodeAndFile = Readonly<{ node: ts.Node; sf: ts.SourceFile }>;

const hasNodeAggregateSuffix = flow(
  (node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration) =>
    O.fromNullable(node.name),
  O.exists((name) => hasAggregateSuffix(name.text)),
);

const classifyCandidateOrigin =
  (fileName: string) =>
  (node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration) =>
    hasNodeAggregateSuffix(node) ||
    hasAggregateJsDoc(node) ||
    isMatchingAnyPattern(DEFAULT_AGGREGATE_PATHS)(fileName)
      ? ("explicit" as const)
      : ("inferred" as const);

const extractPropNamesForNode = (checker: ts.TypeChecker) =>
  flow(
    (node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration) =>
      checker.getTypeAtLocation(node).getProperties(),
    RA.flatMap(collectPropUnwrappedNames(checker)),
    RA.uniq(S.Eq),
  );

const collectReferencedTypes =
  (checker: ts.TypeChecker) =>
  (node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration) =>
    extractPropNamesForNode(checker)(node);

const buildAggregateCandidate =
  (checker: ts.TypeChecker) =>
  (name: string) =>
  ({
    node,
    sf,
  }: Readonly<{
    node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration;
    sf: ts.SourceFile;
  }>) => ({
    name,
    fileName: sf.fileName,
    origin: classifyCandidateOrigin(sf.fileName)(node),
    referencedTypes: collectReferencedTypes(checker)(node),
  });

const extractCandidate =
  (checker: ts.TypeChecker) =>
  ({ node, sf }: NodeAndFile) =>
    isEntityDecl(node) && node.name && !hasRepoSuffix(node.name.text)
      ? O.some<AggregateCandidate>(buildAggregateCandidate(checker)(node.name.text)({ node, sf }))
      : O.none;

const extractCallSignaturesForProp = (checker: ts.TypeChecker) => (prop: ts.Symbol) =>
  flow(
    resolveSymbolDecl,
    O.map((decl: ts.Declaration) =>
      checker.getTypeOfSymbolAtLocation(prop, decl).getCallSignatures(),
    ),
    O.getOrElseW(() => []),
  );

const collectSymbolCallSignatures = (checker: ts.TypeChecker) => (prop: ts.Symbol) =>
  extractCallSignaturesForProp(checker)(prop)(prop);

const collectSigParamUnwrappedTypes = (checker: ts.TypeChecker) => (sig: ts.Signature) =>
  RA.flatMap(resolveSymbolUnwrappedTypes(checker))(sig.getParameters());

const collectSignatureDomainTypes = (checker: ts.TypeChecker) => (sig: ts.Signature) => [
  ...unwrapContainerTsTypes(checker)(checker.getReturnTypeOfSignature(sig)),
  ...collectSigParamUnwrappedTypes(checker)(sig),
];

const filterRepoEntities = (checker: ts.TypeChecker) =>
  flow(
    RA.flatMap(collectSymbolCallSignatures(checker)),
    RA.flatMap(collectSignatureDomainTypes(checker)),
    extractComplexEntityNames,
    RA.filter((name) => !hasRepoSuffix(name)),
    RA.uniq(S.Eq),
  );

const extractRepoSignatureEntities = (checker: ts.TypeChecker) => (type: ts.Type) =>
  filterRepoEntities(checker)(type.getProperties());

const extractRepoCandidate =
  (checker: ts.TypeChecker) =>
  ({ node, sf }: NodeAndFile) =>
    isEntityDecl(node) && node.name && hasRepoSuffix(node.name.text)
      ? O.some<RepoCandidate>({
          repoName: node.name.text,
          fileName: sf.fileName,
          entityTypes: extractRepoSignatureEntities(checker)(checker.getTypeAtLocation(node)),
        })
      : O.none;

const collectFileNodes = (sf: ts.SourceFile) => collectTsNodes(sf)(sf);

const pairFileNodes = (sf: ts.SourceFile) =>
  RA.map((node: ts.Node) => ({ node, sf }))(collectFileNodes(sf));

const collectNodesAndFiles = flow(collectProjectSourceFiles, RA.flatMap(pairFileNodes));

const collectAggregateGraph = (program: ts.Program) => {
  const checker = program.getTypeChecker();
  const nodesAndFiles = collectNodesAndFiles(program);
  return {
    candidates: RA.filterMap(extractCandidate(checker))(nodesAndFiles),
    repos: RA.filterMap(extractRepoCandidate(checker))(nodesAndFiles),
  };
};

const resolveProgramGraph = memoizeByProgram(aggregateGraphCache)(collectAggregateGraph);

const toOwnedChildPair =
  (aggregateRoots: ReadonlySet<string>) => (aggName: string) => (child: string) =>
    child !== aggName && !aggregateRoots.has(child) ? O.some([child, aggName] as const) : O.none;

const extractAggregateChildPairs =
  (aggregateRoots: ReadonlySet<string>) => (agg: AggregateCandidate) =>
    RA.filterMap(toOwnedChildPair(aggregateRoots)(agg.name))(agg.referencedTypes);

const extractUniqueParents = flow(
  RA.map(([, parent]: readonly [string, string]) => parent),
  RA.uniq(S.Eq),
);

const groupChildParents = (aggregateRoots: ReadonlySet<string>) =>
  flow(
    RA.filter((c: AggregateCandidate) => aggregateRoots.has(c.name)),
    RA.flatMap(extractAggregateChildPairs(aggregateRoots)),
    RNEA.groupBy(([child]) => child),
    RR.map(extractUniqueParents),
  );

const computeChildOwnership =
  (aggregateRoots: ReadonlySet<string>) => (candidates: ReadonlyArray<AggregateCandidate>) =>
    groupChildParents(aggregateRoots)(candidates);

type RootResolutionConfig = Readonly<{
  readonly explicitOptionRoots: ReadonlyArray<string>;
  readonly aggregatePathPatterns: ReadonlyArray<string>;
}>;

const isExplicitCandidate =
  (aggregatePathPatterns: ReadonlyArray<string>) => (c: AggregateCandidate) =>
    c.origin === "explicit" ||
    (aggregatePathPatterns.length > 0 && isMatchingAnyPattern(aggregatePathPatterns)(c.fileName));

const extractExplicitCandidateName =
  (aggregatePathPatterns: ReadonlyArray<string>) => (c: AggregateCandidate) =>
    isExplicitCandidate(aggregatePathPatterns)(c) ? O.some(c.name) : O.none;

const collectExplicitRootSet =
  ({ explicitOptionRoots, aggregatePathPatterns }: RootResolutionConfig) =>
  (candidates: ReadonlyArray<AggregateCandidate>) =>
    new Set([
      ...explicitOptionRoots,
      ...RA.filterMap(extractExplicitCandidateName(aggregatePathPatterns))(candidates),
    ]);

const collectOwnedByExplicitSet =
  (explicitSet: ReadonlySet<string>) => (candidates: ReadonlyArray<AggregateCandidate>) =>
    new Set(
      RA.flatMap((c: AggregateCandidate) => c.referencedTypes)(
        RA.filter((c: AggregateCandidate) => explicitSet.has(c.name))(candidates),
      ),
    );

const isInferredRepoRoot = (ownedByExplicit: ReadonlySet<string>) => (name: string) =>
  !ownedByExplicit.has(name) && !hasIdSuffix(name);

const collectInferredRepoRoots =
  (ownedByExplicit: ReadonlySet<string>) => (repos: ReadonlyArray<RepoCandidate>) =>
    RA.filter(isInferredRepoRoot(ownedByExplicit))(
      RA.flatMap((r: RepoCandidate) => r.entityTypes)(repos),
    );

const resolveAggregateRoots =
  (config: RootResolutionConfig) => (graph: ProgramAggregateGraph) => {
    const explicitSet = collectExplicitRootSet(config)(graph.candidates);
    return new Set([
      ...explicitSet,
      ...collectInferredRepoRoots(collectOwnedByExplicitSet(explicitSet)(graph.candidates))(
        graph.repos,
      ),
    ]);
  };

const indexCandidates = flow(
  RA.map((c: AggregateCandidate) => [c.name, c] as const),
  RR.fromEntries,
);

const buildGraphSummary =
  (aggregateRoots: ReadonlySet<string>) => (graph: ProgramAggregateGraph) => {
    const childOwnership = computeChildOwnership(aggregateRoots)(graph.candidates);
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

const summarizeWithConfig = (config: RootResolutionConfig) => (graph: ProgramAggregateGraph) =>
  buildGraphSummary(resolveAggregateRoots(config)(graph))(graph);

const makeAggregateCacheKey = (config: RootResolutionConfig) =>
  `${config.explicitOptionRoots.join(",")}|${config.aggregatePathPatterns.join(",")}`;

export const analyzeAggregateGraph = ((program: ts.Program) =>
  (config: Partial<RootResolutionConfig> = {}) => {
    const resolved: RootResolutionConfig = {
      explicitOptionRoots: O.getOrElseW(() => [])(O.fromNullable(config.explicitOptionRoots)),
      aggregatePathPatterns: O.getOrElseW(() => DEFAULT_AGGREGATE_PATHS)(
        O.fromNullable(config.aggregatePathPatterns),
      ),
    };
    return memoizeByProgramAndKey(aggregateSummaryCache)(
      flow(resolveProgramGraph, summarizeWithConfig(resolved)),
    )(program)(makeAggregateCacheKey(resolved));
  }) satisfies (
  program: ts.Program,
) => (config?: Partial<RootResolutionConfig>) => AggregateGraphSummary;


