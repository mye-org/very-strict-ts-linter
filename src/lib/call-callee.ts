import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";

export const isCalleeOfCallExpression = (node: TSESTree.Node) =>
  node.parent?.type === AST_NODE_TYPES.CallExpression && node.parent.callee === node;
