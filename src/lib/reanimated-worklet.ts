import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

const WORKLET_CALL_NAMES: ReadonlySet<string> = new Set([
  "useAnimatedStyle",
  "useAnimatedProps",
  "useDerivedValue",
  "useAnimatedReaction",
  "useFrameCallback",
  "useAnimatedScrollHandler",
  "useEvent",
  "useHandler",
  "useComposedEventHandler",
  "useWorkletCallback",
  "withTiming",
  "withSpring",
  "withDecay",
  "withSequence",
  "withRepeat",
  "withDelay",
  "withClamp",
  "withCallback",
  "scheduleOnUI",
  "runOnUI",
  "runOnUIAsync",
  "executeOnUIRuntimeSync",
  "scheduleOnRuntime",
  "runOnRuntime",
  "createWorkletRuntime",
]);

const WORKLET_OBJECT_HOOK_NAMES: ReadonlySet<string> = new Set([
  "useAnimatedScrollHandler",
  "useAnimatedGestureHandler",
  "useHandler",
]);

const GESTURE_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  "onBegin",
  "onStart",
  "onUpdate",
  "onChange",
  "onEnd",
  "onFinalize",
  "onTouchesDown",
  "onTouchesMove",
  "onTouchesUp",
  "onTouchesCancelled",
]);

const extractMemberPropName = (expr: TSESTree.Expression) =>
  match(expr.type === AST_NODE_TYPES.MemberExpression)
    .with(true, () => {
      const member = expr as TSESTree.MemberExpression;
      return member.property.type === AST_NODE_TYPES.Identifier
        ? O.some(member.property.name)
        : O.none;
    })
    .with(false, () => O.none)
    .exhaustive();

export const resolveCalleeName = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.Identifier
    ? O.some(callee.name)
    : extractMemberPropName(callee);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const extractChainRootName = (expr: TSESTree.Expression): O.Option<string> =>
  match(expr.type)
    .with(AST_NODE_TYPES.Identifier, () => O.some((expr as TSESTree.Identifier).name))
    .with(AST_NODE_TYPES.MemberExpression, () =>
      extractChainRootName((expr as TSESTree.MemberExpression).object),
    )
    .with(AST_NODE_TYPES.CallExpression, () =>
      extractChainRootName((expr as TSESTree.CallExpression).callee),
    )
    .with(P._, () => O.none)
    .exhaustive();

const isWorkletDirectiveStmt = (stmt: TSESTree.Statement) =>
  stmt.type === AST_NODE_TYPES.ExpressionStatement &&
  (stmt.directive === "worklet" ||
    (stmt.expression.type === AST_NODE_TYPES.Literal && stmt.expression.value === "worklet"));

const hasWorkletDirective = (node: FunctionNode) =>
  node.body.type === AST_NODE_TYPES.BlockStatement &&
  O.exists(isWorkletDirectiveStmt)(RA.head(node.body.body));

const isGestureCallbackCallee = (callee: TSESTree.Expression) =>
  O.exists((m: string) => GESTURE_CALLBACK_METHODS.has(m))(extractMemberPropName(callee)) &&
  O.exists((root: string) => root === "Gesture")(extractChainRootName(callee));

const isWorkletCallArg = (node: FunctionNode) =>
  node.parent.type === AST_NODE_TYPES.CallExpression &&
  (O.exists((name: string) => WORKLET_CALL_NAMES.has(name))(resolveCalleeName(node.parent.callee)) ||
    isGestureCallbackCallee(node.parent.callee));

const extractParentOfType =
  <T extends AST_NODE_TYPES>(expectedType: T) =>
  (node: TSESTree.Node) =>
    flow(
      (n: TSESTree.Node) => n.parent,
      O.fromNullable,
      O.filter((p): p is Extract<TSESTree.Node, { readonly type: T }> => p.type === expectedType),
    )(node);

const isWorkletObjectHookProperty = flow(
  extractParentOfType(AST_NODE_TYPES.Property),
  O.flatMap(extractParentOfType(AST_NODE_TYPES.ObjectExpression)),
  O.flatMap(extractParentOfType(AST_NODE_TYPES.CallExpression)),
  O.flatMap((call) => resolveCalleeName(call.callee)),
  O.exists((name) => WORKLET_OBJECT_HOOK_NAMES.has(name)),
);

export const isWorkletFunction = (node: FunctionNode) =>
  hasWorkletDirective(node) || isWorkletCallArg(node) || isWorkletObjectHookProperty(node);

export const isScheduleOnRnCall = (node: TSESTree.CallExpression) =>
  flow(
    (c: TSESTree.CallExpression) => resolveCalleeName(c.callee),
    O.exists((name) => name === "scheduleOnRN"),
  )(node);
