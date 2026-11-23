import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import { isFlowCallExpression, isPipeCallExpression } from "../utils/type-helpers.js";

type MessageIds = "mapThenSequence" | "manualMonadicReduce";
type StepPair = Readonly<{
  readonly first: TSESTree.CallExpressionArgument;
  readonly second: TSESTree.CallExpressionArgument;
}>;

const COLLECTION_NAMESPACES = new Set(["RA", "A", "RNEA", "RR", "R"]);
const SEQUENCE_ARRAY_NAMESPACES = new Set(["O", "E", "TE", "T", "IO", "IOE", "RTE", "RE", "RT", "R"]);
const SEQUENCE_ARRAY_METHODS = new Set(["sequenceArray", "sequenceSeqArray"]);
const MONAD_EMPTY_ARRAY_CONSTRUCTORS = new Set(["some", "right", "of"]);

const getMemberExprInfo = (m: TSESTree.MemberExpression) =>
  !m.computed &&
  m.object.type === AST_NODE_TYPES.Identifier &&
  m.property.type === AST_NODE_TYPES.Identifier
    ? O.some({ namespace: m.object.name, method: m.property.name })
    : O.none;

const getMemberInfo = (node: TSESTree.CallExpressionArgument) =>
  match(node)
    .with(
      { type: AST_NODE_TYPES.CallExpression, callee: { type: AST_NODE_TYPES.MemberExpression } },
      (c) => getMemberExprInfo(c.callee),
    )
    .with({ type: AST_NODE_TYPES.MemberExpression }, getMemberExprInfo)
    .with(P._, () => O.none)
    .exhaustive();

const isCollectionMapStep = (arg: TSESTree.CallExpressionArgument) =>
  pipe(
    getMemberInfo(arg),
    O.filter((info) => COLLECTION_NAMESPACES.has(info.namespace) && info.method === "map"),
  );

const isSequenceStepFor = (arg: TSESTree.CallExpressionArgument, collectionNs: string) =>
  pipe(
    getMemberInfo(arg),
    O.exists(
      ({ namespace, method }) =>
        (SEQUENCE_ARRAY_NAMESPACES.has(namespace) && SEQUENCE_ARRAY_METHODS.has(method)) ||
        (namespace === collectionNs && method === "sequence"),
    ),
  );

const isMapThenSequencePair = ({ first, second }: StepPair) =>
  pipe(
    isCollectionMapStep(first),
    O.exists(({ namespace }) => isSequenceStepFor(second, namespace)),
  );

const matchNextMapSequence = (
  step: TSESTree.CallExpressionArgument,
  nextOpt: O.Option<TSESTree.CallExpressionArgument>,
) =>
  pipe(
    nextOpt,
    O.filter((second) => isMapThenSequencePair({ first: step, second })),
  );

const findMapThenSequenceTargets = (steps: ReadonlyArray<TSESTree.CallExpressionArgument>) =>
  pipe(
    steps,
    RA.filterMapWithIndex((i, step) => matchNextMapSequence(step, O.fromNullable(steps[i + 1]))),
  );

const isEmptyArrayExpr = (arg: TSESTree.CallExpressionArgument) =>
  (arg.type === AST_NODE_TYPES.ArrayExpression && arg.elements.length === 0) ||
  ((arg.type === AST_NODE_TYPES.TSAsExpression || arg.type === AST_NODE_TYPES.TSSatisfiesExpression) &&
    arg.expression.type === AST_NODE_TYPES.ArrayExpression &&
    arg.expression.elements.length === 0);

const hasEmptyArrayFirstArg = (call: TSESTree.CallExpression) =>
  pipe(O.fromNullable(call.arguments[0]), O.exists(isEmptyArrayExpr));

const isMonadicEmptyArraySeed = (arg: TSESTree.CallExpressionArgument) =>
  arg.type === AST_NODE_TYPES.CallExpression &&
  hasEmptyArrayFirstArg(arg) &&
  pipe(
    getMemberInfo(arg),
    O.exists(
      ({ namespace, method }) =>
        SEQUENCE_ARRAY_NAMESPACES.has(namespace) && MONAD_EMPTY_ARRAY_CONSTRUCTORS.has(method),
    ),
  );

const hasMonadicSeedFirstArg = (call: TSESTree.CallExpression) =>
  pipe(O.fromNullable(call.arguments[0]), O.exists(isMonadicEmptyArraySeed));

const isManualMonadicReduceCall = (node: TSESTree.CallExpression) =>
  hasMonadicSeedFirstArg(node) &&
  pipe(
    getMemberInfo(node),
    O.exists(({ namespace, method }) => COLLECTION_NAMESPACES.has(namespace) && method === "reduce"),
  );

const getPipelineSteps = (node: TSESTree.CallExpression) =>
  match([isPipeCallExpression(node), isFlowCallExpression(node)] as const)
    .with([true, false], () => O.some(node.arguments.slice(1)))
    .with([false, true], () => O.some(node.arguments))
    .otherwise(() => O.none);

const reportManualReduce = (
  node: TSESTree.CallExpression,
  report: (target: TSESTree.Node, messageId: MessageIds) => void,
) => {
  pipe(
    O.fromPredicate(isManualMonadicReduceCall)(node),
    O.map((n) => {
      report(n, "manualMonadicReduce");
    }),
  );
};

const reportMapSequenceTargets = (
  steps: ReadonlyArray<TSESTree.CallExpressionArgument>,
  report: (target: TSESTree.Node, messageId: MessageIds) => void,
) => {
  pipe(
    findMapThenSequenceTargets(steps),
    RA.map((target) => {
      report(target, "mapThenSequence");
    }),
  );
};

const checkCallExpression = (
  node: TSESTree.CallExpression,
  report: (target: TSESTree.Node, messageId: MessageIds) => void,
) => {
  pipe(
    getPipelineSteps(node),
    O.match(
      () => {
        reportManualReduce(node, report);
      },
      (steps) => {
        reportMapSequenceTargets(steps, report);
      },
    ),
  );
};

export const preferTraverseOverMapSequence = createRule<[], MessageIds>({
  name: "prefer-traverse-over-map-sequence",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer `Traversable` (`traverseArray` / `traverse`) over `map` followed by `sequence` or manual monadic `reduce` accumulating into an array.",
    },
    messages: {
      mapThenSequence:
        "Avoid `map(...)` followed by `sequence`. Use `traverseArray` / `traverseSeqArray` / `traverse` to perform the effectful traversal in a single pass.",
      manualMonadicReduce:
        "Avoid manually reducing into a monadic array seed. Use `traverseArray` / `traverseSeqArray` / `traverse` (Traversable) instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    CallExpression: (node) => {
      checkCallExpression(node, (target, messageId) => {
        context.report({ node: target, messageId });
      });
    },
  }),
});
