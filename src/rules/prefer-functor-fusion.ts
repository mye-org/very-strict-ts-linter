import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import {
  isEsTreeAnonymousFunctionNode,
  isFlowCallExpression,
  isPipeCallExpression,
} from "../utils/type-helpers.js";

type MessageIds = "consecutiveMap" | "filterThenMap";
type CallStepInfo = Readonly<
  Record<"ns" | "op", string> & { readonly call: TSESTree.CallExpression }
>;
type AdjacentPair = Readonly<{
  readonly first: TSESTree.CallExpressionArgument;
  readonly second: TSESTree.CallExpressionArgument;
}>;
type FusionFinding = Readonly<
  Record<"namespace", string> & {
    readonly target: TSESTree.CallExpressionArgument;
    readonly messageId: MessageIds;
  }
>;

const FUNCTOR_NAMESPACES = new Set([
  "RA",
  "A",
  "RNEA",
  "RR",
  "R",
  "O",
  "E",
  "TE",
  "T",
  "IO",
  "IOE",
  "RTE",
  "RE",
  "RT",
]);
const FILTERABLE_NAMESPACES = new Set(["RA", "A", "RR"]);

const getCallStepInfo = (arg: TSESTree.CallExpressionArgument) =>
  arg.type === AST_NODE_TYPES.CallExpression &&
  arg.callee.type === AST_NODE_TYPES.MemberExpression &&
  arg.callee.object.type === AST_NODE_TYPES.Identifier &&
  arg.callee.property.type === AST_NODE_TYPES.Identifier
    ? O.some<CallStepInfo>({
        call: arg,
        ns: arg.callee.object.name,
        op: arg.callee.property.name,
      })
    : O.none;

const isOptionIsSomeArg = (arg: TSESTree.CallExpressionArgument) =>
  arg.type === AST_NODE_TYPES.MemberExpression &&
  arg.object.type === AST_NODE_TYPES.Identifier &&
  arg.object.name === "O" &&
  arg.property.type === AST_NODE_TYPES.Identifier &&
  arg.property.name === "isSome";

const isFusibleFilterMap = (
  currCall: TSESTree.CallExpression,
  nextCall: TSESTree.CallExpression,
) =>
  pipe(
    O.Do,
    O.apS("filterArg", O.fromNullable(currCall.arguments[0])),
    O.apS("mapArg", O.fromNullable(nextCall.arguments[0])),
    O.exists(
      ({ filterArg, mapArg }) =>
        isOptionIsSomeArg(filterArg) ||
        (isEsTreeAnonymousFunctionNode(filterArg) && isEsTreeAnonymousFunctionNode(mapArg)),
    ),
  );

const makeFusionFinding = (
  target: TSESTree.CallExpressionArgument,
  messageId: MessageIds,
  namespace: string,
) => O.some<FusionFinding>({ target, messageId, namespace });

const isFilterMapPair = (c: CallStepInfo, n: CallStepInfo) =>
  FILTERABLE_NAMESPACES.has(c.ns) &&
  c.op === "filter" &&
  n.op === "map" &&
  isFusibleFilterMap(c.call, n.call);

const matchFusionPair = (
  c: CallStepInfo,
  n: CallStepInfo,
  second: TSESTree.CallExpressionArgument,
) =>
  match({
    sameNs: c.ns === n.ns,
    isMapMap: FUNCTOR_NAMESPACES.has(c.ns) && c.op === "map" && n.op === "map",
    isFilterMap: isFilterMapPair(c, n),
  })
    .with({ sameNs: true, isMapMap: true }, () => makeFusionFinding(second, "consecutiveMap", c.ns))
    .with({ sameNs: true, isFilterMap: true }, () => makeFusionFinding(second, "filterThenMap", c.ns))
    .otherwise(() => O.none);

const classifyAdjacentSteps = ({ first, second }: AdjacentPair) =>
  pipe(
    O.Do,
    O.apS("c", getCallStepInfo(first)),
    O.apS("n", getCallStepInfo(second)),
    O.flatMap(({ c, n }) => matchFusionPair(c, n, second)),
  );

const checkNextStep = (
  first: TSESTree.CallExpressionArgument,
  secondOpt: O.Option<TSESTree.CallExpressionArgument>,
) =>
  pipe(
    secondOpt,
    O.flatMap((second) => classifyAdjacentSteps({ first, second })),
  );

const findFusionTargets = (steps: ReadonlyArray<TSESTree.CallExpressionArgument>) =>
  pipe(
    steps,
    RA.filterMapWithIndex((i, first) => checkNextStep(first, O.fromNullable(steps[i + 1]))),
  );

const getPipelineSteps = (node: TSESTree.CallExpression) =>
  match([isPipeCallExpression(node), isFlowCallExpression(node)] as const)
    .with([true, false], () => O.some(node.arguments.slice(1)))
    .with([false, true], () => O.some(node.arguments))
    .otherwise(() => O.none);

const reportTargets = (
  steps: ReadonlyArray<TSESTree.CallExpressionArgument>,
  report: (f: FusionFinding) => void,
) => {
  pipe(findFusionTargets(steps), RA.map(report));
};

export const preferFunctorFusion = createRule<[], MessageIds>({
  name: "prefer-functor-fusion",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Enforce Functor composition fusion (`map(f)` followed by `map(g)` -> `map(flow(f, g))`) and `filterMap` fusion over consecutive inline `filter` + `map` steps.",
    },
    messages: {
      consecutiveMap:
        "Consecutive `{{namespace}}.map` steps in a pipeline. Fuse them via the Functor composition law: `{{namespace}}.map(flow(f, g))`.",
      filterThenMap:
        "Adjacent `{{namespace}}.filter` + `{{namespace}}.map` over a collection. Fuse them into a single-pass `{{namespace}}.filterMap` (or `compact`).",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    CallExpression: (node) => {
      pipe(
        getPipelineSteps(node),
        O.map((steps) => {
          reportTargets(steps, ({ target, messageId, namespace }) => {
            context.report({ node: target, messageId, data: { namespace } });
          });
        }),
      );
    },
  }),
});
