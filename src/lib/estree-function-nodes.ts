import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import { flow } from "fp-ts/lib/function.js";

const isArrowFunctionNode = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.ArrowFunctionExpression;

const isFunctionExprNode = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.FunctionExpression;

export const isEsTreeAnonymousFunctionNode = Pred.or(isArrowFunctionNode)(
  isFunctionExprNode,
) satisfies (node: TSESTree.Node) => boolean;

export const isEsTreeFunctionNode = ((node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.FunctionDeclaration ||
  isEsTreeAnonymousFunctionNode(node)) satisfies (
  node: TSESTree.Node,
) => node is
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

export const hasFunctionInit = flow(
  (declarator: TSESTree.VariableDeclarator) => declarator.init,
  O.fromNullable,
  O.exists(isEsTreeAnonymousFunctionNode),
);

type EsTreeFunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

const resolveParentEnclosingFunction: (node: TSESTree.Node) => O.Option<EsTreeFunctionNode> =
  flow(
    (node: TSESTree.Node) => node.parent,
    O.fromNullable,
    O.flatMap((parent) =>
      isEsTreeFunctionNode(parent) ? O.some(parent) : resolveEnclosingEsTreeFunction(parent),
    ),
  );

export const resolveEnclosingEsTreeFunction = resolveParentEnclosingFunction satisfies (
  node: TSESTree.Node,
) => O.Option<EsTreeFunctionNode>;
