import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";

export const isEsTreeAnonymousFunctionNode = ((node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
  node.type === AST_NODE_TYPES.FunctionExpression) satisfies (node: TSESTree.Node) => boolean;

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
