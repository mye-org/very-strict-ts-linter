import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESTree } from "@typescript-eslint/utils";
import { pipe } from "fp-ts/lib/function.js";
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

const isArrayTypeCall = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
  checker: ReturnType<ParserServicesWithTypeInformation["program"]["getTypeChecker"]>,
) =>
  pipe(
    services.esTreeNodeToTSNodeMap.get(node.callee.type === AST_NODE_TYPES.MemberExpression ? node.callee.object : node),
    (tsNode) => checker.getTypeAtLocation(tsNode),
    (type) => isArrayLikeType(type, checker),
  );

const isBannedArrayCall = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) =>
  node.callee.type === AST_NODE_TYPES.MemberExpression &&
  node.callee.property.type === AST_NODE_TYPES.Identifier &&
  BANNED_ARRAY_METHODS.has(node.callee.property.name) &&
  isArrayTypeCall(node, services, services.program.getTypeChecker());

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
    defaultOptions: [],
  },
  create: (context) => ({
    CallExpression: (node) => {
      if (
        isBannedArrayCall(node, ESLintUtils.getParserServices(context)) &&
        node.callee.type === AST_NODE_TYPES.MemberExpression &&
        node.callee.property.type === AST_NODE_TYPES.Identifier
      ) {
        context.report({
          node: node.callee.property,
          messageId: "preferFpTsArray",
          data: { method: node.callee.property.name },
        });
      }
    },
  }),
});
