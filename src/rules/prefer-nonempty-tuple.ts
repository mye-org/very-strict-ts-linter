import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { resolveEnclosingEsTreeFunction } from "../lib/estree-function-nodes.js";
import { PREDICATE_NAME_RE } from "../lib/predicate-name.js";
import { createRule } from "../lib/rule-factory.js";
import { isTsParameterSymbol } from "../lib/ts-parameter-symbol.js";
import { isInsideUnsafeOrMustFunction, isUnsafeOrMustName } from "../lib/unsafe-function-scope.js";

type MessageIds = "preferTupleDestructuring" | "preferNonEmptyOrFixedTuple";

const COLLECTION_PREDICATE_METHODS = new Set([
  "filter",
  "some",
  "every",
  "find",
  "findLast",
  "when",
]);
const LENGTH_OPERATORS = new Set(["===", "!==", "==", "!=", ">", ">=", "<", "<="]);
const LENGTH_PROPERTY_NAMES: ReadonlySet<string> = new Set(["length"]);
const FAILURE_NAMESPACES: ReadonlySet<string> = new Set(["O", "E"]);
const FAILURE_MEMBERS: ReadonlySet<string> = new Set(["none", "left"]);

const isNonTupleArrayType = (type: ts.Type, checker: ts.TypeChecker) => {
  const symName = type.getSymbol()?.name;
  return (
    !checker.isTupleType(type) &&
    (checker.isArrayType(type) || symName === "Array" || symName === "ReadonlyArray")
  );
};

const resolvePatternTargetNode = (pattern: TSESTree.ArrayPattern) =>
  match(pattern)
    .with({ parent: { type: AST_NODE_TYPES.VariableDeclarator, init: P.select() } }, O.fromNullable)
    .with({ parent: { type: AST_NODE_TYPES.AssignmentPattern, left: P.select() } }, O.some)
    .with(P._, () => O.some<TSESTree.Node>(pattern))
    .exhaustive();

