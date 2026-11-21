import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { createRule } from "../utils/create-rule.js";

type MessageIds =
  | "nestedChain"
  | "unwrapAndRewrap"
  | "mapThenFlatten"
  | "imperativeMonadCheck";

const MATCH_OR_FOLD_METHODS = new Set(["match", "matchW", "fold", "foldW"]);
const MONAD_GUARD_METHODS = new Set(["isSome", "isNone", "isRight", "isLeft"]);

const MONAD_REWRAP_CONSTRUCTORS: Readonly<Record<string, ReadonlySet<string>>> = {
  O: new Set(["some", "none", "fromNullable"]),
  E: new Set(["right", "left", "of"]),
  TE: new Set(["right", "left", "of", "rightIO", "leftIO"]),
  T: new Set(["of"]),
};

const getMemberCallInfo = (node: TSESTree.CallExpression) =>
  node.callee.type === AST_NODE_TYPES.MemberExpression &&
  node.callee.object.type === AST_NODE_TYPES.Identifier &&
  node.callee.property.type === AST_NODE_TYPES.Identifier
    ? O.some({ namespace: node.callee.object.name, method: node.callee.property.name })
    : O.none;

const getPipeStepNamespaceAndMethod = (arg: TSESTree.CallExpressionArgument) => {
  if (arg.type === AST_NODE_TYPES.CallExpression) {
    return getMemberCallInfo(arg);
  }
  return arg.type === AST_NODE_TYPES.MemberExpression &&
    arg.object.type === AST_NODE_TYPES.Identifier &&
    arg.property.type === AST_NODE_TYPES.Identifier
    ? O.some({ namespace: arg.object.name, method: arg.property.name })
    : O.none;
};

const isChainCallbackParent = (node: TSESTree.Node) =>
  (node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionExpression) &&
  node.parent.type === AST_NODE_TYPES.CallExpression &&
  pipe(getMemberCallInfo(node.parent), O.exists((info) => info.method === "chain"));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const isInsideOuterChainCallback = (node: TSESTree.Node): boolean =>
  node.parent && node.parent.type !== AST_NODE_TYPES.FunctionDeclaration
    ? isChainCallbackParent(node.parent) || isInsideOuterChainCallback(node.parent)
    : false;

const getCallbackReturnExpression = (arg: TSESTree.CallExpressionArgument) => {
  if (arg.type !== AST_NODE_TYPES.ArrowFunctionExpression) {
    return O.none;
  }
  if (arg.body.type !== AST_NODE_TYPES.BlockStatement) {
    return O.some(arg.body);
  }
  const firstStmt = arg.body.body[0];
  return arg.body.body.length === 1 &&
    firstStmt?.type === AST_NODE_TYPES.ReturnStatement &&
    firstStmt.argument
    ? O.some(firstStmt.argument)
    : O.none;
};

const isMonadConstructorExpr = (
  expr: TSESTree.Expression,
  namespace: string,
  constructors: ReadonlySet<string>,
) =>
  (expr.type === AST_NODE_TYPES.MemberExpression &&
    expr.object.type === AST_NODE_TYPES.Identifier &&
    expr.object.name === namespace &&
    expr.property.type === AST_NODE_TYPES.Identifier &&
    constructors.has(expr.property.name)) ||
  (expr.type === AST_NODE_TYPES.CallExpression &&
    pipe(
      getMemberCallInfo(expr),
      O.exists((info) => info.namespace === namespace && constructors.has(info.method)),
    ));

const returnsSameMonadConstructor = (
  arg: TSESTree.CallExpressionArgument,
  namespace: string,
) =>
  pipe(
    O.fromNullable(MONAD_REWRAP_CONSTRUCTORS[namespace]),
    O.flatMap((constructors) =>
      pipe(
        getCallbackReturnExpression(arg),
        O.filter((expr) => isMonadConstructorExpr(expr, namespace, constructors)),
      ),
    ),
    O.isSome,
  );

const isInTernaryTest = (node: TSESTree.CallExpression) =>
  (node.parent.type === AST_NODE_TYPES.ConditionalExpression &&
    node.parent.test === node) ||
  (node.parent.type === AST_NODE_TYPES.UnaryExpression &&
    node.parent.operator === "!" &&
    node.parent.parent.type === AST_NODE_TYPES.ConditionalExpression &&
    node.parent.parent.test === node.parent);

const isMapThenFlattenPair = (
  curr: TSESTree.CallExpressionArgument,
  next: TSESTree.CallExpressionArgument,
) =>
  pipe(
    O.Do,
    O.apS("c", getPipeStepNamespaceAndMethod(curr)),
    O.apS("n", getPipeStepNamespaceAndMethod(next)),
    O.exists(({ c, n }) => c.namespace === n.namespace && c.method === "map" && n.method === "flatten"),
  );

const findMapThenFlattenTargets = (args: ReadonlyArray<TSESTree.CallExpressionArgument>) =>
  pipe(
    args,
    RA.filterMapWithIndex((i, arg) => {
      const next = args[i + 1];
      return i >= 1 && next && isMapThenFlattenPair(arg, next) ? O.some(next) : O.none;
    }),
  );

const isUnwrapAndRewrap = (
  node: TSESTree.CallExpression,
  namespace: string,
  method: string,
) => {
  const firstArg = node.arguments[0];
  const secondArg = node.arguments[1];
  return (
    MATCH_OR_FOLD_METHODS.has(method) &&
    node.arguments.length === 2 &&
    firstArg !== undefined &&
    secondArg !== undefined &&
    returnsSameMonadConstructor(firstArg, namespace) &&
    returnsSameMonadConstructor(secondArg, namespace)
  );
};

const makeReport = (messageId: MessageIds, data: Readonly<Record<string, string>>) =>
  O.some([messageId, data] as const);

const classifyMemberCall = (
  node: TSESTree.CallExpression,
  namespace: string,
  method: string,
) => {
  if (method === "chain" && isInsideOuterChainCallback(node)) {
    return makeReport("nestedChain", {});
  }
  if (isUnwrapAndRewrap(node, namespace, method)) {
    return makeReport("unwrapAndRewrap", { method });
  }
  if (MONAD_GUARD_METHODS.has(method) && isInTernaryTest(node)) {
    return makeReport("imperativeMonadCheck", { guard: `${namespace}.${method}` });
  }
  return O.none;
};

const checkCallNode = (
  node: TSESTree.CallExpression,
  report: (n: TSESTree.Node, messageId: MessageIds, data: Readonly<Record<string, string>>) => void,
) => {
  if (node.callee.type === AST_NODE_TYPES.Identifier && node.callee.name === "pipe") {
    pipe(
      findMapThenFlattenTargets(node.arguments),
      RA.map((target) => { report(target, "mapThenFlatten", {}); }),
    );
    return;
  }
  pipe(
    getMemberCallInfo(node),
    O.flatMap(({ namespace, method }) => classifyMemberCall(node, namespace, method)),
    O.map(([messageId, data]) => { report(node, messageId, data); }),
  );
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
    CallExpression: (node) => {
      checkCallNode(node, (n, messageId, data) => {
        context.report({ node: n, messageId, data });
      });
    },
  }),
});
