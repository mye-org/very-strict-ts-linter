import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { hasFunctionInit, isEsTreeFunctionNode } from "../lib/estree-function-nodes.js";
import { PREDICATE_NAME_RE } from "../lib/predicate-name.js";
import { createRule } from "../lib/rule-factory.js";

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
const PREDICATE_TYPE_NAMES: ReadonlySet<string> = new Set(["Predicate", "Refinement"]);
const MATCH_BRANCH_METHODS: ReadonlySet<string> = new Set(["with", "otherwise"]);
const PIPELINE_CALLEES: ReadonlySet<string> = new Set(["flow", "pipe"]);
const PIPE_CALLEES: ReadonlySet<string> = new Set(["pipe"]);
const PREDICATE_METHOD_NAMES: ReadonlySet<string> = new Set([
  "when",
  "filter",
  "some",
  "every",
  "find",
  "findLast",
  "findIndex",
  "findLastIndex",
]);
const FUNCTION_LIKE_TYPES: ReadonlySet<AST_NODE_TYPES> = new Set<AST_NODE_TYPES>([
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
  (type.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !== 0;

const isFunctionLikeType = (node: TSESTree.Node): node is FunctionLikeNode =>
  FUNCTION_LIKE_TYPES.has(node.type);

const extractFunctionParams = (node: TSESTree.Node) =>
  isFunctionLikeType(node)
    ? O.some<ReadonlyArray<TSESTree.Parameter>>(node.params)
    : O.none;

const hasParamNode = (node: TSESTree.Node, params: ReadonlyArray<TSESTree.Parameter>) =>
  RA.some((p: TSESTree.Parameter) => p === node)(params);

const extractParentParams = flow(
  (n: TSESTree.Node) => O.fromNullable(n.parent),
  O.flatMap(extractFunctionParams),
);

const isParameterHolder = (node: TSESTree.Node) =>
  node.parent?.type === AST_NODE_TYPES.AssignmentPattern
    ? node.parent.left === node && isFunctionLikeType(node.parent.parent)
    : O.exists((params: ReadonlyArray<TSESTree.Parameter>) => hasParamNode(node, params))(
        extractParentParams(node),
      );

const isInsideParameterAnnotation: Pred.Predicate<TSESTree.Node> = flow(
  (n: TSESTree.Node) => n.parent,
  O.fromNullable,
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

const hasPredicateTypeAnnotation = flow(
  (id: TSESTree.Identifier) => id.typeAnnotation?.typeAnnotation,
  O.fromNullable,
  O.exists(isPredicateRefName),
);

const resolveParentBindingName = (parent: TSESTree.Node) =>
  match(parent)
    .with({ type: AST_NODE_TYPES.VariableDeclarator, id: { type: AST_NODE_TYPES.Identifier } }, (d) =>
      O.some(d.id.name),
    )
    .with({ type: AST_NODE_TYPES.Property, key: { type: AST_NODE_TYPES.Identifier } }, (p) =>
      O.some(p.key.name),
    )
    .with({ type: AST_NODE_TYPES.MethodDefinition, key: { type: AST_NODE_TYPES.Identifier } }, (m) =>
      O.some(m.key.name),
    )
    .with(P._, () => O.none)
    .exhaustive();

const resolveEnclosingBindingName = (node: FunctionNode) =>
  node.type === AST_NODE_TYPES.FunctionDeclaration
    ? O.fromNullable(node.id?.name)
    : resolveParentBindingName(node.parent);

const hasPredicateBindingAnnotation = (node: FunctionNode) =>
  match(node.parent)
    .with({ type: AST_NODE_TYPES.VariableDeclarator, id: { type: AST_NODE_TYPES.Identifier } }, (d) =>
      hasPredicateTypeAnnotation(d.id),
    )
    .with(P._, () => false)
    .exhaustive();

const resolveCalleeName = (callee: TSESTree.Expression) =>
  match(callee)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => O.some(id.name))
    .with({ type: AST_NODE_TYPES.MemberExpression, property: { type: AST_NODE_TYPES.Identifier } }, (m) =>
      O.some(m.property.name),
    )
    .with(P._, () => O.none)
    .exhaustive();

const isFirstArgNode = (call: TSESTree.CallExpression, argNode: TSESTree.Node) =>
  O.exists((first: TSESTree.Node) => first === argNode)(
    RA.head<TSESTree.CallExpressionArgument>(call.arguments),
  );

const isPredicateMethodCallee = flow(
  resolveCalleeName,
  O.exists((name) => PREDICATE_METHOD_NAMES.has(name)),
);

const isKnownPredicateMethodCall = (
  call: TSESTree.CallExpression,
  argNode: TSESTree.Node,
) => isFirstArgNode(call, argNode) && isPredicateMethodCallee(call.callee);

const isPredicateContextualSig = (sig: ts.Signature, checker: ts.TypeChecker) =>
  checker.getTypePredicateOfSignature(sig) !== undefined ||
  isBooleanTsType(checker.getReturnTypeOfSignature(sig));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const isPredicateType = (type: ts.Type, checker: ts.TypeChecker): boolean =>
  type.isUnion()
    ? RA.some((t: ts.Type) => isPredicateType(t, checker))(type.types)
    : RA.some((sig: ts.Signature) => isPredicateContextualSig(sig, checker))(type.getCallSignatures());

const isPredicateParamSymbol = (param: ts.Symbol, checker: ts.TypeChecker) =>
  isPredicateType(checker.getTypeOfSymbol(param), checker);

const isSigArgPredicate = (sig: ts.Signature, argIndex: number, checker: ts.TypeChecker) =>
  O.exists((param: ts.Symbol) => isPredicateParamSymbol(param, checker))(
    O.fromNullable(sig.getParameters()[argIndex]),
  );

const hasCalleePredicateParam = (
  call: TSESTree.CallExpression,
  argIndex: number,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  RA.some((sig: ts.Signature) => isSigArgPredicate(sig, argIndex, checker))(
    checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(call.callee)).getCallSignatures(),
  );

const isCallPredicateArg = (
  call: TSESTree.CallExpression,
  argNode: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) => {
  const check = flow(
    RA.findIndex((arg: TSESTree.Node) => arg === argNode),
    O.exists(
      (argIndex) =>
        isKnownPredicateMethodCall(call, argNode) ||
        hasCalleePredicateParam(call, argIndex, services, checker),
    ),
  );
  return check(call.arguments);
};

const isMatchBranchCallee = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.MemberExpression &&
  callee.property.type === AST_NODE_TYPES.Identifier &&
  MATCH_BRANCH_METHODS.has(callee.property.name);

const isLastCallArg = (call: TSESTree.CallExpression, node: TSESTree.Node) =>
  O.exists((last: TSESTree.Node) => last === node)(
    RA.last<TSESTree.CallExpressionArgument>(call.arguments),
  );

const isMatchBranchCall = (node: FunctionNode) =>
  node.parent.type === AST_NODE_TYPES.CallExpression &&
  isMatchBranchCallee(node.parent.callee) &&
  isLastCallArg(node.parent, node);

const resolveEnclosingFunctionNode: (node: TSESTree.Node) => O.Option<FunctionNode> = flow(
  (n: TSESTree.Node) => n.parent,
  O.fromNullable,
  O.flatMap((parent) =>
    isEsTreeFunctionNode(parent) ? O.some(parent) : resolveEnclosingFunctionNode(parent),
  ),
);

const isPipelineCall = (call: TSESTree.CallExpression) =>
  call.callee.type === AST_NODE_TYPES.Identifier && PIPELINE_CALLEES.has(call.callee.name);

const resolvePipeOrFlowParentCall = (node: FunctionNode) =>
  node.parent.type === AST_NODE_TYPES.CallExpression &&
  isPipelineCall(node.parent) &&
  isLastCallArg(node.parent, node)
    ? O.some(node.parent)
    : O.none;

const isPredicateDeclarator = (decl: TSESTree.VariableDeclarator) =>
  decl.id.type === AST_NODE_TYPES.Identifier &&
  (isPredicateName(decl.id.name) || hasPredicateTypeAnnotation(decl.id));

const isInsideExemptedFunction = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) => {
  const check = flow(
    resolveEnclosingFunctionNode,
    O.exists((fn) => isExemptedFunction(fn, services, checker)),
  );
  return check(node);
};

const isCallBoundAsPredicate = (
  call: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive check
): boolean =>
  (call.parent.type === AST_NODE_TYPES.VariableDeclarator && isPredicateDeclarator(call.parent)) ||
  (call.parent.type === AST_NODE_TYPES.CallExpression &&
    isCallPredicateArg(call.parent, call, services, checker)) ||
  (call.callee.type === AST_NODE_TYPES.Identifier &&
    PIPE_CALLEES.has(call.callee.name) &&
    isInsideExemptedFunction(call, services, checker));

const isBoundAsPredicateCallback = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) => {
  const check = flow(
    resolvePipeOrFlowParentCall,
    O.exists((call) => isCallBoundAsPredicate(call, services, checker)),
  );
  return check(node);
};

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
  isBoundAsPredicateCallback(node, services, checker);

const isTypePredicateAnnotation = (ret?: TSESTree.TSTypeAnnotation) =>
  ret?.typeAnnotation.type === AST_NODE_TYPES.TSTypePredicate;

const hasPredicateBindingName = flow(resolveEnclosingBindingName, O.exists(isPredicateName));

const isExemptedFunction = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive check
): boolean =>
  isTypePredicateAnnotation(node.returnType) ||
  hasPredicateBindingName(node) ||
  hasPredicateBindingAnnotation(node) ||
  isInlinePredicateCallback(node, services, checker) ||
  (isMatchBranchCall(node) && isInsideExemptedFunction(node, services, checker));

