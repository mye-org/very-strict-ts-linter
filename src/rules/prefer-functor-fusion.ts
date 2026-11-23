import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { match, P } from "ts-pattern";
import { isEsTreeAnonymousFunctionNode } from "../lib/estree-function-nodes.js";
import { isFlowCallExpression } from "../lib/flow-call.js";
import { isPipeCallExpression } from "../lib/pipe-call.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "consecutiveMap" | "filterThenMap";
type CallStep = Readonly<
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
const OPTION_NAMESPACE_NAMES: ReadonlySet<string> = new Set(["O"]);
const IS_SOME_METHOD_NAMES: ReadonlySet<string> = new Set(["isSome"]);
const FILTER_OP_NAMES: ReadonlySet<string> = new Set(["filter"]);
const MAP_OP_NAMES: ReadonlySet<string> = new Set(["map"]);

const resolveMemberCallStep = (
  call: TSESTree.CallExpression,
  callee: TSESTree.MemberExpression,
) =>
  match(callee)
    .with(
      { object: { type: AST_NODE_TYPES.Identifier }, property: { type: AST_NODE_TYPES.Identifier } },
      (m) => O.some<CallStep>({ call, ns: m.object.name, op: m.property.name }),
    )
    .with(P._, () => O.none)
    .exhaustive();

const resolveCallStep = (arg: TSESTree.CallExpressionArgument) =>
  arg.type === AST_NODE_TYPES.CallExpression &&
  arg.callee.type === AST_NODE_TYPES.MemberExpression
    ? resolveMemberCallStep(arg, arg.callee)
    : O.none;

const isOptionIsSomeArg = (arg: TSESTree.CallExpressionArgument) =>
  arg.type === AST_NODE_TYPES.MemberExpression &&
  arg.object.type === AST_NODE_TYPES.Identifier &&
  OPTION_NAMESPACE_NAMES.has(arg.object.name) &&
  arg.property.type === AST_NODE_TYPES.Identifier &&
  IS_SOME_METHOD_NAMES.has(arg.property.name);

const isFusibleFilterMap = (
  currCall: TSESTree.CallExpression,
  nextCall: TSESTree.CallExpression,
) =>
  match([O.fromNullable(currCall.arguments[0]), O.fromNullable(nextCall.arguments[0])] as const)
    .with([{ _tag: "Some" }, { _tag: "Some" }], ([{ value: filterArg }, { value: mapArg }]) =>
      isOptionIsSomeArg(filterArg) ||
      (isEsTreeAnonymousFunctionNode(filterArg) && isEsTreeAnonymousFunctionNode(mapArg)),
    )
    .otherwise(() => false);

const makeFusionFinding = (
  target: TSESTree.CallExpressionArgument,
  messageId: MessageIds,
  namespace: string,
) => O.some<FusionFinding>({ target, messageId, namespace });

const isFilterMapPair = (c: CallStep, n: CallStep) =>
  FILTERABLE_NAMESPACES.has(c.ns) &&
  FILTER_OP_NAMES.has(c.op) &&
  MAP_OP_NAMES.has(n.op) &&
  isFusibleFilterMap(c.call, n.call);

const matchFusionPair = (
  c: CallStep,
  n: CallStep,
  second: TSESTree.CallExpressionArgument,
) =>
  match({
    sameNs: c.ns === n.ns,
    isMapMap: FUNCTOR_NAMESPACES.has(c.ns) && MAP_OP_NAMES.has(c.op) && MAP_OP_NAMES.has(n.op),
    isFilterMap: isFilterMapPair(c, n),
  })
    .with({ sameNs: true, isMapMap: true }, () => makeFusionFinding(second, "consecutiveMap", c.ns))
    .with({ sameNs: true, isFilterMap: true }, () => makeFusionFinding(second, "filterThenMap", c.ns))
    .otherwise(() => O.none);

const classifyAdjacentSteps = ({ first, second }: AdjacentPair) =>
  match([resolveCallStep(first), resolveCallStep(second)] as const)
    .with([{ _tag: "Some" }, { _tag: "Some" }], ([{ value: c }, { value: n }]) =>
      matchFusionPair(c, n, second),
    )
    .otherwise(() => O.none);

const checkNextStep = (
  first: TSESTree.CallExpressionArgument,
  secondOpt: O.Option<TSESTree.CallExpressionArgument>,
) => O.flatMap((second: TSESTree.CallExpressionArgument) => classifyAdjacentSteps({ first, second }))(secondOpt);

const findFusionTargets = (steps: ReadonlyArray<TSESTree.CallExpressionArgument>) =>
  RA.filterMapWithIndex((i: number, first: TSESTree.CallExpressionArgument) =>
    checkNextStep(first, O.fromNullable(steps[i + 1])),
  )(steps);

const resolvePipelineSteps = (node: TSESTree.CallExpression) =>
  match([isPipeCallExpression(node), isFlowCallExpression(node)] as const)
    .with([true, false], () => O.some(node.arguments.slice(1)))
    .with([false, true], () => O.some(node.arguments))
    .otherwise(() => O.none);

const reportTargets = (
  steps: ReadonlyArray<TSESTree.CallExpressionArgument>,
  report: (f: FusionFinding) => void,
) => {
  RA.map(report)(findFusionTargets(steps));
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
      O.map((steps: ReadonlyArray<TSESTree.CallExpressionArgument>) => {
        reportTargets(steps, ({ target, messageId, namespace }) => {
          context.report({ node: target, messageId, data: { namespace } });
        });
      })(resolvePipelineSteps(node));
    },
  }),
});
