import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import { PREDICATE_NAME_RE } from "../utils/type-helpers.js";

type MessageIds = "preferPrism";
type GuardCheck = Readonly<
  Record<"targetName", string> & { readonly expr: TSESTree.Expression }
>;

const DISCRIMINANT_KEYS = new Set(["_tag", "kind", "type", "tag"]);

const isSpreadUpdateOf = (expr: TSESTree.Expression, targetName: string) =>
  expr.type === AST_NODE_TYPES.ObjectExpression &&
  expr.properties.length >= 2 &&
  pipe(
    expr.properties,
    RA.some(
      (p) =>
        p.type === AST_NODE_TYPES.SpreadElement &&
        p.argument.type === AST_NODE_TYPES.Identifier &&
        p.argument.name === targetName,
    ),
  );

const isDiscriminantAccessOf = ({ expr, targetName }: GuardCheck) =>
  expr.type === AST_NODE_TYPES.MemberExpression &&
  !expr.computed &&
  expr.object.type === AST_NODE_TYPES.Identifier &&
  expr.object.name === targetName &&
  expr.property.type === AST_NODE_TYPES.Identifier &&
  DISCRIMINANT_KEYS.has(expr.property.name);

const isDiscriminantComparisonOf = ({ expr, targetName }: GuardCheck) =>
  expr.type === AST_NODE_TYPES.BinaryExpression &&
  (expr.operator === "===" || expr.operator === "!==") &&
  (isDiscriminantAccessOf({ expr: expr.left, targetName }) ||
    isDiscriminantAccessOf({ expr: expr.right, targetName }));

const MONAD_GUARD_METHODS = new Set(["isSome", "isNone", "isRight", "isLeft"]);

const isPredicateCallee = (callee: TSESTree.Expression) =>
  (callee.type === AST_NODE_TYPES.Identifier &&
    !MONAD_GUARD_METHODS.has(callee.name) &&
    PREDICATE_NAME_RE.test(callee.name)) ||
  (callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    !MONAD_GUARD_METHODS.has(callee.property.name) &&
    PREDICATE_NAME_RE.test(callee.property.name));

const isPredicateCallOn = ({ expr, targetName }: GuardCheck) =>
  expr.type === AST_NODE_TYPES.CallExpression &&
  expr.arguments.length === 1 &&
  expr.arguments[0]?.type === AST_NODE_TYPES.Identifier &&
  expr.arguments[0].name === targetName &&
  isPredicateCallee(expr.callee);

const isVariantGuardOn = (check: GuardCheck) =>
  isDiscriminantComparisonOf(check) ||
  isPredicateCallOn(check) ||
  (check.expr.type === AST_NODE_TYPES.UnaryExpression &&
    check.expr.operator === "!" &&
    isPredicateCallOn({ expr: check.expr.argument, targetName: check.targetName }));

const getTernaryGuardedTarget = (node: TSESTree.ConditionalExpression) =>
  match([node.consequent, node.alternate] as const)
    .with(
      [{ type: AST_NODE_TYPES.ObjectExpression }, { type: AST_NODE_TYPES.Identifier }],
      ([upd, id]) => (isSpreadUpdateOf(upd, id.name) ? O.some(id.name) : O.none),
    )
    .with(
      [{ type: AST_NODE_TYPES.Identifier }, { type: AST_NODE_TYPES.ObjectExpression }],
      ([id, upd]) => (isSpreadUpdateOf(upd, id.name) ? O.some(id.name) : O.none),
    )
    .otherwise(() => O.none);

const hasDiscriminantProperty = (obj: TSESTree.ObjectExpression) =>
  pipe(
    obj.properties,
    RA.some(
      (p) =>
        p.type === AST_NODE_TYPES.Property &&
        !p.computed &&
        p.key.type === AST_NODE_TYPES.Identifier &&
        DISCRIMINANT_KEYS.has(p.key.name),
    ),
  );

const isDiscriminantPatternArg = (arg: O.Option<TSESTree.CallExpressionArgument>) =>
  pipe(
    arg,
    O.filter((a): a is TSESTree.ObjectExpression => a.type === AST_NODE_TYPES.ObjectExpression),
    O.exists(hasDiscriminantProperty),
  );

