import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { isFlowCallExpression } from "../lib/flow-call.js";
import { isPipeCallExpression } from "../lib/pipe-call.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "mapThenSequence" | "manualMonadicReduce";
type StepPair = Readonly<{
  readonly first: TSESTree.CallExpressionArgument;
  readonly second: TSESTree.CallExpressionArgument;
}>;

const COLLECTION_NAMESPACES: ReadonlySet<string> = new Set(["RA", "A", "RNEA", "RR", "R"]);
const SEQUENCE_ARRAY_NAMESPACES: ReadonlySet<string> = new Set([
  "O",
  "E",
  "TE",
  "T",
  "IO",
  "IOE",
  "RTE",
  "RE",
  "RT",
  "R",
]);
const SEQUENCE_ARRAY_METHODS: ReadonlySet<string> = new Set(["sequenceArray", "sequenceSeqArray"]);
const MONAD_EMPTY_ARRAY_CONSTRUCTORS: ReadonlySet<string> = new Set(["some", "right", "of"]);
const MAP_METHODS: ReadonlySet<string> = new Set(["map"]);
const SEQUENCE_METHODS: ReadonlySet<string> = new Set(["sequence"]);
const REDUCE_METHODS: ReadonlySet<string> = new Set(["reduce"]);

const extractMemberCallee = (m: TSESTree.MemberExpression) =>
  !m.computed &&
  m.object.type === AST_NODE_TYPES.Identifier &&
  m.property.type === AST_NODE_TYPES.Identifier
    ? O.some({ namespace: m.object.name, method: m.property.name })
    : O.none;

const resolveMemberCallee = (node: TSESTree.CallExpressionArgument) =>
  match(node)
    .with(
      { type: AST_NODE_TYPES.CallExpression, callee: { type: AST_NODE_TYPES.MemberExpression } },
      (c) => extractMemberCallee(c.callee),
    )
    .with({ type: AST_NODE_TYPES.MemberExpression }, extractMemberCallee)
    .with(P._, () => O.none)
    .exhaustive();

const resolveCollectionMapStep = flow(
  resolveMemberCallee,
  O.filter(({ namespace, method }) => COLLECTION_NAMESPACES.has(namespace) && MAP_METHODS.has(method)),
);

const isSequenceStepFor = (arg: TSESTree.CallExpressionArgument, collectionNs: string) => {
  const check = flow(
    resolveMemberCallee,
    O.exists(
      ({ namespace, method }) =>
        (SEQUENCE_ARRAY_NAMESPACES.has(namespace) && SEQUENCE_ARRAY_METHODS.has(method)) ||
        (namespace === collectionNs && SEQUENCE_METHODS.has(method)),
    ),
  );
  return check(arg);
};

const isMapThenSequencePair = ({ first, second }: StepPair) => {
  const check = flow(
    resolveCollectionMapStep,
    O.exists(({ namespace }) => isSequenceStepFor(second, namespace)),
  );
  return check(first);
};

const matchNextMapSequence = (
  step: TSESTree.CallExpressionArgument,
  nextOpt: O.Option<TSESTree.CallExpressionArgument>,
) => O.filter((second: TSESTree.CallExpressionArgument) => isMapThenSequencePair({ first: step, second }))(nextOpt);

const findMapThenSequenceTargets = (steps: ReadonlyArray<TSESTree.CallExpressionArgument>) =>
  RA.filterMapWithIndex((i: number, step: TSESTree.CallExpressionArgument) =>
    matchNextMapSequence(step, O.fromNullable(steps[i + 1])),
  )(steps);

const isEmptyArrayLiteral = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.ArrayExpression && node.elements.length === 0;

const isEmptyArrayExpr = (arg: TSESTree.CallExpressionArgument) =>
  isEmptyArrayLiteral(arg) ||
  ((arg.type === AST_NODE_TYPES.TSAsExpression || arg.type === AST_NODE_TYPES.TSSatisfiesExpression) &&
    isEmptyArrayLiteral(arg.expression));

const hasEmptyArrayFirstArg = flow(
  (call: TSESTree.CallExpression) => call.arguments[0],
  O.fromNullable,
  O.exists(isEmptyArrayExpr),
);

const isMonadicEmptyArrayMember = flow(
  resolveMemberCallee,
  O.exists(
    ({ namespace, method }) =>
      SEQUENCE_ARRAY_NAMESPACES.has(namespace) && MONAD_EMPTY_ARRAY_CONSTRUCTORS.has(method),
  ),
);

const isMonadicEmptyArraySeed = (arg: TSESTree.CallExpressionArgument) =>
  arg.type === AST_NODE_TYPES.CallExpression &&
  hasEmptyArrayFirstArg(arg) &&
  isMonadicEmptyArrayMember(arg);

const hasMonadicSeedFirstArg = flow(
  (call: TSESTree.CallExpression) => call.arguments[0],
  O.fromNullable,
  O.exists(isMonadicEmptyArraySeed),
);

const isCollectionReduceMember = flow(
  resolveMemberCallee,
  O.exists(({ namespace, method }) => COLLECTION_NAMESPACES.has(namespace) && REDUCE_METHODS.has(method)),
);

const isManualMonadicReduceCall = (node: TSESTree.CallExpression) =>
  hasMonadicSeedFirstArg(node) && isCollectionReduceMember(node);

const extractPipelineSteps = (node: TSESTree.CallExpression) =>
  match([isPipeCallExpression(node), isFlowCallExpression(node)] as const)
    .with([true, false], () => O.some(RA.dropLeft(1)(node.arguments)))
    .with([false, true], () => O.some(node.arguments))
    .otherwise(() => O.none);

const reportManualReduce = (
  node: TSESTree.CallExpression,
  report: (target: TSESTree.Node, messageId: MessageIds) => void,
) => {
  const check = flow(
    O.fromPredicate(isManualMonadicReduceCall),
    O.map((n) => {
      report(n, "manualMonadicReduce");
    }),
  );
  check(node);
};

const reportMapSequenceTargets = (
  steps: ReadonlyArray<TSESTree.CallExpressionArgument>,
  report: (target: TSESTree.Node, messageId: MessageIds) => void,
) => {
  const run = flow(
    findMapThenSequenceTargets,
    RA.map((target) => {
      report(target, "mapThenSequence");
    }),
  );
  run(steps);
};

const checkCallExpression = (
  node: TSESTree.CallExpression,
  report: (target: TSESTree.Node, messageId: MessageIds) => void,
) => {
  const check = flow(
    extractPipelineSteps,
    O.match(
      () => {
        reportManualReduce(node, report);
      },
      (steps) => {
        reportMapSequenceTargets(steps, report);
      },
    ),
  );
  check(node);
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
