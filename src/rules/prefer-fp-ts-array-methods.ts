import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESTree } from "@typescript-eslint/utils";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import { isArrayLikeType } from "../utils/type-helpers.js";

type MessageIds = "preferFpTsArray";

const ARRAY_METHOD_REPLACEMENTS: Readonly<Record<string, string>> = {
  map: "RA.map",
  filter: "RA.filter",
  reduce: "RA.reduce",
  reduceRight: "RA.reduceRight",
  forEach: "RA.map / IO",
  find: "RA.findFirst",
  findIndex: "RA.findIndex",
  some: "RA.some",
  every: "RA.every",
  flatMap: "RA.flatMap",
  flat: "RA.flatten",
  sort: "RA.sort",
  reverse: "RA.reverse",
  push: "RA.append",
  pop: "RA.init",
  shift: "RA.tail",
  unshift: "RA.prepend",
  splice: "RA.modifyAt / RA.deleteAt",
};

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
  !node.callee.computed &&
  node.callee.property.type === AST_NODE_TYPES.Identifier &&
  Object.prototype.hasOwnProperty.call(ARRAY_METHOD_REPLACEMENTS, node.callee.property.name) &&
  isArrayTypeCall(node, services, services.program.getTypeChecker());

const checkArrayCall = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
  report: (prop: TSESTree.Identifier) => void,
) => {
  match({ callee: node.callee, isBanned: isBannedArrayCall(node, services) })
    .with(
      {
        isBanned: true,
        callee: {
          type: AST_NODE_TYPES.MemberExpression,
          computed: false,
          property: { type: AST_NODE_TYPES.Identifier },
        },
      },
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
        "Use `{{replacement}}` (or `flow(..., {{replacement}}(...))`) from `fp-ts/lib/ReadonlyArray` instead of native `.{{method}}()`.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const services = ESLintUtils.getParserServices(context);
    return {
      CallExpression: (node) => {
        checkArrayCall(node, services, (prop) => {
          context.report({
            node: prop,
            messageId: "preferFpTsArray",
            data: {
              method: prop.name,
              replacement: ARRAY_METHOD_REPLACEMENTS[prop.name] ?? `RA.${prop.name}`,
            },
          });
        });
      },
    };
  },
});
