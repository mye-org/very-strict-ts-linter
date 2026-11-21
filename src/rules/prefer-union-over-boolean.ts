import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../utils/create-rule.js";
import { hasFunctionInit, isEsTreeFunctionNode, PREDICATE_NAME_RE } from "../utils/type-helpers.js";

type MessageIds =
  | "preferUnionOverBooleanParam"
  | "preferUnionOverBooleanType"
  | "preferUnionOverBooleanReturn"
  | "preferUnionOverBooleanVar";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

type FunctionLikeNode =
  | FunctionNode
  | TSESTree.TSFunctionType
  | TSESTree.TSMethodSignature
  | TSESTree.TSDeclareFunction
  | TSESTree.TSCallSignatureDeclaration
  | TSESTree.TSConstructSignatureDeclaration;

const PREDICATE_TYPE_RE = /^(Is|Has|Can|Should)(?=$|[A-Z0-9_])/;
const PREDICATE_TYPE_NAMES = new Set(["Predicate", "Refinement"]);
const PREDICATE_METHOD_NAMES = new Set([
  "when",
  "filter",
  "some",
  "every",
  "find",
  "findLast",
  "findIndex",
  "findLastIndex",
]);
const FUNCTION_LIKE_TYPES = new Set<AST_NODE_TYPES>([
  AST_NODE_TYPES.FunctionDeclaration,
  AST_NODE_TYPES.FunctionExpression,
  AST_NODE_TYPES.ArrowFunctionExpression,
  AST_NODE_TYPES.TSFunctionType,
  AST_NODE_TYPES.TSMethodSignature,
  AST_NODE_TYPES.TSDeclareFunction,
  AST_NODE_TYPES.TSCallSignatureDeclaration,
  AST_NODE_TYPES.TSConstructSignatureDeclaration,
]);

const isPredicateName = (name: string) => PREDICATE_NAME_RE.test(name);

const isPredicateTypeAliasName = (name: string) =>
  PREDICATE_TYPE_RE.test(name) || name.endsWith("Predicate");

const isBooleanTsType = (type: ts.Type) =>
  Boolean(type.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral));

const isFunctionLikeType = (node: TSESTree.Node): node is FunctionLikeNode =>
  FUNCTION_LIKE_TYPES.has(node.type);

const getFunctionParams = (node: TSESTree.Node) =>
  isFunctionLikeType(node)
    ? O.some<ReadonlyArray<TSESTree.Parameter>>(node.params)
    : O.none;

const hasParamNode = (node: TSESTree.Node, params: ReadonlyArray<TSESTree.Parameter>) =>
  pipe(params, RA.some((p) => p === node));

const isParameterHolder = (node: TSESTree.Node) =>
  node.parent?.type === AST_NODE_TYPES.AssignmentPattern
    ? node.parent.left === node && isFunctionLikeType(node.parent.parent)
    : pipe(
        O.fromNullable(node.parent),
        O.flatMap(getFunctionParams),
        O.exists((params) => hasParamNode(node, params)),
      );

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const isInsideParameterAnnotation = (node: TSESTree.Node): boolean =>
  pipe(
    O.fromNullable(node.parent),
    O.exists((parent) =>
      parent.type === AST_NODE_TYPES.TSTypeAnnotation
        ? isParameterHolder(parent.parent) || isInsideParameterAnnotation(parent)
        : isInsideParameterAnnotation(parent),
    ),
  );

const isPredicateRefName = (typeNode: TSESTree.TypeNode) =>
  typeNode.type === AST_NODE_TYPES.TSTypeReference &&
  match(typeNode.typeName)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => PREDICATE_TYPE_NAMES.has(id.name))
    .with({ type: AST_NODE_TYPES.TSQualifiedName }, (q) => PREDICATE_TYPE_NAMES.has(q.right.name))
    .with(P._, () => false)
    .exhaustive();

const hasPredicateTypeAnnotation = (id: TSESTree.Identifier) =>
  pipe(
    O.fromNullable(id.typeAnnotation?.typeAnnotation),
    O.exists(isPredicateRefName),
  );

