import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";
import { isInsideNewtypeDefinition } from "../utils/type-helpers.js";

type MessageIds = "rawStringOrNumber" | "rawBoolean";

const reportPrimitiveType = (
  typeNode: TSESTree.TypeNode,
  reportStringOrNumber: (node: TSESTree.Node, kind: string) => void,
  reportBoolean: (node: TSESTree.Node) => void,
) => {
  if (typeNode.type === AST_NODE_TYPES.TSStringKeyword) {
    reportStringOrNumber(typeNode, "string");
    return;
  }
  if (typeNode.type === AST_NODE_TYPES.TSNumberKeyword) {
    reportStringOrNumber(typeNode, "number");
    return;
  }
  if (typeNode.type === AST_NODE_TYPES.TSBooleanKeyword) {
    reportBoolean(typeNode);
  }
};

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
    defaultOptions: [],
  },
  create: (context) => ({
    TSPropertySignature: (node) => {
      const typeNode = node.typeAnnotation?.typeAnnotation;
      if (typeNode && !isInsideNewtypeDefinition(typeNode)) {
        reportPrimitiveType(
          typeNode,
          (n, kind) => { context.report({ node: n, messageId: "rawStringOrNumber", data: { kind } }); },
          (n) => { context.report({ node: n, messageId: "rawBoolean" }); },
        );
      }
    },
  }),
});
