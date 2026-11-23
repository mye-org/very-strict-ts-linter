import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";

const PIPE_CALL_NAMES: ReadonlySet<string> = new Set(["pipe"]);

export const isPipeCallExpression = (node: TSESTree.CallExpression): boolean =>
  node.callee.type === AST_NODE_TYPES.Identifier && PIPE_CALL_NAMES.has(node.callee.name);