const getEnclosingBindingName = (node: FunctionNode) =>
  match(node)
    .with({ type: AST_NODE_TYPES.FunctionDeclaration }, (fn) => O.fromNullable(fn.id?.name))
    .with({ parent: { type: AST_NODE_TYPES.VariableDeclarator, id: { type: AST_NODE_TYPES.Identifier } } }, (fn) =>
      O.some(fn.parent.id.name),
    )
    .with({ parent: { type: AST_NODE_TYPES.Property, key: { type: AST_NODE_TYPES.Identifier } } }, (fn) =>
      O.some(fn.parent.key.name),
    )
    .with({ parent: { type: AST_NODE_TYPES.MethodDefinition, key: { type: AST_NODE_TYPES.Identifier } } }, (fn) =>
      O.some(fn.parent.key.name),
    )
    .with(P._, () => O.none)
    .exhaustive();

const hasPredicateBindingAnnotation = (node: FunctionNode) =>
  match(node.parent)
    .with({ type: AST_NODE_TYPES.VariableDeclarator, id: { type: AST_NODE_TYPES.Identifier } }, (d) =>
      hasPredicateTypeAnnotation(d.id),
    )
    .with(P._, () => false)
    .exhaustive();

const getCalleeName = (callee: TSESTree.Expression) =>
  match(callee)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => O.some(id.name))
    .with({ type: AST_NODE_TYPES.MemberExpression, property: { type: AST_NODE_TYPES.Identifier } }, (m) =>
      O.some(m.property.name),
    )
    .with(P._, () => O.none)
    .exhaustive();

const isKnownPredicateMethodCall = (
  call: TSESTree.CallExpression,
  argNode: TSESTree.Node,
) =>
  pipe(
    RA.head(call.arguments),
    O.exists((first) => (first as TSESTree.Node) === argNode),
  ) &&
  pipe(
    getCalleeName(call.callee),
    O.exists((name) => PREDICATE_METHOD_NAMES.has(name)),
  );

const isPredicateContextualSig = (sig: ts.Signature, checker: ts.TypeChecker) =>
  Boolean(checker.getTypePredicateOfSignature(sig)) ||
  isBooleanTsType(checker.getReturnTypeOfSignature(sig));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const isPredicateType = (type: ts.Type, checker: ts.TypeChecker): boolean =>
  type.isUnion()
    ? pipe(type.types, RA.some((t) => isPredicateType(t, checker)))
    : pipe(type.getCallSignatures(), RA.some((sig) => isPredicateContextualSig(sig, checker)));

const isPredicateParamSymbol = (param: ts.Symbol, checker: ts.TypeChecker) =>
  pipe(checker.getTypeOfSymbol(param), (t) => isPredicateType(t, checker));

const isSigArgPredicate = (sig: ts.Signature, argIndex: number, checker: ts.TypeChecker) =>
  pipe(
    O.fromNullable(sig.getParameters()[argIndex]),
    O.exists((param) => isPredicateParamSymbol(param, checker)),
  );

