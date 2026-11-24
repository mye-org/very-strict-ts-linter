import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { match, P } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";

type MessageIds =
  | "noNullType"
  | "noUndefinedType"
  | "noNullLiteral"
  | "noOptionalProperty"
  | "noOptionalChaining"
  | "noNullishCheck";

const EQUALITY_OPERATORS: ReadonlySet<string> = new Set(["===", "!==", "==", "!="]);
const UNDEFINED_NAMES: ReadonlySet<string> = new Set(["undefined"]);

const isEqualityParent = (parent: TSESTree.Node) =>
  parent.type === AST_NODE_TYPES.BinaryExpression &&
  EQUALITY_OPERATORS.has(parent.operator);

const isNullLiteralNode = (node: TSESTree.Expression | TSESTree.PrivateIdentifier) =>
  node.type === AST_NODE_TYPES.Literal && node.raw === "null";

const isUndefinedIdentifier = (node: TSESTree.Expression | TSESTree.PrivateIdentifier) =>
  match(node)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => UNDEFINED_NAMES.has(id.name))
    .with(P._, () => false)
    .exhaustive();

const isVoidExpr = (node: TSESTree.Expression | TSESTree.PrivateIdentifier) =>
  match(node)
    .with({ type: AST_NODE_TYPES.UnaryExpression, operator: "void" }, () => true)
    .with(P._, () => false)
    .exhaustive();

const isTypeofExpr = (node: TSESTree.Expression | TSESTree.PrivateIdentifier) =>
  match(node)
    .with({ type: AST_NODE_TYPES.UnaryExpression, operator: "typeof" }, () => true)
    .with(P._, () => false)
    .exhaustive();

const isUndefinedStringLiteral = (node: TSESTree.Expression | TSESTree.PrivateIdentifier) =>
  node.type === AST_NODE_TYPES.Literal && node.value === "undefined";

const isNullishOperand = (node: TSESTree.Expression | TSESTree.PrivateIdentifier) =>
  isNullLiteralNode(node) || isUndefinedIdentifier(node) || isVoidExpr(node);

const isTypeofUndefinedPair = (
  left: TSESTree.Expression | TSESTree.PrivateIdentifier,
  right: TSESTree.Expression | TSESTree.PrivateIdentifier,
) =>
  (isTypeofExpr(left) && isUndefinedStringLiteral(right)) ||
  (isTypeofExpr(right) && isUndefinedStringLiteral(left));

const isNullishBinaryCheck = (node: TSESTree.BinaryExpression) =>
  EQUALITY_OPERATORS.has(node.operator) &&
  (isNullishOperand(node.left) ||
    isNullishOperand(node.right) ||
    isTypeofUndefinedPair(node.left, node.right));

const checkOptionalProperty = (
  node: TSESTree.TSPropertySignature,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  match(node)
    .with({ optional: true }, (matched) => { report({ node: matched, messageId: "noOptionalProperty" }); })
    .with({ optional: false }, () => {})
    .exhaustive();
};

const checkNullLiteral = (
  node: TSESTree.Literal,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  match({
    raw: node.raw,
    parentType: node.parent.type,
    inEquality: isEqualityParent(node.parent),
  })
    .with(
      { raw: "null", parentType: P.not(AST_NODE_TYPES.TSLiteralType), inEquality: false },
      () => { report({ node, messageId: "noNullLiteral" }); },
    )
    .otherwise(() => {});
};

const checkOptionalAccess = (
  node: TSESTree.MemberExpression | TSESTree.CallExpression,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  match(node)
    .with({ optional: true }, (matched) => { report({ node: matched, messageId: "noOptionalChaining" }); })
    .with({ optional: false }, () => {})
    .exhaustive();
};

const checkBinaryExpression = (
  node: TSESTree.BinaryExpression,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  match(isNullishBinaryCheck(node))
    .with(true, () => { report({ node, messageId: "noNullishCheck" }); })
    .with(false, () => {})
    .exhaustive();
};

const checkNullishLogical = (
  node: TSESTree.LogicalExpression,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  match(node)
    .with({ operator: "??" }, (matched) => { report({ node: matched, messageId: "noNullishCheck" }); })
    .with({ operator: P.union("&&", "||") }, () => {})
    .exhaustive();
};

const checkNullishAssignment = (
  node: TSESTree.AssignmentExpression,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  match(node.operator === "??=")
    .with(true, () => { report({ node, messageId: "noNullishCheck" }); })
    .with(false, () => {})
    .exhaustive();
};

export const noNullUndefined = createRule<[], MessageIds>({
  name: "no-null-undefined",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow null, undefined, optional chaining, and nullish checks; use fp-ts Option or monocle-ts optics instead.",
    },
    messages: {
      noNullType:
        "Avoid `null` in types. Use `Option<A>` from `fp-ts` instead.",
      noUndefinedType:
        "Avoid `undefined` in types. Use `Option<A>` from `fp-ts` instead.",
      noNullLiteral:
        "Avoid `null` literals. Use `O.none` from `fp-ts/lib/Option` instead.",
      noOptionalProperty:
        "Avoid optional properties (`?:`). Use `Option<A>` from `fp-ts` instead.",
      noOptionalChaining:
        "Avoid optional chaining (`?.`). Consider refactoring to use `fp-ts` `Option` or `monocle-ts` optics instead.",
      noNullishCheck:
        "Avoid `null` or `undefined` checks. Consider refactoring to use `fp-ts` `Option` or `monocle-ts` optics instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    TSNullKeyword: (node) => { context.report({ node, messageId: "noNullType" }); },
    TSUndefinedKeyword: (node) => { context.report({ node, messageId: "noUndefinedType" }); },
    TSPropertySignature: (node) => { checkOptionalProperty(node, (d) => { context.report(d); }); },
    Literal: (node) => { checkNullLiteral(node, (d) => { context.report(d); }); },
    MemberExpression: (node) => { checkOptionalAccess(node, (d) => { context.report(d); }); },
    CallExpression: (node) => { checkOptionalAccess(node, (d) => { context.report(d); }); },
    BinaryExpression: (node) => { checkBinaryExpression(node, (d) => { context.report(d); }); },
    LogicalExpression: (node) => { checkNullishLogical(node, (d) => { context.report(d); }); },
    AssignmentExpression: (node) => { checkNullishAssignment(node, (d) => { context.report(d); }); },
  }),
});