const hasBooleanReturnType = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) => {
  const check = flow(
    (n: FunctionNode) => services.esTreeNodeToTSNodeMap.get(n),
    (tsNode) => checker.getSignatureFromDeclaration(tsNode),
    O.fromNullable,
    O.map((sig) => checker.getReturnTypeOfSignature(sig)),
    O.exists(isBooleanTsType),
  );
  return check(node);
};

const isPredicateProperty = (prop: TSESTree.TSPropertySignature) =>
  prop.key.type === AST_NODE_TYPES.Identifier && isPredicateName(prop.key.name);

const isPredicatePropertyAnnotation = (ann: TSESTree.TSTypeAnnotation) =>
  ann.parent.type === AST_NODE_TYPES.TSPropertySignature && isPredicateProperty(ann.parent);

const isPredicateTypeAliasParent = (alias: TSESTree.TSTypeAliasDeclaration) =>
  isPredicateTypeAliasName(alias.id.name);

const isExemptedFunctionType = (fnType: TSESTree.TSFunctionType) =>
  isInsideParameterAnnotation(fnType) ||
  (fnType.parent.type === AST_NODE_TYPES.TSTypeAliasDeclaration &&
    isPredicateTypeAliasParent(fnType.parent)) ||
  (fnType.parent.type === AST_NODE_TYPES.TSTypeAnnotation &&
    isPredicatePropertyAnnotation(fnType.parent));

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
) => {
  const check = flow(
    (n: TSESTree.Node) => services.esTreeNodeToTSNodeMap.get(n),
    (tsNode) => services.program.getTypeChecker().getTypeAtLocation(tsNode),
    isBooleanTsType,
  );
  return check(node);
};

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

const buildUnionBooleanListeners = (
  context: Readonly<TSESLint.RuleContext<MessageIds, []>>,
) => {
  const services = ESLintUtils.getParserServices(context);
  const report = (node: TSESTree.Node, messageId: MessageIds) => { context.report({ node, messageId }); };
  const onFunction = (node: FunctionNode) => { checkFunctionNode(node, services, report); };
  return {
    TSBooleanKeyword: (node: TSESTree.TSBooleanKeyword) => { O.map((id: MessageIds) => { report(node, id); })(classifyBooleanKeyword(node)); },
    FunctionDeclaration: onFunction,
    FunctionExpression: onFunction,
    ArrowFunctionExpression: onFunction,
    VariableDeclarator: (node: TSESTree.VariableDeclarator) => { checkVariableDeclarator(node, services, report); },
    AssignmentPattern: (node: TSESTree.AssignmentPattern) => { checkAssignmentPattern(node, services, report); },
  };
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
  create: buildUnionBooleanListeners,
});
