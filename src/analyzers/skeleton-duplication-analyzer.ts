import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { memoizeByProgram, memoizeByProgramAndKey } from "../lib/program-memo.js";
import { collectProjectSourceFiles } from "../lib/source-paths.js";
import { TsLocation, makeLocationKey, resolveTsNodeLocation } from "../lib/ts-node-location.js";
import { collectTsNodes } from "../lib/ts-node-traversal.js";

export type SkeletonSite = Readonly<
  Record<"functionName", string> & {
    readonly location: TsLocation;
  }
>;

export type SkeletonCluster = Readonly<
  Record<"signature" | "preview", string> &
    Record<"stepCount", number> & {
      readonly sites: ReadonlyArray<SkeletonSite>;
    }
>;

export type SkeletonDuplicationAnalysis = Readonly<{
  readonly groups: ReadonlyArray<SkeletonCluster>;
  readonly locationIndex: Readonly<Record<string, ReadonlyArray<SkeletonCluster>>>;
}>;

type PipelineOccurrence = Readonly<
  Record<"signature" | "preview" | "functionName", string> &
    Record<"stepCount" | "distinctCombinators", number> & {
      readonly location: TsLocation;
    }
>;

type MemberToken = Readonly<Record<"token" | "combinator" | "method", string>>;

const occurrenceCache = new WeakMap<ts.Program, ReadonlyArray<PipelineOccurrence>>();
const analysisCache = new WeakMap<
  ts.Program,
  Readonly<Record<string, SkeletonDuplicationAnalysis>>
>();

const PURE_LIFT_METHODS: ReadonlySet<string> = new Set(["some", "of", "right", "left", "none"]);
const PIPELINE_FN_NAMES: ReadonlySet<string> = new Set(["pipe", "flow"]);
const PIPE_FN_NAMES: ReadonlySet<string> = new Set(["pipe"]);

const isPipeOrFlowCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  PIPELINE_FN_NAMES.has(node.expression.text);

const isPipeCallee = (expr: ts.Expression) =>
  ts.isIdentifier(expr) && PIPE_FN_NAMES.has(expr.text);

const buildMemberToken = (obj: string, method: string) => ({
  token: `${obj}.${method}`,
  combinator: `${obj}.${method}`,
  method,
});

const formatMemberPropToken = (prop: ts.PropertyAccessExpression) =>
  ts.isIdentifier(prop.expression)
    ? O.some(buildMemberToken(prop.expression.text, prop.name.text))
    : O.none;

const appendArity = (arity: number) => (base: MemberToken) => ({
  ...base,
  token: `${base.token}(${String(arity)})`,
});

const formatMemberCallToken = (call: ts.CallExpression) =>
  ts.isPropertyAccessExpression(call.expression)
    ? O.map(appendArity(call.arguments.length))(formatMemberPropToken(call.expression))
    : O.none;

const resolveMemberCombinatorToken = (expr: ts.Expression) =>
  match(expr)
    .when(ts.isCallExpression, formatMemberCallToken)
    .when(ts.isPropertyAccessExpression, formatMemberPropToken)
    .otherwise(() => O.none);

const isWorkflowSeedCall = (arg: ts.Expression) =>
  ts.isCallExpression(arg) &&
  O.exists(({ method }: MemberToken) => !PURE_LIFT_METHODS.has(method))(
    resolveMemberCombinatorToken(arg),
  );

const dropFirstArg = (args: ReadonlyArray<ts.Expression>) => args.slice(1);

const readFirstArg = (args: ReadonlyArray<ts.Expression>) => O.fromNullable(args[0]);

const hasWorkflowSeedFirstArg = flow(readFirstArg, O.exists(isWorkflowSeedCall));

const extractPipeArgs = (args: ReadonlyArray<ts.Expression>) =>
  hasWorkflowSeedFirstArg(args) ? args : dropFirstArg(args);

const toExprArray = (nodes: ts.NodeArray<ts.Expression>) => Array.from(nodes);

const extractPipelineSteps = (call: ts.CallExpression) =>
  isPipeCallee(call.expression)
    ? extractPipeArgs(toExprArray(call.arguments))
    : toExprArray(call.arguments);

const matchEnclosingDeclName = (node: ts.Node) =>
  match(node)
    .when(ts.isFunctionDeclaration, (fn) => (fn.name ? O.some(fn.name.text) : O.none))
    .when(ts.isVariableDeclaration, (v) => (ts.isIdentifier(v.name) ? O.some(v.name.text) : O.none))
    .otherwise(() => O.none);

const findEnclosingFunctionName: (node: ts.Node) => string = flow(
  (node: ts.Node) => ({ node, declName: matchEnclosingDeclName(node) }),
  ({ node, declName }) => O.getOrElse(() => lookupParentFunctionName(node))(declName),
);

const lookupParentFunctionName = flow(
  (n: ts.Node) => O.fromNullable(n.parent),
  O.match(() => "<anonymous>", findEnclosingFunctionName),
);

const parseStepToken = flow(
  resolveMemberCombinatorToken,
  O.getOrElse(() => ({ token: "$step", combinator: "", method: "" })),
);

const toSetSize = (items: ReadonlyArray<string>) => new Set(items).size;

