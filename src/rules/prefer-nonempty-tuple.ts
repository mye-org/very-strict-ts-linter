import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../utils/create-rule.js";
import {
  getEnclosingEsTreeFunction,
  isInsideUnsafeOrMustFunction,
  isTsParameterSymbol,
  isUnsafeOrMustName,
  PREDICATE_NAME_RE,
} from "../utils/type-helpers.js";

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

const isNonTupleArrayType = (type: ts.Type, checker: ts.TypeChecker) => {
  const symName = type.getSymbol()?.name;
  return (
    !checker.isTupleType(type) &&
    (checker.isArrayType(type) || symName === "Array" || symName === "ReadonlyArray")
  );
};

const getPatternTargetNode = (pattern: TSESTree.ArrayPattern) =>
  match(pattern.parent)
    .with({ type: AST_NODE_TYPES.VariableDeclarator }, (d) => O.fromNullable(d.init))
    .with({ type: AST_NODE_TYPES.AssignmentPattern }, (a) => O.some(a.left))
    .with(P._, () => O.some(pattern as TSESTree.Node))
    .exhaustive();

const isTargetNonTuple = (
  target: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => {
  const checker = services.program.getTypeChecker();
  return pipe(
    services.esTreeNodeToTSNodeMap.get(target),
    (tsNode) => checker.getTypeAtLocation(tsNode),
    (type) => isNonTupleArrayType(type, checker),
  );
};

const isNonTupleDestructuring = (
  node: TSESTree.ArrayPattern,
  services: ParserServicesWithTypeInformation,
) =>
  node.elements.length >= 1 &&
  pipe(getPatternTargetNode(node), O.exists((target) => isTargetNonTuple(target, services)));

const getEnclosingFnName = (fn: TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression) =>
  match(fn)
    .with({ type: AST_NODE_TYPES.FunctionDeclaration }, (f) => O.fromNullable(f.id?.name))
    .with({ parent: { type: AST_NODE_TYPES.VariableDeclarator, id: { type: AST_NODE_TYPES.Identifier } } }, (f) =>
      O.some(f.parent.id.name),
    )
    .with(P._, () => O.none)
    .exhaustive();

const isInlineCallCallback = (fn: TSESTree.Node) =>
  fn.parent?.type === AST_NODE_TYPES.CallExpression ||
  (fn.parent?.type === AST_NODE_TYPES.MemberExpression &&
    fn.parent.parent.type === AST_NODE_TYPES.CallExpression);

const isPredicateCallbackArg = (fn: TSESTree.Node) =>
  fn.parent?.type === AST_NODE_TYPES.CallExpression &&
  fn.parent.callee.type === AST_NODE_TYPES.MemberExpression &&
  fn.parent.callee.property.type === AST_NODE_TYPES.Identifier &&
  COLLECTION_PREDICATE_METHODS.has(fn.parent.callee.property.name);

const isExemptLengthContext = (node: TSESTree.Node) =>
  isInsideUnsafeOrMustFunction(node) ||
  pipe(
    getEnclosingEsTreeFunction(node),
    O.exists(
      (fn) =>
        isInlineCallCallback(fn) ||
        isPredicateCallbackArg(fn) ||
        pipe(
          getEnclosingFnName(fn),
          O.exists((name) => isUnsafeOrMustName(name) || PREDICATE_NAME_RE.test(name)),
        ),
    ),
  );

const getLengthMemberTarget = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.MemberExpression &&
  !expr.computed &&
  expr.property.type === AST_NODE_TYPES.Identifier &&
  expr.property.name === "length" &&
  expr.object.type === AST_NODE_TYPES.Identifier
    ? O.some(expr.object)
    : O.none;

const getNumericLiteralValue = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.Literal && typeof expr.value === "number"
    ? O.some(expr.value)
    : O.none;

const isFixedArityThreshold = (n: number) => n >= 2;

const isFailureReturnExpr = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.MemberExpression &&
  expr.object.type === AST_NODE_TYPES.Identifier &&
  (expr.object.name === "O" || expr.object.name === "E") &&
  expr.property.type === AST_NODE_TYPES.Identifier &&
  (expr.property.name === "none" || expr.property.name === "left");

const isInFailureTernaryGuard = (node: TSESTree.BinaryExpression) =>
  node.parent.type === AST_NODE_TYPES.ConditionalExpression &&
  node.parent.test === node &&
  (isFailureReturnExpr(node.parent.consequent) || isFailureReturnExpr(node.parent.alternate));

const isParamArrayIdentifier = (
  id: TSESTree.Identifier,
  services: ParserServicesWithTypeInformation,
) => {
  const checker = services.program.getTypeChecker();
  const tsNode = services.esTreeNodeToTSNodeMap.get(id);
  return (
    pipe(O.fromNullable(checker.getSymbolAtLocation(tsNode)), O.exists(isTsParameterSymbol)) &&
    isNonTupleArrayType(checker.getTypeAtLocation(tsNode), checker)
  );
};

const pickCheckedTarget = (
  target: O.Option<TSESTree.Identifier>,
  threshold: number,
  node: TSESTree.BinaryExpression,
) =>
  isFixedArityThreshold(threshold) || isInFailureTernaryGuard(node)
    ? target
    : O.none;

const extractCheckedArrayTarget = (node: TSESTree.BinaryExpression) =>
  LENGTH_OPERATORS.has(node.operator) && node.left.type !== AST_NODE_TYPES.PrivateIdentifier
    ? match({
        leftLen: getLengthMemberTarget(node.left),
        rightNum: getNumericLiteralValue(node.right),
        rightLen: getLengthMemberTarget(node.right),
        leftNum: getNumericLiteralValue(node.left),
      })
        .with({ leftLen: { _tag: "Some" }, rightNum: { _tag: "Some" } }, ({ leftLen, rightNum }) =>
          pickCheckedTarget(leftLen, rightNum.value, node),
        )
        .with({ rightLen: { _tag: "Some" }, leftNum: { _tag: "Some" } }, ({ rightLen, leftNum }) =>
          pickCheckedTarget(rightLen, leftNum.value, node),
        )
        .otherwise(() => O.none)
    : O.none;

const isRuntimeArrayLengthCheck = (
  node: TSESTree.BinaryExpression,
  services: ParserServicesWithTypeInformation,
) =>
  !isExemptLengthContext(node) &&
  pipe(
    extractCheckedArrayTarget(node),
    O.exists((id) => isParamArrayIdentifier(id, services)),
  );

const reportOpt = (
  node: TSESTree.Node,
  msg: O.Option<MessageIds>,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  pipe(msg, O.map((messageId) => { report({ node, messageId }); }));
};

export const preferNonemptyTuple = createRule<[], MessageIds>({
  name: "prefer-nonempty-tuple",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Encourage length-encoded tuple types (`readonly [T, ...T[]]` / fixed tuples) instead of destructuring or checking fixed/non-empty `.length` guards on `ReadonlyArray<T>` at runtime.",
    },
    messages: {
      preferTupleDestructuring:
        "Avoid destructuring a plain `ReadonlyArray<T>`. Require a tuple or `ReadonlyNonEmptyArray<T>` (`readonly [T, ...T[]]`) so element existence is proven at compile time.",
      preferNonEmptyOrFixedTuple:
        "Avoid runtime `.length` guards on a `ReadonlyArray<T>` parameter. Encode non-emptiness or exact arity using tuple types (`readonly [T, ...T[]]` or `readonly [T, T]`).",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const services = ESLintUtils.getParserServices(context);
    const rep = (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => { context.report(d); };
    return {
      ArrayPattern: (node) => { reportOpt(node, isNonTupleDestructuring(node, services) ? O.some("preferTupleDestructuring") : O.none, rep); },
      BinaryExpression: (node) => { reportOpt(node, isRuntimeArrayLengthCheck(node, services) ? O.some("preferNonEmptyOrFixedTuple") : O.none, rep); },
    };
  },
});
