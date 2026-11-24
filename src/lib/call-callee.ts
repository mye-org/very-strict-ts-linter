import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";

const checkParentIsCall = (node: TSESTree.Node) =>
  flow(
    (n: TSESTree.Node) => n.parent,
    O.fromNullable,
    O.exists(
      (parent: TSESTree.Node) =>
        parent.type === AST_NODE_TYPES.CallExpression && parent.callee === node,
    ),
  );

export const isCalleeOfCallExpression = ((node: TSESTree.Node) =>
  checkParentIsCall(node)(node)) satisfies (node: TSESTree.Node) => boolean;
