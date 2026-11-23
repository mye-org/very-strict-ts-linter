import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";

export const isEsTreeAnonymousFunctionNode = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
  node.type === AST_NODE_TYPES.FunctionExpression;

export const isEsTreeFunctionNode = (
  node: TSESTree.Node,
): node is
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression =>
  node.type === AST_NODE_TYPES.FunctionDeclaration || isEsTreeAnonymousFunctionNode(node);

export const hasFunctionInit = flow(
  (declarator: TSESTree.VariableDeclarator) => declarator.init,
  O.fromNullable,
  O.exists(isEsTreeAnonymousFunctionNode),
);

type EsTreeFunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive parent walk
export const resolveEnclosingEsTreeFunction = (node: TSESTree.Node): O.Option<EsTreeFunctionNode> =>
  flow(
    (n: TSESTree.Node) => n.parent,
    O.fromNullable,
    O.flatMap((parent) =>
      isEsTreeFunctionNode(parent) ? O.some(parent) : resolveEnclosingEsTreeFunction(parent),
    ),
  )(node);
