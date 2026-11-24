import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServices,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../lib/rule-factory.js";

type MessageIds =
  | "noObjectAssignMutation"
  | "noReflectSet"
  | "noObjectDefineProperty"
  | "noMutatingMethod";

type CheckerContext = Readonly<{
  services: ParserServicesWithTypeInformation;
  checker: ts.TypeChecker;
}>;

type TypedReceiverPolicy = Readonly<{
  isMatch: (type: ts.Type, checker: ts.TypeChecker) => boolean;
}>;

type UntypedReceiverPolicy = Readonly<{
  isMatch: (receiver: TSESTree.Expression) => boolean;
}>;

const ARRAY_SYMBOL_NAMES: ReadonlySet<string> = new Set(["Array", "ReadonlyArray"]);
const MAP_SYMBOL_NAMES: ReadonlySet<string> = new Set(["Map", "ReadonlyMap"]);
const SET_SYMBOL_NAMES: ReadonlySet<string> = new Set(["Set", "ReadonlySet"]);

const MAP_CONSTRUCTORS: ReadonlySet<string> = new Set(["Map"]);
const SET_CONSTRUCTORS: ReadonlySet<string> = new Set(["Set"]);
const NON_ARRAY_CONSTRUCTORS: ReadonlySet<string> = new Set([
  "Map",
  "WeakMap",
  "Set",
  "WeakSet",
  "Date",
  "RegExp",
]);

const KNOWN_NON_ARRAY_IDENTIFIERS: ReadonlySet<string> = new Set([
  "RA",
  "RNEA",
  "A",
  "NEA",
  "RR",
  "R",
  "RM",
  "M",
  "RS",
  "S",
  "O",
  "E",
  "TE",
  "IO",
  "IOE",
  "T",
  "Math",
  "Object",
  "Reflect",
  "JSON",
  "console",
]);

const hasTypeProgram = (services: ParserServices): services is ParserServicesWithTypeInformation =>
  Boolean(services.program);

const toCheckerContext = (services: ParserServices) =>
  hasTypeProgram(services)
    ? O.some<CheckerContext>({ services, checker: services.program.getTypeChecker() })
    : O.none;

const readSymbolName = flow(
  (type: ts.Type) => type.getSymbol(),
  O.fromNullable,
  O.match(
    () => "",
    (symbol) => symbol.name,
  ),
);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive composite type check
const isCompositeTypeMatching = (type: ts.Type, isLeafMatch: (t: ts.Type) => boolean): boolean =>
  match({ isUnion: type.isUnion(), isIntersection: type.isIntersection() })
    .with(
      { isUnion: true },
      () =>
        type.isUnion() &&
        RA.every((member: ts.Type) => isCompositeTypeMatching(member, isLeafMatch))(type.types),
    )
    .with(
      { isIntersection: true },
      () =>
        type.isIntersection() &&
        RA.some((member: ts.Type) => isCompositeTypeMatching(member, isLeafMatch))(type.types),
    )
    .otherwise(() => isLeafMatch(type));

const isArrayLeafType = (type: ts.Type, checker: ts.TypeChecker) =>
  checker.isArrayType(type) ||
  checker.isTupleType(type) ||
  ARRAY_SYMBOL_NAMES.has(readSymbolName(type));

const isArrayLikeType = (type: ts.Type, checker: ts.TypeChecker) => {
  const isLeaf = (t: ts.Type) => isArrayLeafType(t, checker);
  return isCompositeTypeMatching(type, isLeaf);
};

const isMapLeafType = flow(readSymbolName, (name: string) => MAP_SYMBOL_NAMES.has(name));

const isSetLeafType = flow(readSymbolName, (name: string) => SET_SYMBOL_NAMES.has(name));

const isMapOrSetLeafType = (type: ts.Type) => isMapLeafType(type) || isSetLeafType(type);

const isMapLikeType = (type: ts.Type) => isCompositeTypeMatching(type, isMapLeafType);

const isSetLikeType = (type: ts.Type) => isCompositeTypeMatching(type, isSetLeafType);

const isMapOrSetLikeType = (type: ts.Type) => isCompositeTypeMatching(type, isMapOrSetLeafType);

