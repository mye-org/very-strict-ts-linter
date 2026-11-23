import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import {
  getProjectSourceFiles,
  memoizeByProgram,
  memoizeByProgramAndKey,
} from "../utils/program-cache.js";
import {
  collectTsNodes,
  getTsNodeLocation,
  makeLocationKey,
  TsLocation,
} from "../utils/ts-ast-helpers.js";

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

const occurrenceCache = new WeakMap<ts.Program, ReadonlyArray<PipelineOccurrence>>();
const analysisCache = new WeakMap<
  ts.Program,
  Readonly<Record<string, SkeletonDuplicationAnalysis>>
>();

const PURE_LIFT_METHODS = new Set(["some", "of", "right", "left", "none"]);

const isPipeOrFlowCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  (node.expression.text === "pipe" || node.expression.text === "flow");

const formatMemberPropToken = (prop: ts.PropertyAccessExpression) =>
  ts.isIdentifier(prop.expression)
    ? O.some({
        token: `${prop.expression.text}.${prop.name.text}`,
        combinator: `${prop.expression.text}.${prop.name.text}`,
        method: prop.name.text,
      })
    : O.none;

const formatMemberCallToken = (call: ts.CallExpression) =>
  ts.isPropertyAccessExpression(call.expression)
    ? pipe(
        formatMemberPropToken(call.expression),
        O.map((base) => ({
          ...base,
          token: `${base.token}(${String(call.arguments.length)})`,
        })),
      )
    : O.none;

const getMemberCombinatorToken = (expr: ts.Expression) =>
  match(expr)
    .when(ts.isCallExpression, formatMemberCallToken)
    .when(ts.isPropertyAccessExpression, formatMemberPropToken)
    .otherwise(() => O.none);

const isWorkflowSeedCall = (arg: ts.Expression) =>
  ts.isCallExpression(arg) &&
  pipe(
    getMemberCombinatorToken(arg),
    O.exists(({ method }) => !PURE_LIFT_METHODS.has(method)),
  );

const extractPipeArgs = (args: ReadonlyArray<ts.Expression>) =>
  pipe(
    O.fromNullable(args[0]),
    O.filter(isWorkflowSeedCall),
    O.match(
      () => args.slice(1),
      () => args,
    ),
  );

const extractPipelineSteps = (call: ts.CallExpression) =>
  ts.isIdentifier(call.expression) && call.expression.text === "pipe"
    ? extractPipeArgs(Array.from(call.arguments))
    : Array.from(call.arguments);

const matchEnclosingDeclName = (node: ts.Node) =>
  match(node)
    .when(ts.isFunctionDeclaration, (fn) => (fn.name ? O.some(fn.name.text) : O.none))
    .when(ts.isVariableDeclaration, (v) => (ts.isIdentifier(v.name) ? O.some(v.name.text) : O.none))
    .otherwise(() => O.none);

const lookupParentFunctionName = (parent: O.Option<ts.Node>) =>
  pipe(parent, O.match(() => "<anonymous>", findEnclosingFunctionName));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive parent walk
const findEnclosingFunctionName = (node: ts.Node): string =>
  pipe(
    matchEnclosingDeclName(node),
    O.getOrElse(() => lookupParentFunctionName(O.fromNullable(node.parent))),
  );

const parseStepToken = (step: ts.Expression) =>
  pipe(
    getMemberCombinatorToken(step),
    O.getOrElse(() => ({ token: "$step", combinator: "", method: "" })),
  );

const countDistinctCombinators = (
  parsedSteps: ReadonlyArray<Readonly<Record<"combinator", string>>>,
) =>
  new Set(
    pipe(
      parsedSteps,
      RA.filterMap((s) => (s.combinator.length > 0 ? O.some(s.combinator) : O.none)),
    ),
  ).size;

const formatSignature = (parsedSteps: ReadonlyArray<Readonly<Record<"token", string>>>) =>
  pipe(parsedSteps, RA.map((s) => s.token)).join(" |> ");

