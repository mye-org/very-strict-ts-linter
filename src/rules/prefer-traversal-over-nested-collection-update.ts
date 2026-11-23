import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { isSameEsTreeAccessExpr } from "../lib/estree-access-equality.js";
import { isFlowCallExpression } from "../lib/flow-call.js";
import { isPipeCallExpression } from "../lib/pipe-call.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "preferTraversal";
type TargetProp = Readonly<
  Record<"propName", string> & {
    readonly outerTarget: TSESTree.Expression;
  }
>;

const COLLECTION_NAMESPACES: ReadonlySet<string> = new Set(["RA", "A", "RNEA", "RR", "R"]);
const MAP_METHODS: ReadonlySet<string> = new Set(["map"]);

const extractSpreadTarget = flow(
  (node: TSESTree.ObjectExpression) => node.properties,
  RA.findFirst(
    (p: TSESTree.ObjectLiteralElement): p is TSESTree.SpreadElement =>
      p.type === AST_NODE_TYPES.SpreadElement,
  ),
  O.map((spread) => spread.argument),
);

const isTargetPropAccess = (
  expr: O.Option<TSESTree.CallExpressionArgument>,
  target: TargetProp,
) =>
  O.exists(
    (e: TSESTree.CallExpressionArgument) =>
      e.type === AST_NODE_TYPES.MemberExpression &&
      !e.computed &&
      e.property.type === AST_NODE_TYPES.Identifier &&
      e.property.name === target.propName &&
      isSameEsTreeAccessExpr(e.object, target.outerTarget),
  )(expr);

const resolveFirstParamName = flow(
  RA.head<TSESTree.Parameter>,
  O.filter((p): p is TSESTree.Identifier => p.type === AST_NODE_TYPES.Identifier),
  O.map((p) => p.name),
);

const isSpreadOfParam = (prop: TSESTree.ObjectLiteralElement, paramName: string) =>
  prop.type === AST_NODE_TYPES.SpreadElement &&
  prop.argument.type === AST_NODE_TYPES.Identifier &&
  prop.argument.name === paramName;

const isSpreadObjectUpdate = (body: TSESTree.Node, paramName: string) =>
  body.type === AST_NODE_TYPES.ObjectExpression &&
  body.properties.length >= 2 &&
  RA.some((p: TSESTree.ObjectLiteralElement) => isSpreadOfParam(p, paramName))(body.properties);

const isSpreadUpdateArrow = (fn: TSESTree.ArrowFunctionExpression) => {
  const check = flow(
    resolveFirstParamName,
    O.exists((paramName) => isSpreadObjectUpdate(fn.body, paramName)),
  );
  return check(fn.params);
};

const isSpreadUpdateMapper = flow(
  O.filter(
    (a: TSESTree.CallExpressionArgument): a is TSESTree.ArrowFunctionExpression =>
      a.type === AST_NODE_TYPES.ArrowFunctionExpression,
  ),
  O.exists(isSpreadUpdateArrow),
);

const isCollectionMapCallee = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.MemberExpression &&
  !callee.computed &&
  callee.object.type === AST_NODE_TYPES.Identifier &&
  COLLECTION_NAMESPACES.has(callee.object.name) &&
  callee.property.type === AST_NODE_TYPES.Identifier &&
  MAP_METHODS.has(callee.property.name);

const isCollectionMapStep = (step: TSESTree.CallExpressionArgument) =>
  step.type === AST_NODE_TYPES.CallExpression &&
  isCollectionMapCallee(step.callee) &&
  isSpreadUpdateMapper(O.fromNullable(step.arguments[0]));

const dropFirstArg = (args: ReadonlyArray<TSESTree.CallExpressionArgument>) =>
  RA.dropLeft(1)(args);

const everyRestArgIsMapStep = flow(dropFirstArg, RA.every(isCollectionMapStep));

const isPipeCollectionUpdate = (call: TSESTree.CallExpression, target: TargetProp) =>
  isPipeCallExpression(call) &&
  call.arguments.length >= 2 &&
  isTargetPropAccess(O.fromNullable(call.arguments[0]), target) &&
  everyRestArgIsMapStep(call.arguments);

const isFlowMapCallee = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.CallExpression &&
  isFlowCallExpression(callee) &&
  callee.arguments.length >= 1 &&
  RA.every(isCollectionMapStep)(callee.arguments);

const isFlowCollectionUpdate = (call: TSESTree.CallExpression, target: TargetProp) =>
  isFlowMapCallee(call.callee) && isTargetPropAccess(O.fromNullable(call.arguments[0]), target);

const isCurriedCollectionUpdate = (call: TSESTree.CallExpression, target: TargetProp) =>
  call.callee.type === AST_NODE_TYPES.CallExpression &&
  isCollectionMapStep(call.callee) &&
  isTargetPropAccess(O.fromNullable(call.arguments[0]), target);

const isTargetMapMember = (callee: TSESTree.Expression, target: TargetProp) =>
  callee.type === AST_NODE_TYPES.MemberExpression &&
  !callee.computed &&
  callee.property.type === AST_NODE_TYPES.Identifier &&
  MAP_METHODS.has(callee.property.name) &&
  isTargetPropAccess(O.some(callee.object), target);

const isMethodCollectionUpdate = (call: TSESTree.CallExpression, target: TargetProp) =>
  isTargetMapMember(call.callee, target) && isSpreadUpdateMapper(O.fromNullable(call.arguments[0]));

const isNestedCollectionUpdateProp = (
  prop: TSESTree.ObjectLiteralElement,
  outerTarget: TSESTree.Expression,
) =>
  prop.type === AST_NODE_TYPES.Property &&
  !prop.computed &&
  prop.key.type === AST_NODE_TYPES.Identifier &&
  prop.value.type === AST_NODE_TYPES.CallExpression &&
  (isPipeCollectionUpdate(prop.value, { outerTarget, propName: prop.key.name }) ||
    isFlowCollectionUpdate(prop.value, { outerTarget, propName: prop.key.name }) ||
    isCurriedCollectionUpdate(prop.value, { outerTarget, propName: prop.key.name }) ||
    isMethodCollectionUpdate(prop.value, { outerTarget, propName: prop.key.name }));

const hasNestedCollectionUpdate = (
  properties: ReadonlyArray<TSESTree.ObjectLiteralElement>,
  outerTarget: TSESTree.Expression,
) => RA.some((p: TSESTree.ObjectLiteralElement) => isNestedCollectionUpdateProp(p, outerTarget))(properties);

export const preferTraversalOverNestedCollectionUpdate = createRule<[], MessageIds>({
  name: "prefer-traversal-over-nested-collection-update",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer `monocle-ts` `Traversal` (`L.traverse`) over immutable object spreads that map-and-spread elements of a nested collection.",
    },
    messages: {
      preferTraversal:
        "Nested collection spread-update inside an object spread. Use a `monocle-ts` `Traversal` (`flow(L.id<S>(), L.prop(...), L.traverse(RA.Traversable))`) to update nested collection elements declaratively.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    ObjectExpression: (node) => {
      const check = flow(
        extractSpreadTarget,
        O.filter((outerTarget) => hasNestedCollectionUpdate(node.properties, outerTarget)),
        O.map(() => {
          context.report({ node, messageId: "preferTraversal" });
        }),
      );
      check(node);
    },
  }),
});
