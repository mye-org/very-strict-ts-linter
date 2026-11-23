import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";

const NEWTYPE_NAMES: ReadonlySet<string> = new Set(["Newtype"]);

const isNewtypeIdentifier = (typeName: TSESTree.EntityName) =>
  (typeName.type === AST_NODE_TYPES.Identifier && NEWTYPE_NAMES.has(typeName.name)) ||
  (typeName.type === AST_NODE_TYPES.TSQualifiedName && NEWTYPE_NAMES.has(typeName.right.name));

const isNewtypeReference = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.TSTypeReference && isNewtypeIdentifier(node.typeName);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive ancestor walk
const hasNewtypeAncestor = (node: TSESTree.Node): boolean =>
  isNewtypeReference(node) || O.exists(hasNewtypeAncestor)(O.fromNullable(node.parent));

export const isInsideNewtypeDefinition = flow(
  (node: TSESTree.Node) => node.parent,
  O.fromNullable,
  O.exists(hasNewtypeAncestor),
);
