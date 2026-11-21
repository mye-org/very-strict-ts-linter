import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../utils/create-rule.js";
import { isPipeCallExpression } from "../utils/type-helpers.js";

type MessageIds = "preferPointFree";

type FunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionExpression
  | TSESTree.FunctionDeclaration;

type ForwardedCall = Readonly<{
  call: TSESTree.CallExpression;
  kind: "return" | "void";
}>;

type ResolvedCallee = Readonly<{
  type: ts.Type;
  signature: ts.Signature;
}>;

const isObjectMethodOrAccessor = (node: FunctionNode) =>
  node.type === AST_NODE_TYPES.FunctionExpression &&
  ((node.parent.type === AST_NODE_TYPES.Property &&
    (node.parent.kind === "get" || node.parent.kind === "set" || node.parent.method)) ||
    node.parent.type === AST_NODE_TYPES.MethodDefinition);

const isPlainParam = (param: TSESTree.Parameter) =>
  (param.type === AST_NODE_TYPES.Identifier && param.name !== "this") ||
  (param.type === AST_NODE_TYPES.RestElement && param.argument.type === AST_NODE_TYPES.Identifier);

const isEligibleFunction = (node: FunctionNode) =>
  !node.async &&
  !node.generator &&
  Boolean(node.body) &&
  !isObjectMethodOrAccessor(node) &&
  pipe(node.params, RA.every(isPlainParam));

const matchSingleStatement = (stmt: TSESTree.Statement) =>
  match(stmt)
    .with(
      { type: AST_NODE_TYPES.ReturnStatement, argument: { type: AST_NODE_TYPES.CallExpression } },
      (s) => O.some<ForwardedCall>({ call: s.argument, kind: "return" }),
    )
    .with(
      { type: AST_NODE_TYPES.ExpressionStatement, expression: { type: AST_NODE_TYPES.CallExpression } },
      (s) => O.some<ForwardedCall>({ call: s.expression, kind: "void" }),
    )
    .with(P._, () => O.none as O.Option<ForwardedCall>)
    .exhaustive();

const getBlockForwardedCall = (body: TSESTree.BlockStatement) =>
  body.body.length === 1
    ? pipe(O.fromNullable(body.body[0]), O.flatMap(matchSingleStatement))
    : (O.none as O.Option<ForwardedCall>);

const getForwardedCall = (node: FunctionNode) =>
  match(node.body)
    .with({ type: AST_NODE_TYPES.CallExpression }, (call) =>
      O.some<ForwardedCall>({ call, kind: "return" }),
    )
    .with({ type: AST_NODE_TYPES.BlockStatement }, getBlockForwardedCall)
    .with(P._, () => O.none as O.Option<ForwardedCall>)
    .exhaustive();

const isPipeCall = isPipeCallExpression;

const isMatchingParamAndArg = (param: TSESTree.Parameter, arg: TSESTree.CallExpressionArgument) =>
  match([param, arg] as const)
    .with(
      [{ type: AST_NODE_TYPES.Identifier }, { type: AST_NODE_TYPES.Identifier }],
      ([p, a]) => p.name === a.name,
    )
    .with(
      [
        { type: AST_NODE_TYPES.RestElement, argument: { type: AST_NODE_TYPES.Identifier } },
        { type: AST_NODE_TYPES.SpreadElement, argument: { type: AST_NODE_TYPES.Identifier } },
      ],
      ([p, a]) => p.argument.name === a.argument.name,
    )
    .otherwise(() => false);

const hasMatchingArgsAndParams = (
  params: ReadonlyArray<TSESTree.Parameter>,
  args: ReadonlyArray<TSESTree.CallExpressionArgument>,
) =>
  params.length === args.length &&
  pipe(
    RA.zip(params, args),
    RA.every(([param, arg]) => isMatchingParamAndArg(param, arg)),
  );

const isRangeInside = (inner: TSESTree.Range, outer: TSESTree.Range) =>
  inner[0] >= outer[0] && inner[1] <= outer[1];

const hasReadRefInRange = (
  variable: TSESLint.Scope.Variable,
  targetRange: TSESTree.Range,
) =>
  pipe(
    variable.references,
    RA.some((ref) => ref.isRead() && isRangeInside(ref.identifier.range, targetRange)),
  );