const countDistinctCombinators = flow(
  RA.filterMap((s: Readonly<Record<"combinator", string>>) =>
    s.combinator.length > 0 ? O.some(s.combinator) : O.none,
  ),
  toSetSize,
);

const joinPipeArrow = (tokens: ReadonlyArray<string>) => tokens.join(" |> ");

const formatSignature = flow(
  RA.map((s: Readonly<Record<"token", string>>) => s.token),
  joinPipeArrow,
);

const toPipelineOccurrence = (call: ts.CallExpression, sf: ts.SourceFile) => {
  const steps = extractPipelineSteps(call);
  const parsedSteps = RA.map(parseStepToken)(steps);
  const signature = formatSignature(parsedSteps);
  return steps.length >= 2
    ? O.some<PipelineOccurrence>({
        signature,
        preview: signature,
        functionName: findEnclosingFunctionName(call),
        stepCount: steps.length,
        distinctCombinators: countDistinctCombinators(parsedSteps),
        location: resolveTsNodeLocation(call, sf),
      })
    : O.none;
};

const collectFileNodes = (sf: ts.SourceFile) => collectTsNodes(sf, sf);

const collectPipeOrFlowCalls = flow(collectFileNodes, RA.filter(isPipeOrFlowCall));

const extractFilePipelines = flow(
  (sf: ts.SourceFile) => ({ sf, calls: collectPipeOrFlowCalls(sf) }),
  ({ sf, calls }) => RA.filterMap((call: ts.CallExpression) => toPipelineOccurrence(call, sf))(calls),
);

const collectAllProgramPipelines = flow(collectProjectSourceFiles, RA.flatMap(extractFilePipelines));

const collectProgramPipelines = memoizeByProgram(occurrenceCache, collectAllProgramPipelines);

const groupBySignature = RNEA.groupBy((occ: PipelineOccurrence) => occ.signature);

const deduplicateOccurrences = flow(
  RNEA.groupBy((occ: PipelineOccurrence) => makeLocationKey(occ.location)),
  RR.toEntries,
  RA.map(([, group]) => RNEA.head(group)),
);

const toSiteList = RA.map((o: PipelineOccurrence) => ({
  functionName: o.functionName,
  location: o.location,
}));

const readFirstOccurrence = (list: ReadonlyArray<PipelineOccurrence>) => O.fromNullable(list[0]);

const toCluster =
  (minOccurrences: number) =>
  ([signature, group]: readonly [string, ReadonlyArray<PipelineOccurrence>]) => {
    const uniqueLocations = deduplicateOccurrences(group);
    return uniqueLocations.length >= minOccurrences
      ? O.map((first: PipelineOccurrence) => ({
          signature,
          preview: first.preview,
          stepCount: first.stepCount,
          sites: toSiteList(uniqueLocations),
        }))(readFirstOccurrence(uniqueLocations))
      : O.none;
  };

const expandClusterSites = (cluster: SkeletonCluster) =>
  RA.map((site: SkeletonSite) => [makeLocationKey(site.location), cluster] as const)(cluster.sites);

const extractClusterFromPair = ([, cluster]: readonly [string, SkeletonCluster]) => cluster;

const indexClustersByLocation = flow(
  RA.flatMap(expandClusterSites),
  RNEA.groupBy(([locKey]) => locKey),
  RR.map(RA.map(extractClusterFromPair)),
);

const buildSkeletonAnalysis = (groups: ReadonlyArray<SkeletonCluster>) => ({
  groups,
  locationIndex: indexClustersByLocation(groups),
});

export type SkeletonThresholds = Readonly<
  Record<"minSteps" | "minDistinctCombinators" | "minOccurrences", number>
>;

const DEFAULT_SKELETON_THRESHOLDS: SkeletonThresholds = {
  minSteps: 4,
  minDistinctCombinators: 3,
  minOccurrences: 2,
};

const computeSkeletonDuplicationsForThresholds = (thresholds: SkeletonThresholds) =>
  flow(
    collectProgramPipelines,
    RA.filter(
      (o: PipelineOccurrence) =>
        o.stepCount >= thresholds.minSteps &&
        o.distinctCombinators >= thresholds.minDistinctCombinators,
    ),
    groupBySignature,
    (rec: Readonly<Record<string, ReadonlyArray<PipelineOccurrence>>>) => RR.toEntries(rec),
    RA.filterMap(toCluster(thresholds.minOccurrences)),
    buildSkeletonAnalysis,
  );

const makeSkeletonCacheKey = (thresholds: SkeletonThresholds) =>
  `${String(thresholds.minSteps)}:${String(thresholds.minDistinctCombinators)}:${String(thresholds.minOccurrences)}`;

export const analyzeSkeletonDuplications = (
  program: ts.Program,
  thresholds: Partial<SkeletonThresholds> = {},
): SkeletonDuplicationAnalysis => {
  const resolved: SkeletonThresholds = { ...DEFAULT_SKELETON_THRESHOLDS, ...thresholds };
  return memoizeByProgramAndKey(
    analysisCache,
    computeSkeletonDuplicationsForThresholds(resolved),
  )(program, makeSkeletonCacheKey(resolved));
};
