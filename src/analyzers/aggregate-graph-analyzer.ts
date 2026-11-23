import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as R from "fp-ts/lib/Record.js";
import * as S from "fp-ts/lib/string.js";
import { flow, pipe } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import {
  getProjectSourceFiles,
  isMatchingAnyPattern,
  memoizeByProgram,
  memoizeByProgramAndKey,
} from "../utils/program-cache.js";
import { collectTsNodes } from "../utils/ts-ast-helpers.js";
import { getTsTypeName, isBrandedOrNewtypeTsType, unwrapContainerTsTypes } from "../utils/type-helpers.js";

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
const AGGREGATE_TAGS = new Set(["aggregateRoot", "aggregate"]);
const IGNORED_ENTITY_NAMES = new Set([
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

const hasRepoSuffix = (name: string) =>
  pipe(REPO_SUFFIXES, RA.some((s) => name.endsWith(s)));

const hasAggregateJsDoc = (node: ts.Node) =>
  pipe(ts.getJSDocTags(node), RA.some((tag) => AGGREGATE_TAGS.has(tag.tagName.text)));

const isEntityDecl = (
  node: ts.Node,
): node is ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration =>
  ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node);

const isComplexDomainType = (t: ts.Type) =>
  !isBrandedOrNewtypeTsType(t) && t.getProperties().length > 0;

const getPropUnwrappedNames = (prop: ts.Symbol, checker: ts.TypeChecker) =>
  pipe(
    O.fromNullable(prop.valueDeclaration ?? prop.declarations?.[0]),
    O.map((decl) => checker.getTypeOfSymbolAtLocation(prop, decl)),
    O.map((t) => unwrapContainerTsTypes(t, checker)),
    O.getOrElse(() => [] as ReadonlyArray<ts.Type>),
    RA.filter(isComplexDomainType),
    RA.filterMap(getTsTypeName),
    RA.filter((name) => !IGNORED_ENTITY_NAMES.has(name)),
  );

const getCandidateOrigin = (
  name: string,
  node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration,
  sf: ts.SourceFile,
) =>
  name.endsWith(AGGREGATE_SUFFIX) ||
  hasAggregateJsDoc(node) ||
  isMatchingAnyPattern(sf.fileName, DEFAULT_AGGREGATE_PATHS)
    ? ("explicit" as const)
    : ("inferred" as const);

const buildAggregateCandidate = (
  name: string,
  node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) => ({
  name,
  fileName: sf.fileName,
  origin: getCandidateOrigin(name, node, sf),
  referencedTypes: pipe(
    checker.getTypeAtLocation(node).getProperties(),
    RA.flatMap((prop) => getPropUnwrappedNames(prop, checker)),
    RA.uniq(S.Eq),
  ),
});

const extractCandidate = (node: ts.Node, sf: ts.SourceFile, checker: ts.TypeChecker) =>
  isEntityDecl(node) && node.name && !hasRepoSuffix(node.name.text)
    ? O.some<AggregateCandidate>(buildAggregateCandidate(node.name.text, node, sf, checker))
    : O.none;

const getSymbolCallSignatures = (prop: ts.Symbol, checker: ts.TypeChecker) =>
  pipe(
    O.fromNullable(prop.valueDeclaration ?? prop.declarations?.[0]),
    O.map((decl) => checker.getTypeOfSymbolAtLocation(prop, decl).getCallSignatures()),
    O.getOrElse(() => [] as ReadonlyArray<ts.Signature>),
  );

const getParamUnwrappedTypes = (param: ts.Symbol, checker: ts.TypeChecker) =>
  pipe(
    O.fromNullable(param.valueDeclaration ?? param.declarations?.[0]),
    O.map(flow((d) => checker.getTypeOfSymbolAtLocation(param, d), (t) => unwrapContainerTsTypes(t, checker))),
    O.getOrElse(() => [] as ReadonlyArray<ts.Type>),
  );

const getSigParamUnwrappedTypes = (sig: ts.Signature, checker: ts.TypeChecker) =>
  pipe(sig.getParameters(), RA.flatMap((p) => getParamUnwrappedTypes(p, checker)));

const extractRepoSignatureEntities = (type: ts.Type, checker: ts.TypeChecker) =>
  pipe(
    type.getProperties(),
    RA.flatMap((prop) => getSymbolCallSignatures(prop, checker)),
    RA.flatMap((sig) => [
      ...unwrapContainerTsTypes(checker.getReturnTypeOfSignature(sig), checker),
      ...getSigParamUnwrappedTypes(sig, checker),
    ]),
    RA.filter(isComplexDomainType),
    RA.filterMap(getTsTypeName),
    RA.filter((name) => !IGNORED_ENTITY_NAMES.has(name) && !hasRepoSuffix(name)),
    RA.uniq(S.Eq),
  );

const extractRepoCandidate = (node: ts.Node, sf: ts.SourceFile, checker: ts.TypeChecker) =>
  isEntityDecl(node) && node.name && hasRepoSuffix(node.name.text)
    ? O.some<RepoCandidate>({
        repoName: node.name.text,
        fileName: sf.fileName,
        entityTypes: extractRepoSignatureEntities(checker.getTypeAtLocation(node), checker),
      })
    : O.none;

const pairFileNodes = (sf: ts.SourceFile) =>
  pipe(collectTsNodes(sf, sf), RA.map((node) => ({ node, sf })));

const collectNodesAndFiles = (program: ts.Program) =>
  pipe(getProjectSourceFiles(program), RA.flatMap(pairFileNodes));

const collectAggregateGraph = (program: ts.Program) => {
  const checker = program.getTypeChecker();
  const nodesAndFiles = collectNodesAndFiles(program);
  return {
    candidates: pipe(nodesAndFiles, RA.filterMap(({ node, sf }) => extractCandidate(node, sf, checker))),
    repos: pipe(nodesAndFiles, RA.filterMap(({ node, sf }) => extractRepoCandidate(node, sf, checker))),
  };
};

const getProgramGraph = (program: ts.Program) =>
  memoizeByProgram(program, aggregateGraphCache, collectAggregateGraph);

const extractAggregateChildPairs = (
  agg: AggregateCandidate,
  aggregateRoots: ReadonlySet<string>,
) =>
  pipe(
    agg.referencedTypes,
    RA.filter((child) => child !== agg.name && !aggregateRoots.has(child)),
    RA.map((child) => [child, agg.name] as const),
  );

const appendUniqueParent = (existing: O.Option<ReadonlyArray<string>>, parent: string) =>
  pipe(
    [...O.getOrElse(() => [] as ReadonlyArray<string>)(existing), parent],
    RA.uniq(S.Eq),
  );

const computeChildOwnership = (
  candidates: ReadonlyArray<AggregateCandidate>,
  aggregateRoots: ReadonlySet<string>,
) =>
  pipe(
    candidates,
    RA.filter((c) => aggregateRoots.has(c.name)),
    RA.flatMap((agg) => extractAggregateChildPairs(agg, aggregateRoots)),
    RA.reduce({}, (acc: Readonly<Record<string, ReadonlyArray<string>>>, [child, parent]) => ({
      ...acc,
      [child]: appendUniqueParent(O.fromNullable(acc[child]), parent),
    })),
  );

type RootResolutionConfig = Readonly<{
  readonly explicitOptionRoots: ReadonlyArray<string>;
  readonly aggregatePathPatterns: ReadonlyArray<string>;
}>;

const getExplicitRootSet = (
  candidates: ReadonlyArray<AggregateCandidate>,
  { explicitOptionRoots, aggregatePathPatterns }: RootResolutionConfig,
) =>
  new Set([
    ...explicitOptionRoots,
    ...pipe(
      candidates,
      RA.filter(
        (c) =>
          c.origin === "explicit" ||
          (aggregatePathPatterns.length > 0 && isMatchingAnyPattern(c.fileName, aggregatePathPatterns)),
      ),
      RA.map((c) => c.name),
    ),
  ]);

const getOwnedByExplicitSet = (
  candidates: ReadonlyArray<AggregateCandidate>,
  explicitSet: ReadonlySet<string>,
) =>
  new Set(
    pipe(
      candidates,
      RA.filter((c) => explicitSet.has(c.name)),
      RA.flatMap((c) => c.referencedTypes),
    ),
  );

const resolveAggregateRoots = (
  graph: ProgramAggregateGraph,
  config: RootResolutionConfig,
) => {
  const explicitSet = getExplicitRootSet(graph.candidates, config);
  const ownedByExplicit = getOwnedByExplicitSet(graph.candidates, explicitSet);
  return new Set([
    ...explicitSet,
    ...pipe(
      graph.repos,
      RA.flatMap((r) => r.entityTypes),
      RA.filter((name) => !ownedByExplicit.has(name) && !name.endsWith("Id")),
    ),
  ]);
};

const indexCandidates = (candidates: ReadonlyArray<AggregateCandidate>) => {
  const map: Record<string, AggregateCandidate> = {};
  for (const c of candidates) {
    map[c.name] = c;
  }
  return map as Readonly<Record<string, AggregateCandidate>>;
};

const buildGraphSummary = (
  graph: ProgramAggregateGraph,
  aggregateRoots: ReadonlySet<string>,
) => {
  const childOwnership = computeChildOwnership(graph.candidates, aggregateRoots);
  return {
    aggregateRoots,
    childToParentAggregates: childOwnership,
    repos: graph.repos,
    isChildEntity: (name: string) =>
      pipe(O.fromNullable(childOwnership[name]), O.filter((parents) => parents.length > 0)),
    candidateMap: indexCandidates(graph.candidates),
  };
};

type AggregateGraphSummary = ReturnType<typeof buildGraphSummary>;

const aggregateSummaryCache = new WeakMap<ts.Program, Readonly<Record<string, AggregateGraphSummary>>>();

const summarizeWithConfig = (config: RootResolutionConfig) => (graph: ProgramAggregateGraph) =>
  pipe(resolveAggregateRoots(graph, config), (roots) => buildGraphSummary(graph, roots));

export const analyzeAggregateGraph = (
  program: ts.Program,
  explicitOptionRoots: ReadonlyArray<string> = [],
  aggregatePathPatterns: ReadonlyArray<string> = DEFAULT_AGGREGATE_PATHS,
) =>
  memoizeByProgramAndKey(
    program,
    `${explicitOptionRoots.join(",")}|${aggregatePathPatterns.join(",")}`,
    aggregateSummaryCache,
    flow(getProgramGraph, summarizeWithConfig({ explicitOptionRoots, aggregatePathPatterns })),
  );

export const listAggregateOwnershipEdges = (
  program: ts.Program,
  explicitOptionRoots: ReadonlyArray<string> = [],
) =>
  pipe(
    analyzeAggregateGraph(program, explicitOptionRoots).childToParentAggregates,
    R.toEntries,
    RA.map(([child, parents]) => ({ child, parents })),
  );