const TYPED_METHOD_CHECKS = {
  push: { isMatch: isArrayLikeType },
  splice: { isMatch: isArrayLikeType },
  sort: { isMatch: isArrayLikeType },
  reverse: { isMatch: isArrayLikeType },
  fill: { isMatch: isArrayLikeType },
  set: { isMatch: isMapLikeType },
  add: { isMatch: isSetLikeType },
  delete: { isMatch: isMapOrSetLikeType },
} as const satisfies Readonly<Record<string, TypedReceiverPolicy>>;

const isNewBuiltinCall = (object: TSESTree.Expression, names: ReadonlySet<string>) =>
  object.type === AST_NODE_TYPES.NewExpression &&
  object.callee.type === AST_NODE_TYPES.Identifier &&
  names.has(object.callee.name);

const isKnownNonArrayReceiver = (object: TSESTree.Expression) =>
  (object.type === AST_NODE_TYPES.Identifier && KNOWN_NON_ARRAY_IDENTIFIERS.has(object.name)) ||
  object.type === AST_NODE_TYPES.ObjectExpression ||
  isNewBuiltinCall(object, NON_ARRAY_CONSTRUCTORS);

const isUntypedArrayReceiver = (receiver: TSESTree.Expression) => !isKnownNonArrayReceiver(receiver);

const isUntypedMapReceiver = (receiver: TSESTree.Expression) =>
  isNewBuiltinCall(receiver, MAP_CONSTRUCTORS);

const isUntypedSetReceiver = (receiver: TSESTree.Expression) =>
  isNewBuiltinCall(receiver, SET_CONSTRUCTORS);

const isUntypedMapOrSetReceiver = (receiver: TSESTree.Expression) =>
  isUntypedMapReceiver(receiver) || isUntypedSetReceiver(receiver);

const UNTYPED_METHOD_CHECKS = {
  push: { isMatch: isUntypedArrayReceiver },
  splice: { isMatch: isUntypedArrayReceiver },
  sort: { isMatch: isUntypedArrayReceiver },
  reverse: { isMatch: isUntypedArrayReceiver },
  fill: { isMatch: isUntypedArrayReceiver },
  set: { isMatch: isUntypedMapReceiver },
  add: { isMatch: isUntypedSetReceiver },
  delete: { isMatch: isUntypedMapOrSetReceiver },
} as const satisfies Readonly<Record<string, UntypedReceiverPolicy>>;

const isStaticMemberCall = (
  callee: TSESTree.Expression,
  target: Readonly<{ readonly objectName: "Object" | "Reflect"; readonly propertyName: "assign" | "set" | "defineProperty" }>,
) =>
  callee.type === AST_NODE_TYPES.MemberExpression &&
  !callee.computed &&
  callee.object.type === AST_NODE_TYPES.Identifier &&
  callee.object.name === target.objectName &&
  callee.property.type === AST_NODE_TYPES.Identifier &&
  callee.property.name === target.propertyName;

const isObjectExpression = (arg: TSESTree.CallExpressionArgument) =>
  arg.type === AST_NODE_TYPES.ObjectExpression;

const readFirstArg = (node: TSESTree.CallExpression) => RA.head(node.arguments);

const isFirstArgObjectLiteral = flow(readFirstArg, O.exists(isObjectExpression));

const isNonFreshObjectAssign = (node: TSESTree.CallExpression) =>
  isStaticMemberCall(node.callee, { objectName: "Object", propertyName: "assign" }) &&
  O.isSome(readFirstArg(node)) &&
  !isFirstArgObjectLiteral(node);

const resolveReceiverType = (
  receiver: TSESTree.Expression,
  { services, checker }: CheckerContext,
) => checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(receiver));

const isTypedPolicyMatch = (
  policy: TypedReceiverPolicy,
  target: Readonly<{ readonly receiver: TSESTree.Expression; readonly checkerCtx: CheckerContext }>,
) => policy.isMatch(resolveReceiverType(target.receiver, target.checkerCtx), target.checkerCtx.checker);

const hasTypedMethodMatch = (
  method: string,
  target: Readonly<{ readonly receiver: TSESTree.Expression; readonly checkerCtx: CheckerContext }>,
) =>
  O.exists((policy: TypedReceiverPolicy) => isTypedPolicyMatch(policy, target))(
    RR.lookup(method, TYPED_METHOD_CHECKS),
  );

