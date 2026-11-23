import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";

export const isMemberAssignment = (
  node: TSESTree.Node,
): node is TSESTree.AssignmentExpression & { readonly left: TSESTree.MemberExpression } =>
  node.type === AST_NODE_TYPES.AssignmentExpression &&
  node.left.type === AST_NODE_TYPES.MemberExpression;
