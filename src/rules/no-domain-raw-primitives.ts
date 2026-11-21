import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import { isInsideNewtypeDefinition } from "../utils/type-helpers.js";

type MessageIds = "rawStringOrNumber" | "rawBoolean";

const reportPrimitiveType = (
  typeNode: TSESTree.TypeNode,
  reportStringOrNumber: (node: TSESTree.Node, kind: string) => void,
  reportBoolean: (node: TSESTree.Node) => void,
) => {
  match(typeNode.type)
    .with(AST_NODE_TYPES.TSStringKeyword, () => { reportStringOrNumber(typeNode, "string"); })
    .with(AST_NODE_TYPES.TSNumberKeyword, () => { reportStringOrNumber(typeNode, "number"); })
    .with(AST_NODE_TYPES.TSBooleanKeyword, () => { reportBoolean(typeNode); })
    .with(P._, () => {})
    .exhaustive();
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
      pipe(
        O.fromNullable(node.typeAnnotation?.typeAnnotation),
        O.filter((typeNode) => !isInsideNewtypeDefinition(typeNode)),
        O.map((typeNode) => {
          reportPrimitiveType(
            typeNode,
            (n, kind) => { context.report({ node: n, messageId: "rawStringOrNumber", data: { kind } }); },
            (n) => { context.report({ node: n, messageId: "rawBoolean" }); },
          );
        }),
      );
    },
  }),
});
