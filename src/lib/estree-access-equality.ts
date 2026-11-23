import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";

const isSameMemberAccess = (l: TSESTree.MemberExpression, r: TSESTree.MemberExpression) =>
  !l.computed &&
  !r.computed &&
  l.property.type === AST_NODE_TYPES.Identifier &&
  r.property.type === AST_NODE_TYPES.Identifier &&
  l.property.name === r.property.name &&
  isSameEsTreeAccessExpr(l.object, r.object);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive ESTree access equality
export const isSameEsTreeAccessExpr = (a: TSESTree.Expression, b: TSESTree.Expression): boolean =>
  (a.type === AST_NODE_TYPES.Identifier &&
    b.type === AST_NODE_TYPES.Identifier &&
    a.name === b.name) ||
  (a.type === AST_NODE_TYPES.MemberExpression &&
    b.type === AST_NODE_TYPES.MemberExpression &&
    isSameMemberAccess(a, b));
