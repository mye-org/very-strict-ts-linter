import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { isPipeCallExpression } from "../lib/pipe-call.js";
import { isCustomHookFn, isHookName } from "../lib/react-hooks.js";
import { resolveCalleeName } from "../lib/reanimated-worklet.js";
import { createRule } from "../lib/rule-factory.js";

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

const THIS_IDENTIFIERS: ReadonlySet<string> = new Set(["this"]);

const isObjectMethodOrAccessor = (node: FunctionNode) =>
  node.type === AST_NODE_TYPES.FunctionExpression &&
  ((node.parent.type === AST_NODE_TYPES.Property &&
    (node.parent.kind === "get" || node.parent.kind === "set" || node.parent.method)) ||
    node.parent.type === AST_NODE_TYPES.MethodDefinition);

const isPlainParam = (param: TSESTree.Parameter) =>
  match(param)
    .with({ type: AST_NODE_TYPES.Identifier }, (p) => !THIS_IDENTIFIERS.has(p.name))
    .with(
      { type: AST_NODE_TYPES.RestElement, argument: { type: AST_NODE_TYPES.Identifier } },
      () => true,
    )
    .with(P._, () => false)
    .exhaustive();

const hasFunctionBody = (node: FunctionNode) => Boolean(node.body);

const isEligibleFunction = (node: FunctionNode) =>
  !node.async &&
  !node.generator &&
  hasFunctionBody(node) &&
  !isObjectMethodOrAccessor(node) &&
  !isCustomHookFn(node) &&
  RA.every(isPlainParam)(node.params);

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
    .with(P._, () => O.none satisfies O.Option<ForwardedCall>)
    .exhaustive();

const extractBlockForwardedCall = (body: TSESTree.BlockStatement) =>
  body.body.length === 1
    ? O.flatMap(matchSingleStatement)(O.fromNullable(body.body[0]))
    : (O.none satisfies O.Option<ForwardedCall>);

const extractForwardedCall = (node: FunctionNode) =>
  match(node.body)
    .with({ type: AST_NODE_TYPES.CallExpression }, (call) =>
      O.some<ForwardedCall>({ call, kind: "return" }),
    )
    .with({ type: AST_NODE_TYPES.BlockStatement }, extractBlockForwardedCall)
    .with(P._, () => O.none satisfies O.Option<ForwardedCall>)
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
  RA.every(
    ([param, arg]: readonly [TSESTree.Parameter, TSESTree.CallExpressionArgument]) =>
      isMatchingParamAndArg(param, arg),
  )(RA.zip(params, args));

const isRangeInside = (inner: TSESTree.Range, outer: TSESTree.Range) =>
  inner[0] >= outer[0] && inner[1] <= outer[1];

const hasReadRefInRange = (
  variable: TSESLint.Scope.Variable,
  targetRange: TSESTree.Range,
) =>
  RA.some(
    (ref: TSESLint.Scope.Reference) =>
      ref.isRead() && isRangeInside(ref.identifier.range, targetRange),
  )(variable.references);

const collectRelevantDeclaredVars = (
  node: FunctionNode,
  sourceCode: Readonly<TSESLint.SourceCode>,
) =>
  node.parent.type === AST_NODE_TYPES.VariableDeclarator
    ? [...sourceCode.getDeclaredVariables(node), ...sourceCode.getDeclaredVariables(node.parent)]
    : sourceCode.getDeclaredVariables(node);

const hasVarRefInCallee = (
  declaredVars: ReadonlyArray<TSESLint.Scope.Variable>,
  callee: TSESTree.Expression,
) => RA.some((v: TSESLint.Scope.Variable) => hasReadRefInRange(v, callee.range))(declaredVars);

const isUnsafeMethodDeclaration = (decl: ts.Declaration) =>
  ts.isMethodSignature(decl) ||
  ts.isMethodDeclaration(decl) ||
  (ts.isPropertyAssignment(decl) && ts.isFunctionExpression(decl.initializer));

const resolveSymbol = (symbol: ts.Symbol, checker: ts.TypeChecker) =>
  symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

const resolveCalleeSymbol =
  (services: ParserServicesWithTypeInformation, checker: ts.TypeChecker) =>
  (callee: TSESTree.Expression) => {
    const resolve = flow(
      (c: TSESTree.Expression) => services.esTreeNodeToTSNodeMap.get(c),
      (tsNode) => checker.getSymbolAtLocation(tsNode),
      O.fromNullable,
    );
    return resolve(callee);
  };