const resolveTargetType = (
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  flow(
    (target: TSESTree.Node) => services.esTreeNodeToTSNodeMap.get(target),
    (tsNode) => checker.getTypeAtLocation(tsNode),
  );

const isTargetNonTuple = (
  target: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => {
  const checker = services.program.getTypeChecker();
  return isNonTupleArrayType(resolveTargetType(services, checker)(target), checker);
};

const isNonTupleDestructuring = (
  node: TSESTree.ArrayPattern,
  services: ParserServicesWithTypeInformation,
) =>
  node.elements.length >= 1 &&
  O.exists((target: TSESTree.Node) => isTargetNonTuple(target, services))(
    resolvePatternTargetNode(node),
  );

const resolveVarDeclaratorName = (parent: TSESTree.Node) =>
  parent.type === AST_NODE_TYPES.VariableDeclarator &&
  parent.id.type === AST_NODE_TYPES.Identifier
    ? O.some(parent.id.name)
    : O.none;

const resolveEnclosingFnName = (
  fn: TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression,
) =>
  fn.type === AST_NODE_TYPES.FunctionDeclaration
    ? O.fromNullable(fn.id?.name)
    : O.flatMap(resolveVarDeclaratorName)(O.fromNullable(fn.parent));

const isMemberParentOfCall = (member: TSESTree.MemberExpression) =>
  member.parent.type === AST_NODE_TYPES.CallExpression;

const isInlineCallCallback = (fn: TSESTree.Node) =>
  fn.parent?.type === AST_NODE_TYPES.CallExpression ||
  (fn.parent?.type === AST_NODE_TYPES.MemberExpression && isMemberParentOfCall(fn.parent));

const isCollectionPredicateMember = (member: TSESTree.MemberExpression) =>
  member.property.type === AST_NODE_TYPES.Identifier &&
  COLLECTION_PREDICATE_METHODS.has(member.property.name);

const isCollectionPredicateCall = (call: TSESTree.CallExpression) =>
  call.callee.type === AST_NODE_TYPES.MemberExpression &&
  isCollectionPredicateMember(call.callee);

const isPredicateCallbackArg = (fn: TSESTree.Node) =>
  fn.parent?.type === AST_NODE_TYPES.CallExpression && isCollectionPredicateCall(fn.parent);

const isPredicateFnName = (name: string) => PREDICATE_NAME_RE.test(name);

const isExemptFnName = flow(
  resolveEnclosingFnName,
  O.exists((name: string) => isUnsafeOrMustName(name) || isPredicateFnName(name)),
);

const isExemptLengthContext = (node: TSESTree.Node) =>
  isInsideUnsafeOrMustFunction(node) ||
  O.exists(
    (
      fn: TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression,
    ) => isInlineCallCallback(fn) || isPredicateCallbackArg(fn) || isExemptFnName(fn),
  )(resolveEnclosingEsTreeFunction(node));

const resolveLengthMemberTarget = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.MemberExpression &&
  !expr.computed &&
  expr.property.type === AST_NODE_TYPES.Identifier &&
  LENGTH_PROPERTY_NAMES.has(expr.property.name) &&
  expr.object.type === AST_NODE_TYPES.Identifier
    ? O.some(expr.object)
    : O.none;

const resolveNumericLiteralValue = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.Literal && typeof expr.value === "number"
    ? O.some(expr.value)
    : O.none;

const isFixedArityThreshold = (n: number) => n >= 2;

const isFailureMember = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.MemberExpression &&
  !expr.computed &&
  expr.object.type === AST_NODE_TYPES.Identifier &&
  FAILURE_NAMESPACES.has(expr.object.name) &&
  expr.property.type === AST_NODE_TYPES.Identifier &&
  FAILURE_MEMBERS.has(expr.property.name);

const isFailureReturnExpr = (expr: TSESTree.Expression) =>
  isFailureMember(expr) ||
  (expr.type === AST_NODE_TYPES.CallExpression && isFailureMember(expr.callee));

const isInFailureTernaryGuard = (node: TSESTree.BinaryExpression) =>
  node.parent.type === AST_NODE_TYPES.ConditionalExpression &&
  node.parent.test === node &&
  (isFailureReturnExpr(node.parent.consequent) || isFailureReturnExpr(node.parent.alternate));

const isTsParamNode = (tsNode: ts.Node, checker: ts.TypeChecker) => {
  const check = flow(
    (n: ts.Node) => checker.getSymbolAtLocation(n),
    O.fromNullable,
    O.exists(isTsParameterSymbol),
  );
  return check(tsNode);
};

const isParamArrayIdentifier = (
  id: TSESTree.Identifier,
  services: ParserServicesWithTypeInformation,
) => {
  const checker = services.program.getTypeChecker();
  const tsNode = services.esTreeNodeToTSNodeMap.get(id);
  return (
    isTsParamNode(tsNode, checker) &&
    isNonTupleArrayType(checker.getTypeAtLocation(tsNode), checker)
  );
};

const pickCheckedTarget =
  (node: TSESTree.BinaryExpression) =>
  (target: O.Option<TSESTree.Identifier>, threshold: number) =>
    isFixedArityThreshold(threshold) || isInFailureTernaryGuard(node)
      ? target
      : O.none;

const extractCheckedArrayTarget = (node: TSESTree.BinaryExpression) =>
  LENGTH_OPERATORS.has(node.operator) && node.left.type !== AST_NODE_TYPES.PrivateIdentifier
    ? match({
        leftLen: resolveLengthMemberTarget(node.left),
        rightNum: resolveNumericLiteralValue(node.right),
        rightLen: resolveLengthMemberTarget(node.right),
        leftNum: resolveNumericLiteralValue(node.left),
      })
        .with({ leftLen: { _tag: "Some" }, rightNum: { _tag: "Some" } }, ({ leftLen, rightNum }) =>
          pickCheckedTarget(node)(leftLen, rightNum.value),
        )
        .with({ rightLen: { _tag: "Some" }, leftNum: { _tag: "Some" } }, ({ rightLen, leftNum }) =>
          pickCheckedTarget(node)(rightLen, leftNum.value),
        )
        .otherwise(() => O.none)
    : O.none;

const isRuntimeArrayLengthCheck = (
  node: TSESTree.BinaryExpression,
  services: ParserServicesWithTypeInformation,
) =>
  !isExemptLengthContext(node) &&
  O.exists((id: TSESTree.Identifier) => isParamArrayIdentifier(id, services))(
    extractCheckedArrayTarget(node),
  );

const reportOpt =
  (report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void) =>
  (node: TSESTree.Node, msg: O.Option<MessageIds>) => {
    O.map((messageId: MessageIds) => { report({ node, messageId }); })(msg);
  };

export const preferNonemptyTuple = createRule<[], MessageIds>({
  name: "prefer-nonempty-tuple",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Encourage length-encoded tuple types (`readonly [T, ...ReadonlyArray<T>]` / fixed tuples) instead of destructuring or checking fixed/non-empty `.length` guards on `ReadonlyArray<T>` at runtime.",
    },
    messages: {
      preferTupleDestructuring:
        "Avoid destructuring a plain `ReadonlyArray<T>`. Require a tuple or `ReadonlyNonEmptyArray<T>` (`readonly [T, ...ReadonlyArray<T>]`) so element existence is proven at compile time.",
      preferNonEmptyOrFixedTuple:
        "Avoid runtime `.length` guards on a `ReadonlyArray<T>` parameter. Encode non-emptiness or exact arity using tuple types (`readonly [T, ...ReadonlyArray<T>]` or `readonly [T, T]`).",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const services = ESLintUtils.getParserServices(context);
    const rep = reportOpt((d) => { context.report(d); });
    return {
      ArrayPattern: (node) => { rep(node, isNonTupleDestructuring(node, services) ? O.some("preferTupleDestructuring") : O.none); },
      BinaryExpression: (node) => { rep(node, isRuntimeArrayLengthCheck(node, services) ? O.some("preferNonEmptyOrFixedTuple") : O.none); },
    };
  },
});