const isSpreadUpdateArrow = (fn: TSESTree.ArrowFunctionExpression) =>
  fn.params.length === 1 &&
  fn.params[0]?.type === AST_NODE_TYPES.Identifier &&
  fn.body.type === AST_NODE_TYPES.ObjectExpression &&
  isSpreadUpdateOf(fn.body, fn.params[0].name);

const isSpreadUpdateCallback = (arg: O.Option<TSESTree.CallExpressionArgument>) =>
  pipe(
    arg,
    O.filter(
      (a): a is TSESTree.ArrowFunctionExpression =>
        a.type === AST_NODE_TYPES.ArrowFunctionExpression,
    ),
    O.exists(isSpreadUpdateArrow),
  );

const isIdentityArrowFor = (fn: TSESTree.ArrowFunctionExpression, targetName: string) =>
  fn.body.type === AST_NODE_TYPES.Identifier &&
  (fn.body.name === targetName ||
    (fn.params.length === 1 &&
      fn.params[0]?.type === AST_NODE_TYPES.Identifier &&
      fn.params[0].name === fn.body.name));

const isIdentityFallbackCallback = (
  arg: O.Option<TSESTree.CallExpressionArgument>,
  targetName: string,
) =>
  pipe(
    arg,
    O.filter(
      (a): a is TSESTree.ArrowFunctionExpression =>
        a.type === AST_NODE_TYPES.ArrowFunctionExpression,
    ),
    O.exists((fn) => isIdentityArrowFor(fn, targetName)),
  );

const getMatchTargetFromWith = (withCall: TSESTree.CallExpression) =>
  withCall.callee.type === AST_NODE_TYPES.MemberExpression &&
  withCall.callee.property.type === AST_NODE_TYPES.Identifier &&
  withCall.callee.property.name === "with" &&
  withCall.callee.object.type === AST_NODE_TYPES.CallExpression &&
  withCall.callee.object.callee.type === AST_NODE_TYPES.Identifier &&
  withCall.callee.object.callee.name === "match" &&
  withCall.callee.object.arguments[0]?.type === AST_NODE_TYPES.Identifier &&
  isDiscriminantPatternArg(O.fromNullable(withCall.arguments[0])) &&
  isSpreadUpdateCallback(O.fromNullable(withCall.arguments[1]))
    ? O.some(withCall.callee.object.arguments[0].name)
    : O.none;

const isIdentityFallbackForCall = (node: TSESTree.CallExpression, targetName: string) =>
  isIdentityFallbackCallback(O.fromNullable(node.arguments[0]), targetName);

const isSingleVariantGuardedMatch = (node: TSESTree.CallExpression) =>
  node.callee.type === AST_NODE_TYPES.MemberExpression &&
  node.callee.property.type === AST_NODE_TYPES.Identifier &&
  node.callee.property.name === "otherwise" &&
  node.callee.object.type === AST_NODE_TYPES.CallExpression &&
  pipe(
    getMatchTargetFromWith(node.callee.object),
    O.exists((targetName) => isIdentityFallbackForCall(node, targetName)),
  );

const checkTernaryNode = (node: TSESTree.ConditionalExpression, report: () => void) => {
  pipe(
    getTernaryGuardedTarget(node),
    O.filter((targetName) => isVariantGuardOn({ expr: node.test, targetName })),
    O.map(report),
  );
};

const checkCallNode = (node: TSESTree.CallExpression, report: () => void) => {
  pipe(O.fromPredicate(isSingleVariantGuardedMatch)(node), O.map(report));
};

export const preferPrismOverGuardedUpdate = createRule<[], MessageIds>({
  name: "prefer-prism-over-guarded-update",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer `monocle-ts` `Prism` / `Optional` over guarded union-variant updates that return the value unchanged on other variants.",
    },
    messages: {
      preferPrism:
        "Guarded variant update with identity fallback. Use a `monocle-ts` `Prism` or `Optional` (e.g. `Prism.fromPredicate` + `modify`) to target and transform this variant declaratively.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    ConditionalExpression: (node) => {
      checkTernaryNode(node, () => {
        context.report({ node, messageId: "preferPrism" });
      });
    },
    CallExpression: (node) => {
      checkCallNode(node, () => {
        context.report({ node, messageId: "preferPrism" });
      });
    },
  }),
});
