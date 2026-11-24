import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { isEsTreeAnonymousFunctionNode } from "../lib/estree-function-nodes.js";
import { isFlowCallExpression } from "../lib/flow-call.js";
import { isPipeCallExpression } from "../lib/pipe-call.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds =
  | "nestedChain"
  | "unwrapAndRewrap"
  | "mapThenFlatten"
  | "imperativeMonadCheck";

const MATCH_OR_FOLD_METHODS = new Set(["match", "matchW", "fold", "foldW"]);
const MONAD_GUARD_METHODS = new Set(["isSome", "isNone", "isRight", "isLeft"]);
const CHAIN_METHOD_NAMES: ReadonlySet<string> = new Set(["chain"]);
const MAP_METHOD_NAMES: ReadonlySet<string> = new Set(["map"]);
const FLATTEN_METHOD_NAMES: ReadonlySet<string> = new Set(["flatten"]);

const MONAD_REWRAP_CONSTRUCTORS = {
  O: new Set(["some", "none", "fromNullable"]),
  E: new Set(["right", "left", "of"]),
  TE: new Set(["right", "left", "of", "rightIO", "leftIO"]),
  T: new Set(["of"]),
} as const satisfies Readonly<Record<string, ReadonlySet<string>>>;

type MemberCallTarget = Readonly<Record<"namespace" | "method", string>>;

const resolveMemberIdentifiers = (callee: TSESTree.MemberExpression) =>
  match(callee)
    .with(
      { object: { type: AST_NODE_TYPES.Identifier }, property: { type: AST_NODE_TYPES.Identifier } },
      (m) => O.some<MemberCallTarget>({ namespace: m.object.name, method: m.property.name }),
    )
    .with(P._, () => O.none)
    .exhaustive();

const resolveMemberCall = (node: TSESTree.CallExpression) =>
  node.callee.type === AST_NODE_TYPES.MemberExpression
    ? resolveMemberIdentifiers(node.callee)
    : O.none;

const resolvePipeStepTarget = (arg: TSESTree.CallExpressionArgument) =>
  match(arg)
    .with({ type: AST_NODE_TYPES.CallExpression }, resolveMemberCall)
    .with({ type: AST_NODE_TYPES.MemberExpression }, resolveMemberIdentifiers)
    .with(P._, () => O.none)
    .exhaustive();

const isChainCallbackParent = (node: TSESTree.Node) =>
  isEsTreeAnonymousFunctionNode(node) &&
  node.parent.type === AST_NODE_TYPES.CallExpression &&
  O.exists((target: MemberCallTarget) => CHAIN_METHOD_NAMES.has(target.method))(
    resolveMemberCall(node.parent),
  );

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const isInsideOuterChainCallback = (node: TSESTree.Node): boolean =>
  node.parent && node.parent.type !== AST_NODE_TYPES.FunctionDeclaration
    ? isChainCallbackParent(node.parent) || isInsideOuterChainCallback(node.parent)
    : false;

const resolveSingleBlockReturnExpr = (body: TSESTree.BlockStatement) =>
  body.body.length === 1
    ? O.flatMap((stmt: TSESTree.Statement) =>
        stmt.type === AST_NODE_TYPES.ReturnStatement
          ? O.fromNullable(stmt.argument)
          : O.none,
      )(O.fromNullable(body.body[0]))
    : O.none;

const resolveCallbackReturnExpression = (arg: TSESTree.CallExpressionArgument) =>
  match(arg)
    .with(
      {
        type: AST_NODE_TYPES.ArrowFunctionExpression,
        body: { type: AST_NODE_TYPES.BlockStatement },
      },
      ({ body }) => resolveSingleBlockReturnExpr(body),
    )
    .with(
      { type: AST_NODE_TYPES.ArrowFunctionExpression },
      ({ body }) => O.some(body),
    )
    .with(P._, () => O.none)
    .exhaustive();

const isMonadConstructorExpr = ([
  expr,
  namespace,
  constructors,
]: readonly [TSESTree.Expression, string, ReadonlySet<string>]) =>
  (expr.type === AST_NODE_TYPES.MemberExpression &&
    expr.object.type === AST_NODE_TYPES.Identifier &&
    expr.object.name === namespace &&
    expr.property.type === AST_NODE_TYPES.Identifier &&
    constructors.has(expr.property.name)) ||
  (expr.type === AST_NODE_TYPES.CallExpression &&
    O.exists(
      (target: MemberCallTarget) =>
        target.namespace === namespace && constructors.has(target.method),
    )(resolveMemberCall(expr)));

const isMatchingMonadConstructor = ([
  arg,
  namespace,
  constructors,
]: readonly [TSESTree.CallExpressionArgument, string, ReadonlySet<string>]) =>
  O.exists((expr: TSESTree.Expression) => isMonadConstructorExpr([expr, namespace, constructors]))(
    resolveCallbackReturnExpression(arg),
  );

const isReturningSameMonadConstructor = (
  arg: TSESTree.CallExpressionArgument,
  namespace: string,
) =>
  O.exists((constructors: ReadonlySet<string>) =>
    isMatchingMonadConstructor([arg, namespace, constructors]),
  )(RR.lookup(namespace, MONAD_REWRAP_CONSTRUCTORS));

