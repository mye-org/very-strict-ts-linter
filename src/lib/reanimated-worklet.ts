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
  match(expr)
    .with(
      { type: AST_NODE_TYPES.MemberExpression, property: { type: AST_NODE_TYPES.Identifier } },
      (member) => O.some(member.property.name),
    )
    .with(P._, () => O.none)
    .exhaustive();

export const resolveCalleeName = ((callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.Identifier
    ? O.some(callee.name)
    : extractMemberPropName(callee)) satisfies (callee: TSESTree.Expression) => O.Option<string>;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const extractChainRootName = (expr: TSESTree.Expression): O.Option<string> =>
  match(expr)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => O.some(id.name))
    .with({ type: AST_NODE_TYPES.MemberExpression }, (member) =>
      extractChainRootName(member.object),
    )
    .with({ type: AST_NODE_TYPES.CallExpression }, (call) => extractChainRootName(call.callee))
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

const extractParentOfType = <T extends AST_NODE_TYPES>(expectedType: T) =>
  flow(
    (node: TSESTree.Node) => node.parent,
    O.fromNullable,
    O.filter((p): p is Extract<TSESTree.Node, { readonly type: T }> => p.type === expectedType),
  );

const isWorkletObjectHookProperty = flow(
  extractParentOfType(AST_NODE_TYPES.Property),
  O.flatMap(extractParentOfType(AST_NODE_TYPES.ObjectExpression)),
  O.flatMap(extractParentOfType(AST_NODE_TYPES.CallExpression)),
  O.flatMap((call) => resolveCalleeName(call.callee)),
  O.exists((name) => WORKLET_OBJECT_HOOK_NAMES.has(name)),
);

export const isWorkletFunction = ((node: FunctionNode) =>
  hasWorkletDirective(node) ||
  isWorkletCallArg(node) ||
  isWorkletObjectHookProperty(node)) satisfies (node: FunctionNode) => boolean;

const hasScheduleOnRnCallee = flow(
  resolveCalleeName,
  O.exists((name: string) => name === "scheduleOnRN"),
);

export const isScheduleOnRnCall = ((node: TSESTree.CallExpression) =>
  hasScheduleOnRnCallee(node.callee)) satisfies (node: TSESTree.CallExpression) => boolean;
