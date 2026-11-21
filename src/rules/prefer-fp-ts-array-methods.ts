import { AST_NODE_TYPES, ESLintUtils, TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";
import { isArrayLikeType } from "../utils/type-helpers.js";

type MessageIds = "preferFpTsArray";

const BANNED_ARRAY_METHODS = new Set([
  "map",
  "filter",
  "reduce",
  "reduceRight",
  "forEach",
  "find",
  "findIndex",
  "some",
  "every",
  "flatMap",
  "flat",
  "sort",
  "reverse",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
]);

export const preferFpTsArrayMethods = createRule<[], MessageIds>({
  name: "prefer-fp-ts-array-methods",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer `fp-ts/lib/ReadonlyArray` (`RA.*`) functions over native `Array.prototype` methods.",
    },
    messages: {
      preferFpTsArray:
        "Use `RA.{{method}}` (or `pipe(..., RA.{{method}}(...))`) from `fp-ts/lib/ReadonlyArray` instead of native `.{{method}}()`.",
    },
    schema: [],
  },
  defaultOptions: [],
  create: (context) => {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    return {
      CallExpression: (node: TSESTree.CallExpression) => {
        if (
          node.callee.type !== AST_NODE_TYPES.MemberExpression ||
          node.callee.property.type !== AST_NODE_TYPES.Identifier
        ) {
          return;
        }
        const methodName = node.callee.property.name;
        if (!BANNED_ARRAY_METHODS.has(methodName)) {
          return;
        }

        const tsObject = services.esTreeNodeToTSNodeMap.get(node.callee.object);
        const objectType = checker.getTypeAtLocation(tsObject);
        if (isArrayLikeType(objectType, checker)) {
          context.report({
            node: node.callee.property,
            messageId: "preferFpTsArray",
            data: { method: methodName },
          });
        }
      },
    };
  },
});