const hasNoUnsafeDeclaration = (decls: ReadonlyArray<ts.Declaration>) =>
  !RA.some(isUnsafeMethodDeclaration)(decls);

const resolveSymbolDeclarations = (checker: ts.TypeChecker) =>
  flow(
    (sym: ts.Symbol) => resolveSymbol(sym, checker).getDeclarations(),
    O.fromNullable,
    O.getOrElse<ReadonlyArray<ts.Declaration>>(() => []),
  );

const isSafeMemberCallee = ({
  callee,
  services,
  checker,
}: Readonly<{
  callee: TSESTree.Expression;
  services: ParserServicesWithTypeInformation;
  checker: ts.TypeChecker;
}>) => {
  const check = flow(
    resolveCalleeSymbol(services, checker),
    O.map(resolveSymbolDeclarations(checker)),
    O.exists(hasNoUnsafeDeclaration),
  );
  return callee.type !== AST_NODE_TYPES.MemberExpression
    ? true
    : !callee.optional && !callee.computed && check(callee);
};

const isRestParameterDecl = (decl: ts.Declaration) =>
  ts.isParameter(decl) && O.isSome(O.fromNullable(decl.dotDotDotToken));

const isRestParamSymbol = flow(
  (sym: ts.Symbol) => sym.valueDeclaration,
  O.fromNullable,
  O.exists(isRestParameterDecl),
);

const hasRestParamNode = flow(
  RA.last<TSESTree.Parameter>,
  O.exists((p) => p.type === AST_NODE_TYPES.RestElement),
);

const hasRestParamSymbol = flow(RA.last<ts.Symbol>, O.exists(isRestParamSymbol));

const hasMatchingArity = (node: FunctionNode, sig: ts.Signature) => {
  const sigParams = sig.getParameters();
  return (
    node.params.length === sigParams.length &&
    hasRestParamNode(node.params) === hasRestParamSymbol(sigParams)
  );
};

const isExplicitThisParameter = (param: ts.ParameterDeclaration, checker: ts.TypeChecker) =>
  ts.isIdentifier(param.name) &&
  THIS_IDENTIFIERS.has(param.name.text) &&
  (checker.getTypeAtLocation(param).flags & ts.TypeFlags.Void) === 0;

const hasNonVoidThisParam = (sig: ts.Signature, checker: ts.TypeChecker) =>
  O.exists(
    (decl: ts.SignatureDeclaration | ts.JSDocSignature) =>
      ts.isFunctionLike(decl) &&
      RA.some((p: ts.ParameterDeclaration) => isExplicitThisParameter(p, checker))(
        decl.parameters,
      ),
  )(O.fromNullable(sig.declaration));

