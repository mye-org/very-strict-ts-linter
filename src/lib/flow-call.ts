import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";

const FLOW_CALL_NAMES: ReadonlySet<string> = new Set(["flow"]);

export const isFlowCallExpression = ((node: TSESTree.CallExpression) =>
  node.callee.type === AST_NODE_TYPES.Identifier && FLOW_CALL_NAMES.has(node.callee.name)) satisfies (
  node: TSESTree.CallExpression,
) => boolean;
