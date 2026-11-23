import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../lib/rule-factory.js";

const ARRAY_SYMBOL_NAMES: ReadonlySet<string> = new Set(["Array", "ReadonlyArray"]);

const isArraySymbol = (type: ts.Type) =>
  ARRAY_SYMBOL_NAMES.has(type.getSymbol()?.name ?? "");

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive union check
const isArrayLikeType = (type: ts.Type, checker: ts.TypeChecker): boolean =>
  match({
    isArrayOrTuple: checker.isArrayType(type) || checker.isTupleType(type),
    isUnion: type.isUnion(),
  })
    .with({ isArrayOrTuple: true }, () => true)
    .with({ isUnion: true }, () => type.isUnion() && RA.every((t: ts.Type) => isArrayLikeType(t, checker))(type.types))
    .otherwise(() => isArraySymbol(type));

type MessageIds = "preferFpTsArray";

const ARRAY_METHOD_REPLACEMENTS = {
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
} as const satisfies Readonly<Record<string, string>>;

const resolveCallTargetTsNode = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) =>
  services.esTreeNodeToTSNodeMap.get(
    node.callee.type === AST_NODE_TYPES.MemberExpression ? node.callee.object : node,
  );

const resolveCallTargetType = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) => checker.getTypeAtLocation(resolveCallTargetTsNode(node, services));

const isArrayTypeCall = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) => isArrayLikeType(resolveCallTargetType(node, services, checker), checker);

const isBannedMemberProperty = (member: TSESTree.MemberExpression) =>
  !member.computed &&
  member.property.type === AST_NODE_TYPES.Identifier &&
  O.isSome(RR.lookup(member.property.name, ARRAY_METHOD_REPLACEMENTS));

const isBannedArrayCall = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) =>
  node.callee.type === AST_NODE_TYPES.MemberExpression &&
  isBannedMemberProperty(node.callee) &&
  isArrayTypeCall(node, services, services.program.getTypeChecker());

const formatReplacementFields = (method: string) => ({
  method,
  replacement: O.getOrElse(() => `RA.${method}`)(RR.lookup(method, ARRAY_METHOD_REPLACEMENTS)),
});

const reportBannedProperty = (
  property: TSESTree.Identifier,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  report({
    node: property,
    messageId: "preferFpTsArray",
    data: formatReplacementFields(property.name),
  });
};

const checkArrayCall = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
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
      ({ callee }) => { reportBannedProperty(callee.property, report); },
    )
    .otherwise(() => {});
};

const buildArrayMethodListeners = (
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => ({
  CallExpression: (node: TSESTree.CallExpression) => {
    checkArrayCall(node, services, report);
  },
});

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
    const report = (d: TSESLint.ReportDescriptor<MessageIds>) => { context.report(d); };
    return buildArrayMethodListeners(ESLintUtils.getParserServices(context), report);
  },
});