const isNegatedTernaryTest = (unary: TSESTree.UnaryExpression) =>
  unary.operator === "!" &&
  unary.parent.type === AST_NODE_TYPES.ConditionalExpression &&
  unary.parent.test === unary;

const isInTernaryTest = (node: TSESTree.CallExpression) =>
  (node.parent.type === AST_NODE_TYPES.ConditionalExpression &&
    node.parent.test === node) ||
  (node.parent.type === AST_NODE_TYPES.UnaryExpression && isNegatedTernaryTest(node.parent));

const isMapThenFlattenPair = (
  curr: TSESTree.CallExpressionArgument,
  next: TSESTree.CallExpressionArgument,
) =>
  match([resolvePipeStepTarget(curr), resolvePipeStepTarget(next)] as const)
    .with([{ _tag: "Some" }, { _tag: "Some" }], ([{ value: c }, { value: n }]) =>
      c.namespace === n.namespace &&
      MAP_METHOD_NAMES.has(c.method) &&
      FLATTEN_METHOD_NAMES.has(n.method),
    )
    .otherwise(() => false);

const findMapThenFlattenTargets = (
  args: ReadonlyArray<TSESTree.CallExpressionArgument>,
  startIndex: number,
) =>
  RA.filterMapWithIndex((i: number, arg: TSESTree.CallExpressionArgument) => {
    const next = args[i + 1];
    return i >= startIndex && next && isMapThenFlattenPair(arg, next) ? O.some(next) : O.none;
  })(args);

const isUnwrapAndRewrap = (node: TSESTree.CallExpression, target: MemberCallTarget) =>
  MATCH_OR_FOLD_METHODS.has(target.method) &&
  node.arguments.length === 2 &&
  RA.every((arg: TSESTree.CallExpressionArgument) =>
    isReturningSameMonadConstructor(arg, target.namespace),
  )(node.arguments);

const makeReport = (messageId: MessageIds, data: Readonly<Record<string, string>>) =>
  O.some([messageId, data] as const);

const formatGuardLabel = (target: MemberCallTarget) => `${target.namespace}.${target.method}`;

const classifyMemberCall = (node: TSESTree.CallExpression, target: MemberCallTarget) =>
  match({
    isNestedChain: CHAIN_METHOD_NAMES.has(target.method) && isInsideOuterChainCallback(node),
    isUnwrapRewrap: isUnwrapAndRewrap(node, target),
    isImperativeGuard: MONAD_GUARD_METHODS.has(target.method) && isInTernaryTest(node),
  })
    .with({ isNestedChain: true }, () => makeReport("nestedChain", {}))
    .with({ isUnwrapRewrap: true }, () => makeReport("unwrapAndRewrap", { method: target.method }))
    .with({ isImperativeGuard: true }, () =>
      makeReport("imperativeMonadCheck", { guard: formatGuardLabel(target) }),
    )
    .otherwise(() => O.none);

const resolvePipelineStartIndex = (node: TSESTree.CallExpression) =>
  match([isPipeCallExpression(node), isFlowCallExpression(node)] as const)
    .with([true, false], () => O.some(1))
    .with([false, true], () => O.some(0))
    .otherwise(() => O.none);

type MonadicReportDescriptor = Readonly<{
  node: TSESTree.Node;
  messageId: MessageIds;
  data: Readonly<Record<string, string>>;
}>;

const reportMemberCall = (
  node: TSESTree.CallExpression,
  report: (d: MonadicReportDescriptor) => void,
) => {
  const check = flow(
    resolveMemberCall,
    O.flatMap((target) => classifyMemberCall(node, target)),
    O.map(([messageId, data]) => { report({ node, messageId, data }); }),
  );
  check(node);
};

const reportPipelineCall =
  (report: (d: MonadicReportDescriptor) => void) =>
  (node: TSESTree.CallExpression, startIndex: number) => {
    RA.map((target: TSESTree.CallExpressionArgument) => {
      report({ node: target, messageId: "mapThenFlatten", data: {} });
    })(findMapThenFlattenTargets(node.arguments, startIndex));
  };

const checkCallNode =
  (report: (d: MonadicReportDescriptor) => void) =>
  (node: TSESTree.CallExpression) => {
    O.match(
      () => { reportMemberCall(node, report); },
      (startIndex: number) => { reportPipelineCall(report)(node, startIndex); },
    )(resolvePipelineStartIndex(node));
  };

export const preferMonadicComposition = createRule<[], MessageIds>({
  name: "prefer-monadic-composition",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Encourage idiomatic monadic composition (`flatMap`, `Do`-notation, `map`, `match`) over nested `chain`, unwrap-and-rewrap, `map` + `flatten`, and imperative monad guards.",
    },
    messages: {
      nestedChain:
        "Avoid nested `chain` calls. Use `Do`-notation (`Do`, `bind`, `apS`) or `flatMap` instead.",
      unwrapAndRewrap:
        "Avoid unwrapping with `{{method}}` only to re-wrap in the same monad. Use `map`, `flatMap`, or `orElse` instead.",
      mapThenFlatten:
        "Avoid `map(...)` followed by `flatten()`. Use `flatMap(...)` instead.",
      imperativeMonadCheck:
        "Avoid imperative monad guard `{{guard}}` in a ternary. Use `match`, `map`, or `getOrElse` instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    CallExpression: checkCallNode((d) => { context.report(d); }),
  }),
});
