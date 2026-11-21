import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { match } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import { isInsideNewtypeDefinition } from "../utils/type-helpers.js";

type MessageIds = "rawStringOrNumber" | "rawBoolean";

export const noDomainRawPrimitives = createRule<[], MessageIds>({
  name: "no-domain-raw-primitives",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw string, number, and boolean in domain object properties; require branded newtypes and discriminated unions.",
    },
    messages: {
      rawStringOrNumber:
        "Avoid raw `{{kind}}` in domain properties. Use a branded Newtype from `newtype-ts` instead.",
      rawBoolean:
        "Avoid `boolean` in domain properties. Model states as a discriminated union (e.g. `{ kind: \"a\" } | { kind: \"b\" }`).",
    },
    schema: [],
  },
  defaultOptions: [],
  create: (context) => ({
    TSPropertySignature: (node: TSESTree.TSPropertySignature) => {
      const typeNode = node.typeAnnotation?.typeAnnotation;
      if (!typeNode || isInsideNewtypeDefinition(typeNode)) {
        return;
      }

      match(typeNode.type)
        .with(AST_NODE_TYPES.TSStringKeyword, () => {
          context.report({
            node: typeNode,
            messageId: "rawStringOrNumber",
            data: { kind: "string" },
          });
        })
        .with(AST_NODE_TYPES.TSNumberKeyword, () => {
          context.report({
            node: typeNode,
            messageId: "rawStringOrNumber",
            data: { kind: "number" },
          });
        })
        .with(AST_NODE_TYPES.TSBooleanKeyword, () => {
          context.report({
            node: typeNode,
            messageId: "rawBoolean",
          });
        })
        .otherwise(() => undefined);
    },
  }),
});
