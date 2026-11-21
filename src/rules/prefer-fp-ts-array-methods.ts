import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESTree } from "@typescript-eslint/utils";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
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

const checkArrayCall = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
  report: (prop: TSESTree.Identifier) => void,
) => {
  match({ callee: node.callee, isBanned: isBannedArrayCall(node, services) })
    .with(
      { isBanned: true, callee: { type: AST_NODE_TYPES.MemberExpression, property: { type: AST_NODE_TYPES.Identifier } } },
      ({ callee }) => { report(callee.property); },
    )
    .otherwise(() => {});
};

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
      checkArrayCall(node, ESLintUtils.getParserServices(context), (prop) => {
        context.report({ node: prop, messageId: "preferFpTsArray", data: { method: prop.name } });
      });
    },
  }),
});
