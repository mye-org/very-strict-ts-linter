import { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "noAny" | "noUnknown";

export const noAnyOrUnknown = createRule<[], MessageIds>({
  name: "no-any-or-unknown",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `any` and `unknown`; prefer generic constraints or explicit union types.",
    },
    messages: {
      noAny: "Avoid `any`. Use generic constraints or explicit union types.",
      noUnknown:
        "Avoid `unknown`. Use generic constraints or explicit union types.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    TSAnyKeyword: (node: TSESTree.TSAnyKeyword) => {
      context.report({ node, messageId: "noAny" });
    },
    TSUnknownKeyword: (node: TSESTree.TSUnknownKeyword) => {
      context.report({ node, messageId: "noUnknown" });
    },
  }),
});
