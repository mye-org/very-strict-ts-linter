import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { createRule } from "../utils/create-rule.js";
import { isPipeCallExpression, isSameEsTreeAccessExpr } from "../utils/type-helpers.js";

type MessageIds = "preferTraversal";
type TargetProp = Readonly<
  Record<"propName", string> & {
    readonly outerTarget: TSESTree.Expression;
  }
>;

const COLLECTION_NAMESPACES = new Set(["RA", "A", "RNEA", "RR", "R"]);

const getSpreadTarget = (node: TSESTree.ObjectExpression) =>
  pipe(
    node.properties,
    RA.findFirst(
      (p): p is TSESTree.SpreadElement => p.type === AST_NODE_TYPES.SpreadElement,
    ),
    O.map((spread) => spread.argument),
  );

const isTargetPropAccess = (
  expr: O.Option<TSESTree.CallExpressionArgument>,
  target: TargetProp,
) =>
  pipe(
    expr,
    O.exists(
      (e) =>
        e.type === AST_NODE_TYPES.MemberExpression &&
        !e.computed &&
        e.property.type === AST_NODE_TYPES.Identifier &&
        e.property.name === target.propName &&
        isSameEsTreeAccessExpr(e.object, target.outerTarget),
    ),
  );

const isSpreadUpdateArrow = (fn: TSESTree.ArrowFunctionExpression) =>
  fn.params.length >= 1 &&
  fn.params[0]?.type === AST_NODE_TYPES.Identifier &&
  fn.body.type === AST_NODE_TYPES.ObjectExpression &&
  pipe(
    fn.body.properties,
    RA.some(
      (p) =>
        p.type === AST_NODE_TYPES.SpreadElement &&
        p.argument.type === AST_NODE_TYPES.Identifier &&
        fn.params[0]?.type === AST_NODE_TYPES.Identifier &&
        p.argument.name === fn.params[0].name,
    ),
  );

const isSpreadUpdateMapper = (arg: O.Option<TSESTree.CallExpressionArgument>) =>
  pipe(
    arg,
    O.filter(
      (a): a is TSESTree.ArrowFunctionExpression =>
        a.type === AST_NODE_TYPES.ArrowFunctionExpression,
    ),
    O.exists(isSpreadUpdateArrow),
  );

const isCollectionMapStep = (step: TSESTree.CallExpressionArgument) =>
  step.type === AST_NODE_TYPES.CallExpression &&
  step.callee.type === AST_NODE_TYPES.MemberExpression &&
  step.callee.object.type === AST_NODE_TYPES.Identifier &&
  COLLECTION_NAMESPACES.has(step.callee.object.name) &&
  step.callee.property.type === AST_NODE_TYPES.Identifier &&
  step.callee.property.name === "map" &&
  isSpreadUpdateMapper(O.fromNullable(step.arguments[0]));

const isPipeCollectionUpdate = (call: TSESTree.CallExpression, target: TargetProp) =>
  isPipeCallExpression(call) &&
  isTargetPropAccess(O.fromNullable(call.arguments[0]), target) &&
  pipe(call.arguments.slice(1), RA.some(isCollectionMapStep));

const isCurriedCollectionUpdate = (call: TSESTree.CallExpression, target: TargetProp) =>
  call.callee.type === AST_NODE_TYPES.CallExpression &&
  isCollectionMapStep(call.callee) &&
  isTargetPropAccess(O.fromNullable(call.arguments[0]), target);

const isMethodCollectionUpdate = (call: TSESTree.CallExpression, target: TargetProp) =>
  call.callee.type === AST_NODE_TYPES.MemberExpression &&
  call.callee.property.type === AST_NODE_TYPES.Identifier &&
  call.callee.property.name === "map" &&
  isTargetPropAccess(O.some(call.callee.object), target) &&
  isSpreadUpdateMapper(O.fromNullable(call.arguments[0]));

const isNestedCollectionUpdateProp = (
  prop: TSESTree.ObjectLiteralElement,
  outerTarget: TSESTree.Expression,
) =>
  prop.type === AST_NODE_TYPES.Property &&
  !prop.computed &&
  prop.key.type === AST_NODE_TYPES.Identifier &&
  prop.value.type === AST_NODE_TYPES.CallExpression &&
  (isPipeCollectionUpdate(prop.value, { outerTarget, propName: prop.key.name }) ||
    isCurriedCollectionUpdate(prop.value, { outerTarget, propName: prop.key.name }) ||
    isMethodCollectionUpdate(prop.value, { outerTarget, propName: prop.key.name }));

const hasNestedCollectionUpdate = (
  properties: ReadonlyArray<TSESTree.ObjectLiteralElement>,
  outerTarget: TSESTree.Expression,
) => pipe(properties, RA.some((p) => isNestedCollectionUpdateProp(p, outerTarget)));

export const preferTraversalOverNestedCollectionUpdate = createRule<[], MessageIds>({
  name: "prefer-traversal-over-nested-collection-update",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer `monocle-ts` `Traversal` (`fromTraversable`) over immutable object spreads that map-and-spread elements of a nested collection.",
    },
    messages: {
      preferTraversal:
        "Nested collection spread-update inside an object spread. Use a `monocle-ts` `Traversal` (`Lens.fromProp` + `fromTraversable`) to update nested collection elements declaratively.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    ObjectExpression: (node) => {
      pipe(
        getSpreadTarget(node),
        O.filter((outerTarget) => hasNestedCollectionUpdate(node.properties, outerTarget)),
        O.map(() => {
          context.report({ node, messageId: "preferTraversal" });
        }),
      );
    },
  }),
});