const isVoidReturnCompatible = ({
  kind,
  sig,
  checker,
}: Readonly<{
  kind: ForwardedCall["kind"];
  sig: ts.Signature;
  checker: ts.TypeChecker;
}>) =>
  kind === "return" ||
  (checker.getReturnTypeOfSignature(sig).flags &
    (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) !==
    0;

const hasParamTypeAnnotation = (param: TSESTree.Parameter) =>
  param.type === AST_NODE_TYPES.Identifier
    ? O.isSome(O.fromNullable(param.typeAnnotation))
    : param.type === AST_NODE_TYPES.RestElement && O.isSome(O.fromNullable(param.typeAnnotation));

const hasExplicitTypeAnnotation = (node: FunctionNode) =>
  O.isSome(O.fromNullable(node.typeParameters)) ||
  O.isSome(O.fromNullable(node.returnType)) ||
  RA.some(hasParamTypeAnnotation)(node.params);

const isAnyTsType = (type: ts.Type) => (type.flags & ts.TypeFlags.Any) !== 0;

const zipSignatureParams = (a: ts.Signature, b: ts.Signature) =>
  RA.zip(a.getParameters(), b.getParameters());

const hasAnyLeakage = ({
  wrapperSig,
  calleeSig,
  checker,
}: Readonly<{
  wrapperSig: ts.Signature;
  calleeSig: ts.Signature;
  checker: ts.TypeChecker;
}>) =>
  RA.some(
    ([wp, cp]: readonly [ts.Symbol, ts.Symbol]) =>
      isAnyTsType(checker.getTypeOfSymbol(cp)) && !isAnyTsType(checker.getTypeOfSymbol(wp)),
  )(zipSignatureParams(wrapperSig, calleeSig));

const resolveNodeType = (
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  flow(
    (node: TSESTree.Node) => services.esTreeNodeToTSNodeMap.get(node),
    (tsNode) => checker.getTypeAtLocation(tsNode),
  );

const isMutuallyAssignable = ({
  a,
  b,
  checker,
}: Readonly<{
  a: ts.Type;
  b: ts.Type;
  checker: ts.TypeChecker;
}>) => checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a);

const hasEquivalentAnnotatedType = ({
  node,
  callee,
  services,
  checker,
}: Readonly<{
  node: FunctionNode;
  callee: ResolvedCallee;
  services: ParserServicesWithTypeInformation;
  checker: ts.TypeChecker;
}>) => {
  const wrapperType = resolveNodeType(services, checker)(node);
  return O.exists(
    (wrapperSig: ts.Signature) =>
      !hasAnyLeakage({ wrapperSig, calleeSig: callee.signature, checker }) &&
      isMutuallyAssignable({ a: wrapperType, b: callee.type, checker }),
  )(O.fromNullable(wrapperType.getCallSignatures()[0]));
};

const hasPreservedExplicitSignature = ({
  node,
  callee,
  services,
  checker,
}: Readonly<{
  node: FunctionNode;
  callee: ResolvedCallee;
  services: ParserServicesWithTypeInformation;
  checker: ts.TypeChecker;
}>) =>
  !hasExplicitTypeAnnotation(node) ||
  hasEquivalentAnnotatedType({ node, callee, services, checker });

const hasTypeArguments = flow(
  (call: TSESTree.CallExpression) => call.typeArguments,
  O.fromNullable,
  O.exists((typeArgs) => typeArgs.params.length > 0),
);

const isHookCallee = flow(resolveCalleeName, O.exists(isHookName));

const isValidCallTarget = (call: TSESTree.CallExpression) =>
  !call.optional &&
  !hasTypeArguments(call) &&
  call.callee.type !== AST_NODE_TYPES.Super &&
  !isPipeCall(call) &&
  !isHookCallee(call.callee);

const isSafeCalleeSig = ({
  node,
  forwarded: { call, kind },
  callee,
  services,
  checker,
}: Readonly<{
  node: FunctionNode;
  forwarded: ForwardedCall;
  callee: ResolvedCallee;
  services: ParserServicesWithTypeInformation;
  checker: ts.TypeChecker;
}>) =>
  isSafeMemberCallee({ callee: call.callee, services, checker }) &&
  !hasNonVoidThisParam(callee.signature, checker) &&
  hasMatchingArity(node, callee.signature) &&
  isVoidReturnCompatible({ kind, sig: callee.signature, checker }) &&
  hasPreservedExplicitSignature({ node, callee, services, checker });

const isTypeSafeEtaReduction = ({
  node,
  forwarded,
  services,
  checker,
}: Readonly<{
  node: FunctionNode;
  forwarded: ForwardedCall;
  services: ParserServicesWithTypeInformation;
  checker: ts.TypeChecker;
}>) => {
  const calleeType = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(forwarded.call.callee));
  const sigs = calleeType.getCallSignatures();
  return (
    sigs.length === 1 &&
    O.exists((signature: ts.Signature) =>
      isSafeCalleeSig({ node, forwarded, callee: { type: calleeType, signature }, services, checker }),
    )(O.fromNullable(sigs[0]))
  );
};

const isPointFreeCandidate = ({
  node,
  sourceCode,
  services,
}: Readonly<{
  node: FunctionNode;
  sourceCode: Readonly<TSESLint.SourceCode>;
  services: ParserServicesWithTypeInformation;
}>) =>
  isEligibleFunction(node) &&
  O.exists(
    (forwarded: ForwardedCall) =>
      isValidCallTarget(forwarded.call) &&
      hasMatchingArgsAndParams(node.params, forwarded.call.arguments) &&
      !hasVarRefInCallee(collectRelevantDeclaredVars(node, sourceCode), forwarded.call.callee) &&
      isTypeSafeEtaReduction({ node, forwarded, services, checker: services.program.getTypeChecker() }),
  )(extractForwardedCall(node));

const checkFunction =
  (sourceCode: Readonly<TSESLint.SourceCode>, services: ParserServicesWithTypeInformation) =>
  (report: (n: FunctionNode) => void) =>
  (node: FunctionNode) => {
    match(isPointFreeCandidate({ node, sourceCode, services }))
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
    const onFunction = checkFunction(
      context.sourceCode,
      ESLintUtils.getParserServices(context),
    )((n) => {
      context.report({ node: n, messageId: "preferPointFree" });
    });
    return {
      ArrowFunctionExpression: onFunction,
      FunctionExpression: onFunction,
      FunctionDeclaration: onFunction,
    };
  },
});