const hasUntypedMethodMatch = (method: string, receiver: TSESTree.Expression) => {
  const isPolicyMatch = (policy: UntypedReceiverPolicy) => policy.isMatch(receiver);
  return O.exists(isPolicyMatch)(RR.lookup(method, UNTYPED_METHOD_CHECKS));
};

const isMutatingMemberCall = (
  member: TSESTree.MemberExpression,
  checkerCtx: O.Option<CheckerContext>,
) =>
  !member.computed &&
  member.property.type === AST_NODE_TYPES.Identifier &&
  match(checkerCtx)
    .with({ _tag: "None" }, () => hasUntypedMethodMatch(member.property.name, member.object))
    .with({ _tag: "Some" }, ({ value }) =>
      hasTypedMethodMatch(member.property.name, { receiver: member.object, checkerCtx: value }),
    )
    .exhaustive();

const findMutatingProperty = (
  callee: TSESTree.Expression,
  checkerCtx: O.Option<CheckerContext>,
) =>
  callee.type === AST_NODE_TYPES.MemberExpression &&
  !callee.computed &&
  callee.property.type === AST_NODE_TYPES.Identifier &&
  isMutatingMemberCall(callee, checkerCtx)
    ? O.some(callee.property)
    : O.none;

const reportMutatingProperty = (
  property: TSESTree.Identifier,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  report({
    node: property,
    messageId: "noMutatingMethod",
    data: { method: property.name },
  });
};

const checkMemberMethodMutation = (
  checkerCtx: O.Option<CheckerContext>,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => (node: TSESTree.CallExpression) => {
  O.map((property: TSESTree.Identifier) => {
    reportMutatingProperty(property, report);
  })(findMutatingProperty(node.callee, checkerCtx));
};

const classifyStaticMutation = (node: TSESTree.CallExpression) =>
  match({
    nonFreshAssign: isNonFreshObjectAssign(node),
    reflectSet: isStaticMemberCall(node.callee, { objectName: "Reflect", propertyName: "set" }),
    defineProperty: isStaticMemberCall(node.callee, { objectName: "Object", propertyName: "defineProperty" }),
  })
    .with({ nonFreshAssign: true }, () => O.some<MessageIds>("noObjectAssignMutation"))
    .with({ reflectSet: true }, () => O.some<MessageIds>("noReflectSet"))
    .with({ defineProperty: true }, () => O.some<MessageIds>("noObjectDefineProperty"))
    .otherwise(() => O.none);

const checkCallExpression = (
  checkerCtx: O.Option<CheckerContext>,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => (node: TSESTree.CallExpression) => {
  O.fold(
    () => {
      checkMemberMethodMutation(checkerCtx, report)(node);
    },
    (messageId: MessageIds) => {
      report({ node, messageId });
    },
  )(classifyStaticMutation(node));
};

const buildNoMutationListeners = (
  checkerCtx: O.Option<CheckerContext>,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => ({
  CallExpression: checkCallExpression(checkerCtx, report),
});

const parseCheckerContext = flow(
  (context: Readonly<TSESLint.RuleContext<MessageIds, []>>) =>
    ESLintUtils.getParserServices(context, true),
  toCheckerContext,
);

export const noMutation = createRule<[], MessageIds>({
  name: "no-mutation",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow in-place object and collection mutations (`Object.assign` on existing objects, `Reflect.set`, `Object.defineProperty`, and mutating Array/Map/Set methods).",
    },
    messages: {
      noObjectAssignMutation:
        "Avoid mutating an existing object with `Object.assign()`. Use object spread or `Object.assign({}, ...)` instead.",
      noReflectSet:
        "Avoid `Reflect.set()` as it mutates objects in place. Construct a new object instead.",
      noObjectDefineProperty:
        "Avoid `Object.defineProperty()` as it mutates objects in place. Construct a new object instead.",
      noMutatingMethod:
        "Avoid mutating method `.{{method}}()`. Use an immutable alternative instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const report = (d: TSESLint.ReportDescriptor<MessageIds>) => {
      context.report(d);
    };
    return buildNoMutationListeners(parseCheckerContext(context), report);
  },
});
