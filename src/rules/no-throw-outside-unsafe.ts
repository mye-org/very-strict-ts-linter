import { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";
import { isInsideUnsafeOrMustFunction } from "../utils/type-helpers.js";

type MessageIds = "noThrow";

export const noThrowOutsideUnsafe = createRule<[], MessageIds>({
  name: "no-throw-outside-unsafe",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `throw` statements outside of functions named `*Unsafe` or `must*`.",
    },
    messages: {
      noThrow:
        "Avoid `throw` in pure logic. Return `Either`/`Option` or wrap the `throw` in a `*Unsafe` / `must*` helper.",
    },
    schema: [],
  },
  defaultOptions: [],
  create: (context) => ({
    ThrowStatement: (node: TSESTree.ThrowStatement) => {
      if (!isInsideUnsafeOrMustFunction(node)) {
        context.report({ node, messageId: "noThrow" });
      }
    },
  }),
});
