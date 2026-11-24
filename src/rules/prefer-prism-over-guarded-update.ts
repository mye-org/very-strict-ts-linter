import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { PREDICATE_NAME_RE } from "../lib/predicate-name.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "preferPrism";
type GuardCheck = Readonly<
  Record<"targetName", string> & { readonly expr: TSESTree.Expression }
>;

const DISCRIMINANT_KEYS: ReadonlySet<string> = new Set(["_tag", "kind", "type", "tag"]);
const MONAD_GUARD_METHODS: ReadonlySet<string> = new Set(["isSome", "isNone", "isRight", "isLeft"]);
const WITH_METHODS: ReadonlySet<string> = new Set(["with"]);
const OTHERWISE_METHODS: ReadonlySet<string> = new Set(["otherwise"]);
const MATCH_CALLEES: ReadonlySet<string> = new Set(["match"]);

const isIdentifierNamed = (name: string, node?: TSESTree.Node) =>
  O.exists((n: TSESTree.Node) => n.type === AST_NODE_TYPES.Identifier && n.name === name)(
    O.fromNullable(node),
  );

const isSpreadUpdateOf = (expr: TSESTree.Expression, targetName: string) =>
  expr.type === AST_NODE_TYPES.ObjectExpression &&
  expr.properties.length >= 2 &&
  RA.some(
    (p: TSESTree.ObjectLiteralElement) =>
      p.type === AST_NODE_TYPES.SpreadElement && isIdentifierNamed(targetName, p.argument),
  )(expr.properties);

const isDiscriminantAccessOf = ({ expr, targetName }: GuardCheck) =>
  expr.type === AST_NODE_TYPES.MemberExpression &&
  !expr.computed &&
  isIdentifierNamed(targetName, expr.object) &&
  expr.property.type === AST_NODE_TYPES.Identifier &&
  DISCRIMINANT_KEYS.has(expr.property.name);

const isDiscriminantComparisonOf = ({ expr, targetName }: GuardCheck) =>
  expr.type === AST_NODE_TYPES.BinaryExpression &&
  (expr.operator === "===" || expr.operator === "!==") &&
  (isDiscriminantAccessOf({ expr: expr.left, targetName }) ||
    isDiscriminantAccessOf({ expr: expr.right, targetName }));

const isMatchingPredicateName = (name: string) => PREDICATE_NAME_RE.test(name);

const isCustomPredicateName = (name: string) =>
  !MONAD_GUARD_METHODS.has(name) && isMatchingPredicateName(name);

const isPredicateCallee = (callee: TSESTree.Expression) =>
  (callee.type === AST_NODE_TYPES.Identifier && isCustomPredicateName(callee.name)) ||
  (callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    isCustomPredicateName(callee.property.name));

const isPredicateCallOn = ({ expr, targetName }: GuardCheck) =>
  expr.type === AST_NODE_TYPES.CallExpression &&
  expr.arguments.length === 1 &&
  isIdentifierNamed(targetName, expr.arguments[0]) &&
  isPredicateCallee(expr.callee);

const isVariantGuardOn = (check: GuardCheck) =>
  isDiscriminantComparisonOf(check) ||
  isPredicateCallOn(check) ||
  (check.expr.type === AST_NODE_TYPES.UnaryExpression &&
    check.expr.operator === "!" &&
    isPredicateCallOn({ expr: check.expr.argument, targetName: check.targetName }));

const extractTernaryGuardedTarget = (node: TSESTree.ConditionalExpression) =>
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
  RA.some(
    (p: TSESTree.ObjectLiteralElement) =>
      p.type === AST_NODE_TYPES.Property &&
      !p.computed &&
      p.key.type === AST_NODE_TYPES.Identifier &&
      DISCRIMINANT_KEYS.has(p.key.name),
  )(obj.properties);

const isDiscriminantPatternArg = flow(
  O.filter(
    (a: TSESTree.CallExpressionArgument): a is TSESTree.ObjectExpression =>
      a.type === AST_NODE_TYPES.ObjectExpression,
  ),
  O.exists(hasDiscriminantProperty),
);

