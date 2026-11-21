import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { match, P } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "noNullType" | "noUndefinedType" | "noNullLiteral" | "noOptionalProperty";

const checkOptionalProperty = (
  node: TSESTree.TSPropertySignature,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  match(node.optional)
    .with(true, () => { report({ node, messageId: "noOptionalProperty" }); })
    .with(false, () => {})
    .exhaustive();
};

const checkNullLiteral = (
  node: TSESTree.Literal,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  match({ raw: node.raw, parentType: node.parent.type })
    .with({ raw: "null", parentType: P.not(AST_NODE_TYPES.TSLiteralType) }, () => {
      report({ node, messageId: "noNullLiteral" });
    })
    .otherwise(() => {});
};

export const noNullUndefined = createRule<[], MessageIds>({
  name: "no-null-undefined",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow null and undefined in types and values; use Option<A> from fp-ts instead.",
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
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    TSNullKeyword: (node) => { context.report({ node, messageId: "noNullType" }); },
    TSUndefinedKeyword: (node) => { context.report({ node, messageId: "noUndefinedType" }); },
    TSPropertySignature: (node) => { checkOptionalProperty(node, (d) => { context.report(d); }); },
    Literal: (node) => { checkNullLiteral(node, (d) => { context.report(d); }); },
  }),
});