const hasCalleePredicateParam = (
  call: TSESTree.CallExpression,
  argIndex: number,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  pipe(
    services.esTreeNodeToTSNodeMap.get(call.callee),
    (tsCallee) => checker.getTypeAtLocation(tsCallee).getCallSignatures(),
    RA.some((sig) => isSigArgPredicate(sig, argIndex, checker)),
  );

const isCallPredicateArg = (
  call: TSESTree.CallExpression,
  argNode: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  pipe(
    call.arguments,
    RA.findIndex((arg) => (arg as TSESTree.Node) === argNode),
    O.exists(
      (argIndex) =>
        isKnownPredicateMethodCall(call, argNode) ||
        hasCalleePredicateParam(call, argIndex, services, checker),
    ),
  );

const isMatchBranchCall = (node: FunctionNode) =>
  node.parent.type === AST_NODE_TYPES.CallExpression &&
  node.parent.callee.type === AST_NODE_TYPES.MemberExpression &&
  node.parent.callee.property.type === AST_NODE_TYPES.Identifier &&
  (node.parent.callee.property.name === "with" ||
    node.parent.callee.property.name === "otherwise") &&
  node.parent.arguments[node.parent.arguments.length - 1] === node;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const getEnclosingFunctionNode = (node: TSESTree.Node): O.Option<FunctionNode> =>
  pipe(
    O.fromNullable(node.parent),
    O.flatMap((parent) =>
      isEsTreeFunctionNode(parent) ? O.some(parent) : getEnclosingFunctionNode(parent),
    ),
  );

const isPipeOrFlowFinalArg = (node: FunctionNode) =>
  node.parent.type === AST_NODE_TYPES.CallExpression &&
  node.parent.callee.type === AST_NODE_TYPES.Identifier &&
  (node.parent.callee.name === "flow" || node.parent.callee.name === "pipe") &&
  node.parent.arguments[node.parent.arguments.length - 1] === node
    ? O.some(node.parent)
    : O.none;

const isCallBoundAsPredicate = (
  call: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive check
): boolean =>
  (call.parent.type === AST_NODE_TYPES.VariableDeclarator &&
    call.parent.id.type === AST_NODE_TYPES.Identifier &&
    (isPredicateName(call.parent.id.name) || hasPredicateTypeAnnotation(call.parent.id))) ||
  (call.parent.type === AST_NODE_TYPES.CallExpression &&
    isCallPredicateArg(call.parent, call, services, checker)) ||
  (call.callee.type === AST_NODE_TYPES.Identifier &&
    call.callee.name === "pipe" &&
    pipe(
      getEnclosingFunctionNode(call),
      O.exists((fn) => isExemptedFunction(fn, services, checker)),
    ));

const isInlinePredicateCallback = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  match(node.parent)
    .with({ type: AST_NODE_TYPES.CallExpression }, (call) =>
      isCallPredicateArg(call, node, services, checker),
    )
    .with(P._, () => false)
    .exhaustive() ||
  pipe(
    isPipeOrFlowFinalArg(node),
    O.exists((call) => isCallBoundAsPredicate(call, services, checker)),
  );

const isExemptedFunction = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive check
): boolean =>
  node.returnType?.typeAnnotation.type === AST_NODE_TYPES.TSTypePredicate ||
  pipe(getEnclosingBindingName(node), O.exists(isPredicateName)) ||
  hasPredicateBindingAnnotation(node) ||
  isInlinePredicateCallback(node, services, checker) ||
  (isMatchBranchCall(node) &&
    pipe(
      getEnclosingFunctionNode(node),
      O.exists((fn) => isExemptedFunction(fn, services, checker)),
    ));

const hasBooleanReturnType = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  pipe(
    services.esTreeNodeToTSNodeMap.get(node) as ts.SignatureDeclaration,
    (tsNode) => checker.getSignatureFromDeclaration(tsNode),
    O.fromNullable,
    O.map((sig) => checker.getReturnTypeOfSignature(sig)),
    O.exists(isBooleanTsType),
  );

const isExemptedFunctionType = (fnType: TSESTree.TSFunctionType) =>
  isInsideParameterAnnotation(fnType) ||
  (fnType.parent.type === AST_NODE_TYPES.TSTypeAliasDeclaration &&
    isPredicateTypeAliasName(fnType.parent.id.name)) ||
  (fnType.parent.type === AST_NODE_TYPES.TSTypeAnnotation &&
    fnType.parent.parent.type === AST_NODE_TYPES.TSPropertySignature &&
    fnType.parent.parent.key.type === AST_NODE_TYPES.Identifier &&
    isPredicateName(fnType.parent.parent.key.name));

const isExemptedNamedSignature = (sig: TSESTree.TSMethodSignature | TSESTree.TSDeclareFunction) =>
  match(sig)
    .with({ type: AST_NODE_TYPES.TSMethodSignature, key: { type: AST_NODE_TYPES.Identifier } }, (m) =>
      isPredicateName(m.key.name),
    )
    .with({ type: AST_NODE_TYPES.TSDeclareFunction, id: { type: AST_NODE_TYPES.Identifier } }, (f) =>
      isPredicateName(f.id.name),
    )
    .with(P._, () => false)
    .exhaustive();

const isHandledElsewhereInAnnotation = (gp: TSESTree.Node) =>
  gp.type === AST_NODE_TYPES.TSPropertySignature ||
  gp.type === AST_NODE_TYPES.FunctionDeclaration ||
  gp.type === AST_NODE_TYPES.FunctionExpression ||
  gp.type === AST_NODE_TYPES.ArrowFunctionExpression ||
  (gp.type === AST_NODE_TYPES.Identifier && gp.parent.type === AST_NODE_TYPES.VariableDeclarator);

const classifyAnnotationTarget = (gp: TSESTree.Node) =>
  match(gp)
    .when(isParameterHolder, () => O.some<MessageIds>("preferUnionOverBooleanParam"))
    .with({ type: AST_NODE_TYPES.TSFunctionType }, (fnType) =>
      isExemptedFunctionType(fnType) ? O.none : O.some<MessageIds>("preferUnionOverBooleanReturn"),
    )
    .with({ type: AST_NODE_TYPES.TSMethodSignature }, { type: AST_NODE_TYPES.TSDeclareFunction }, (sig) =>
      isExemptedNamedSignature(sig) ? O.none : O.some<MessageIds>("preferUnionOverBooleanReturn"),
    )
    .with(
      { type: AST_NODE_TYPES.TSCallSignatureDeclaration },
      { type: AST_NODE_TYPES.TSConstructSignatureDeclaration },
      () => O.some<MessageIds>("preferUnionOverBooleanReturn"),
    )
    .with(P._, () => O.some<MessageIds>("preferUnionOverBooleanType"))
    .exhaustive();

const classifyDirectTypeAnnotation = (gp: TSESTree.Node) =>
  isHandledElsewhereInAnnotation(gp) ? O.none : classifyAnnotationTarget(gp);

const classifyBooleanKeyword = (node: TSESTree.TSBooleanKeyword) =>
  node.parent.type === AST_NODE_TYPES.TSTypeAnnotation
    ? classifyDirectTypeAnnotation(node.parent.parent)
    : O.some<MessageIds>("preferUnionOverBooleanType");

const isBooleanNodeType = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) =>
  pipe(
    services.esTreeNodeToTSNodeMap.get(node),
    (tsNode) => services.program.getTypeChecker().getTypeAtLocation(tsNode),
    isBooleanTsType,
  );