const extractFirstIdentifierParam = flow(
  RA.head<TSESTree.Parameter>,
  O.filter((p): p is TSESTree.Identifier => p.type === AST_NODE_TYPES.Identifier),
  O.map((p) => p.name),
);

const isSpreadUpdateArrow = (fn: TSESTree.ArrowFunctionExpression) => {
  const { body } = fn;
  return (
    fn.params.length === 1 &&
    body.type === AST_NODE_TYPES.ObjectExpression &&
    O.exists((paramName: string) => isSpreadUpdateOf(body, paramName))(
      extractFirstIdentifierParam(fn.params),
    )
  );
};

const isSpreadUpdateCallback = flow(
  O.filter(
    (a: TSESTree.CallExpressionArgument): a is TSESTree.ArrowFunctionExpression =>
      a.type === AST_NODE_TYPES.ArrowFunctionExpression,
  ),
  O.exists(isSpreadUpdateArrow),
);

const isIdentityArrowFor = (fn: TSESTree.ArrowFunctionExpression, targetName: string) =>
  fn.body.type === AST_NODE_TYPES.Identifier &&
  (fn.body.name === targetName ||
    (fn.params.length === 1 && isIdentifierNamed(fn.body.name, fn.params[0])));

const isIdentityFallbackCallback = (
  arg: O.Option<TSESTree.CallExpressionArgument>,
  targetName: string,
) =>
  O.exists((fn: TSESTree.ArrowFunctionExpression) => isIdentityArrowFor(fn, targetName))(
    O.filter(
      (a: TSESTree.CallExpressionArgument): a is TSESTree.ArrowFunctionExpression =>
        a.type === AST_NODE_TYPES.ArrowFunctionExpression,
    )(arg),
  );

const extractFirstIdentifierName = flow(
  RA.head<TSESTree.CallExpressionArgument>,
  O.filter((a): a is TSESTree.Identifier => a.type === AST_NODE_TYPES.Identifier),
  O.map((a) => a.name),
);

const extractMatchSubjectName = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.CallExpression &&
  expr.callee.type === AST_NODE_TYPES.Identifier &&
  MATCH_CALLEES.has(expr.callee.name)
    ? extractFirstIdentifierName(expr.arguments)
    : O.none;

const extractMethodCallObject =
  (allowedMethods: ReadonlySet<string>) => (callee: TSESTree.Expression) =>
    callee.type === AST_NODE_TYPES.MemberExpression &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    allowedMethods.has(callee.property.name)
      ? O.some(callee.object)
      : O.none;

const extractMatchTargetFromWith = (withCall: TSESTree.CallExpression) =>
  isDiscriminantPatternArg(O.fromNullable(withCall.arguments[0])) &&
  isSpreadUpdateCallback(O.fromNullable(withCall.arguments[1]))
    ? O.flatMap(extractMatchSubjectName)(extractMethodCallObject(WITH_METHODS)(withCall.callee))
    : O.none;

const isIdentityFallbackForCall = (node: TSESTree.CallExpression, targetName: string) =>
  isIdentityFallbackCallback(O.fromNullable(node.arguments[0]), targetName);

const extractWithCallFromOtherwise = flow(
  extractMethodCallObject(OTHERWISE_METHODS),
  O.filter((obj): obj is TSESTree.CallExpression => obj.type === AST_NODE_TYPES.CallExpression),
  O.flatMap(extractMatchTargetFromWith),
);

const isSingleVariantGuardedMatch = (node: TSESTree.CallExpression) => {
  const check = flow(
    extractWithCallFromOtherwise,
    O.exists((targetName) => isIdentityFallbackForCall(node, targetName)),
  );
  return check(node.callee);
};

const checkTernaryNode = (node: TSESTree.ConditionalExpression, report: () => void) => {
  const check = flow(
    extractTernaryGuardedTarget,
    O.filter((targetName) => isVariantGuardOn({ expr: node.test, targetName })),
    O.map(report),
  );
  check(node);
};

const checkCallNode = (node: TSESTree.CallExpression, report: () => void) => {
  O.map(report)(O.fromPredicate(isSingleVariantGuardedMatch)(node));
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