const getRelevantDeclaredVars = (
  node: FunctionNode,
  sourceCode: Readonly<TSESLint.SourceCode>,
) =>
  node.parent.type === AST_NODE_TYPES.VariableDeclarator
    ? [...sourceCode.getDeclaredVariables(node), ...sourceCode.getDeclaredVariables(node.parent)]
    : sourceCode.getDeclaredVariables(node);

const hasVarRefInCallee = (
  node: FunctionNode,
  callee: TSESTree.Expression,
  sourceCode: Readonly<TSESLint.SourceCode>,
) =>
  pipe(
    getRelevantDeclaredVars(node, sourceCode),
    RA.some((v) => hasReadRefInRange(v, callee.range)),
  );

const isUnsafeMethodDeclaration = (decl: ts.Declaration) =>
  ts.isMethodSignature(decl) ||
  ts.isMethodDeclaration(decl) ||
  (ts.isPropertyAssignment(decl) && ts.isFunctionExpression(decl.initializer));

const resolveSymbol = (symbol: ts.Symbol, checker: ts.TypeChecker) =>
  symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

const getCalleeSymbol = (
  callee: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  pipe(
    services.esTreeNodeToTSNodeMap.get(callee),
    (tsNode) => checker.getSymbolAtLocation(tsNode),
    O.fromNullable,
  );

const isSafeMemberCallee = (
  callee: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  callee.type !== AST_NODE_TYPES.MemberExpression
    ? true
    : !callee.optional &&
      !callee.computed &&
      pipe(
        getCalleeSymbol(callee, services, checker),
        O.map((sym) => resolveSymbol(sym, checker)),
        O.map((sym) => sym.getDeclarations() ?? []),
        O.exists((decls) => !pipe(decls, RA.some(isUnsafeMethodDeclaration))),
      );

const isRestParamSymbol = (sym: ts.Symbol) =>
  Boolean(
    sym.valueDeclaration &&
      ts.isParameter(sym.valueDeclaration) &&
      sym.valueDeclaration.dotDotDotToken,
  );

const hasRestParamNode = (params: ReadonlyArray<TSESTree.Parameter>) =>
  pipe(
    RA.last(params),
    O.exists((p) => p.type === AST_NODE_TYPES.RestElement),
  );

const hasMatchingArity = (node: FunctionNode, sig: ts.Signature) => {
  const sigParams = sig.getParameters();
  return (
    node.params.length === sigParams.length &&
    hasRestParamNode(node.params) === pipe(RA.last(sigParams), O.exists(isRestParamSymbol))
  );
};

const isExplicitThisParameter = (param: ts.ParameterDeclaration, checker: ts.TypeChecker) =>
  ts.isIdentifier(param.name) &&
  param.name.text === "this" &&
  !(checker.getTypeAtLocation(param).flags & ts.TypeFlags.Void);

const hasNonVoidThisParam = (sig: ts.Signature, checker: ts.TypeChecker) =>
  Boolean(
    sig.declaration &&
      ts.isFunctionLike(sig.declaration) &&
      pipe(
        sig.declaration.parameters,
        RA.some((p) => isExplicitThisParameter(p, checker)),
      ),
  );

const isVoidReturnCompatible = (
  kind: ForwardedCall["kind"],
  sig: ts.Signature,
  checker: ts.TypeChecker,
) =>
  kind === "return" ||
  Boolean(
    checker.getReturnTypeOfSignature(sig).flags &
      (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never),
  );

const hasParamTypeAnnotation = (param: TSESTree.Parameter) =>
  param.type === AST_NODE_TYPES.Identifier
    ? Boolean(param.typeAnnotation)
    : param.type === AST_NODE_TYPES.RestElement && Boolean(param.typeAnnotation);

const hasExplicitTypeInfo = (node: FunctionNode) =>
  Boolean(node.typeParameters || node.returnType || pipe(node.params, RA.some(hasParamTypeAnnotation)));

const hasAnyLeakage = (wrapperSig: ts.Signature, calleeSig: ts.Signature, checker: ts.TypeChecker) =>
  pipe(
    RA.zip(wrapperSig.getParameters(), calleeSig.getParameters()),
    RA.some(
      ([wp, cp]) =>
        Boolean(checker.getTypeOfSymbol(cp).flags & ts.TypeFlags.Any) &&
        !(checker.getTypeOfSymbol(wp).flags & ts.TypeFlags.Any),
    ),
  );

const getNodeType = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) => checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));