const checkFunctionNode = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
  report: (n: TSESTree.Node, messageId: MessageIds) => void,
) => {
  match(
    !isExemptedFunction(node, services, services.program.getTypeChecker()) &&
      hasBooleanReturnType(node, services, services.program.getTypeChecker()),
  )
    .with(true, () => { report(node.returnType ?? node, "preferUnionOverBooleanReturn"); })
    .with(false, () => {})
    .exhaustive();
};

const isFunctionInitializer = hasFunctionInit;

const checkVariableDeclarator = (
  node: TSESTree.VariableDeclarator,
  services: ParserServicesWithTypeInformation,
  report: (n: TSESTree.Node, messageId: MessageIds) => void,
) => {
  match(
    !isFunctionInitializer(node) &&
      node.id.type === AST_NODE_TYPES.Identifier &&
      isBooleanNodeType(node.id, services),
  )
    .with(true, () => { report(node.id, "preferUnionOverBooleanVar"); })
    .with(false, () => {})
    .exhaustive();
};

const checkAssignmentPattern = (
  node: TSESTree.AssignmentPattern,
  services: ParserServicesWithTypeInformation,
  report: (n: TSESTree.Node, messageId: MessageIds) => void,
) => {
  match(
    isFunctionLikeType(node.parent) &&
      node.left.type === AST_NODE_TYPES.Identifier &&
      !node.left.typeAnnotation &&
      isBooleanNodeType(node.left, services),
  )
    .with(true, () => { report(node.left, "preferUnionOverBooleanParam"); })
    .with(false, () => {})
    .exhaustive();
};

export const preferUnionOverBoolean = createRule<[], MessageIds>({
  name: "prefer-union-over-boolean",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Discourage boolean blindness across parameters, types, variables, and non-predicate return types; prefer discriminated unions, Option, or Either (see also `no-lifecycle-flag-clusters`).",
    },
    messages: {
      preferUnionOverBooleanParam:
        "Avoid `boolean` parameters to prevent boolean blindness. Model states as a discriminated union (e.g. `{ readonly kind: \"a\" } | { readonly kind: \"b\" }`).",
      preferUnionOverBooleanType:
        "Avoid `boolean` in type definitions. Model domain states as a discriminated union (e.g. `{ readonly kind: \"a\" } | { readonly kind: \"b\" }`).",
      preferUnionOverBooleanReturn:
        "Avoid non-predicate functions returning `boolean`. Return a discriminated union, `Option`, or `Either` so error and domain states are explicit.",
      preferUnionOverBooleanVar:
        "Avoid storing `boolean` values in variables. Model states as a discriminated union, `Option`, or `Either`.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const services = ESLintUtils.getParserServices(context);
    const report = (node: TSESTree.Node, messageId: MessageIds) => {
      context.report({ node, messageId });
    };
    const onFunction = (node: FunctionNode) => { checkFunctionNode(node, services, report); };
    return {
      TSBooleanKeyword: (node) => { pipe(classifyBooleanKeyword(node), O.map((id) => { report(node, id); })); },
      FunctionDeclaration: onFunction,
      FunctionExpression: onFunction,
      ArrowFunctionExpression: onFunction,
      VariableDeclarator: (node) => { checkVariableDeclarator(node, services, report); },
      AssignmentPattern: (node) => { checkAssignmentPattern(node, services, report); },
    };
  },
});