const toPipelineOccurrence = (call: ts.CallExpression, sf: ts.SourceFile) => {
  const steps = extractPipelineSteps(call);
  const parsedSteps = pipe(steps, RA.map(parseStepToken));
  const signature = formatSignature(parsedSteps);
  return steps.length >= 2
    ? O.some({
        signature,
        preview: signature,
        functionName: findEnclosingFunctionName(call),
        stepCount: steps.length,
        distinctCombinators: countDistinctCombinators(parsedSteps),
        location: getTsNodeLocation(call, sf),
      })
    : O.none;
};

const extractFilePipelines = (sf: ts.SourceFile) =>
  pipe(
    collectTsNodes(sf, sf),
    RA.filter(isPipeOrFlowCall),
    RA.filterMap((call) => toPipelineOccurrence(call, sf)),
  );

const getProgramPipelines = (program: ts.Program) =>
  memoizeByProgram(program, occurrenceCache, (p) =>
    pipe(getProjectSourceFiles(p), RA.flatMap(extractFilePipelines)),
  );

const groupBySignature = (occurrences: ReadonlyArray<PipelineOccurrence>) =>
  pipe(
    occurrences,
    RA.reduce<PipelineOccurrence, Readonly<Record<string, ReadonlyArray<PipelineOccurrence>>>>(
      {},
      (acc, occ) => ({ ...acc, [occ.signature]: [...(acc[occ.signature] ?? []), occ] }),
    ),
  );

const hasLocationKey = (acc: ReadonlyArray<PipelineOccurrence>, occ: PipelineOccurrence) =>
  pipe(
    acc,
    RA.some((a) => makeLocationKey(a.location) === makeLocationKey(occ.location)),
  );

const deduplicateOccurrences = (group: ReadonlyArray<PipelineOccurrence>) =>
  pipe(
    group,
    RA.reduce<PipelineOccurrence, ReadonlyArray<PipelineOccurrence>>([], (acc, occ) =>
      hasLocationKey(acc, occ) ? acc : [...acc, occ],
    ),
  );

const toSiteList = (occurrences: ReadonlyArray<PipelineOccurrence>) =>
  pipe(
    occurrences,
    RA.map((o) => ({ functionName: o.functionName, location: o.location })),
  );

const toCluster = (
  signature: string,
  group: ReadonlyArray<PipelineOccurrence>,
  minOccurrences: number,
) => {
  const uniqueLocations = deduplicateOccurrences(group);
  return pipe(
    O.fromNullable(uniqueLocations[0]),
    O.filter(() => uniqueLocations.length >= minOccurrences),
    O.map((first) => ({
      signature,
      preview: first.preview,
      stepCount: first.stepCount,
      sites: toSiteList(uniqueLocations),
    })),
  );
};

const addClusterSitesToIndex = (
  acc: Readonly<Record<string, ReadonlyArray<SkeletonCluster>>>,
  cluster: SkeletonCluster,
) =>
  pipe(
    cluster.sites,
    RA.reduce(acc, (inner, site) => {
      const key = makeLocationKey(site.location);
      return { ...inner, [key]: [...(inner[key] ?? []), cluster] };
    }),
  );

const indexClustersByLocation = (groups: ReadonlyArray<SkeletonCluster>) =>
  pipe(
    groups,
    RA.reduce<SkeletonCluster, Readonly<Record<string, ReadonlyArray<SkeletonCluster>>>>(
      {},
      addClusterSitesToIndex,
    ),
  );

const computeSkeletonDuplications = (
  program: ts.Program,
  minSteps: number,
  minDistinctCombinators: number,
  minOccurrences: number,
) => {
  const groups = pipe(
    getProgramPipelines(program),
    RA.filter((o) => o.stepCount >= minSteps && o.distinctCombinators >= minDistinctCombinators),
    groupBySignature,
    RR.toEntries,
    RA.filterMap(([sig, group]) => toCluster(sig, group, minOccurrences)),
  );
  return { groups, locationIndex: indexClustersByLocation(groups) };
};

export const analyzeSkeletonDuplications = (
  program: ts.Program,
  minSteps = 4,
  minDistinctCombinators = 3,
  minOccurrences = 2,
) =>
  memoizeByProgramAndKey(
    program,
    `${String(minSteps)}:${String(minDistinctCombinators)}:${String(minOccurrences)}`,
    analysisCache,
    (p) => computeSkeletonDuplications(p, minSteps, minDistinctCombinators, minOccurrences),
  );