const isMutuallyAssignable = (a: ts.Type, b: ts.Type, checker: ts.TypeChecker) =>
  checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a);

const hasEquivalentAnnotatedType = (
  node: FunctionNode,
  callee: ResolvedCallee,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) => {
  const wrapperType = getNodeType(node, services, checker);
  return pipe(
    O.fromNullable(wrapperType.getCallSignatures()[0]),
    O.exists(
      (wrapperSig) =>
        !hasAnyLeakage(wrapperSig, callee.signature, checker) &&
        isMutuallyAssignable(wrapperType, callee.type, checker),
    ),
  );
};

const hasPreservedExplicitSignature = (
  node: FunctionNode,
  callee: ResolvedCallee,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  !hasExplicitTypeInfo(node) ||
  hasEquivalentAnnotatedType(node, callee, services, checker);

const isValidCallTarget = (call: TSESTree.CallExpression) =>
  !call.optional &&
  !call.typeArguments?.params.length &&
  call.callee.type !== AST_NODE_TYPES.Super &&
  !isPipeCall(call);

const isSafeCalleeSig = (
  node: FunctionNode,
  { call, kind }: ForwardedCall,
  callee: ResolvedCallee,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  isSafeMemberCallee(call.callee, services, checker) &&
  !hasNonVoidThisParam(callee.signature, checker) &&
  hasMatchingArity(node, callee.signature) &&
  isVoidReturnCompatible(kind, callee.signature, checker) &&
  hasPreservedExplicitSignature(node, callee, services, checker);

const isTypeSafeEtaReduction = (
  node: FunctionNode,
  forwarded: ForwardedCall,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) => {
  const calleeType = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(forwarded.call.callee));
  const sigs = calleeType.getCallSignatures();
  return (
    sigs.length === 1 &&
    pipe(
      O.fromNullable(sigs[0]),
      O.exists((signature) => isSafeCalleeSig(node, forwarded, { type: calleeType, signature }, services, checker)),
    )
  );
};

const isPointFreeCandidate = (
  node: FunctionNode,
  sourceCode: Readonly<TSESLint.SourceCode>,
  services: ParserServicesWithTypeInformation,
) =>
  isEligibleFunction(node) &&
  pipe(
    getForwardedCall(node),
    O.exists(
      (forwarded) =>
        isValidCallTarget(forwarded.call) &&
        hasMatchingArgsAndParams(node.params, forwarded.call.arguments) &&
        !hasVarRefInCallee(node, forwarded.call.callee, sourceCode) &&
        isTypeSafeEtaReduction(node, forwarded, services, services.program.getTypeChecker()),
    ),
  );

const checkFunction = (
  node: FunctionNode,
  sourceCode: Readonly<TSESLint.SourceCode>,
  services: ParserServicesWithTypeInformation,
  report: (n: FunctionNode) => void,
) => {
  match(isPointFreeCandidate(node, sourceCode, services))
    .with(true, () => { report(node); })
    .with(false, () => {})
    .exhaustive();
};

export const preferPointFree = createRule<[], MessageIds>({
  name: "prefer-point-free",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Encourage point-free style by flagging wrapper functions that only forward their parameters to a single function call.",
    },
    messages: {
      preferPointFree:
        "Avoid unnecessary wrapper function; pass the called function directly in point-free style.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const onFunction = (node: FunctionNode) => {
      checkFunction(node, context.sourceCode, ESLintUtils.getParserServices(context), (n) => {
        context.report({ node: n, messageId: "preferPointFree" });
      });
    };
    return {
      ArrowFunctionExpression: onFunction,
      FunctionExpression: onFunction,
      FunctionDeclaration: onFunction,
    };
  },
});
