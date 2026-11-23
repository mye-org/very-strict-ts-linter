import { TSESTree } from "@typescript-eslint/utils";
import { match } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";
import { isInsideUnsafeOrMustFunction } from "../lib/unsafe-function-scope.js";

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
    defaultOptions: [],
  },
  create: (context) => ({
    ThrowStatement: (node: TSESTree.ThrowStatement) => {
      match(isInsideUnsafeOrMustFunction(node))
        .with(false, () => {
          context.report({ node, messageId: "noThrow" });
        })
        .with(true, () => {})
        .exhaustive();
    },
  }),
});
