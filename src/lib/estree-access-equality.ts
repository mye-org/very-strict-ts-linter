import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as Pred from "fp-ts/lib/Predicate.js";

const isSameMemberAccess: (
  l: TSESTree.MemberExpression,
) => Pred.Predicate<TSESTree.MemberExpression> = (l) => {
  const isSameAsLeft = (r: TSESTree.MemberExpression) =>
    !l.computed &&
    !r.computed &&
    l.property.type === AST_NODE_TYPES.Identifier &&
    r.property.type === AST_NODE_TYPES.Identifier &&
    l.property.name === r.property.name &&
    isSameEsTreeAccessExpr(l.object)(r.object);
  return isSameAsLeft;
};

export const isSameEsTreeAccessExpr = ((a: TSESTree.Expression) => {
  const isSameAsFirst = (b: TSESTree.Expression) =>
    (a.type === AST_NODE_TYPES.Identifier &&
      b.type === AST_NODE_TYPES.Identifier &&
      a.name === b.name) ||
    (a.type === AST_NODE_TYPES.MemberExpression &&
      b.type === AST_NODE_TYPES.MemberExpression &&
      isSameMemberAccess(a)(b));
  return isSameAsFirst;
}) satisfies (a: TSESTree.Expression) => Pred.Predicate<TSESTree.Expression>;
