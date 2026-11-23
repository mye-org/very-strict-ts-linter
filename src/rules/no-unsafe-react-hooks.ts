import { AST_NODE_TYPES, ESLintUtils, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { type CheckerContext, toCheckerContext } from "../lib/checker-context.js";
import { isHookCallExpr } from "../lib/react-hooks.js";
import { resolveCalleeName } from "../lib/reanimated-worklet.js";
import { createRule } from "../lib/rule-factory.js";
import { isPrimitiveTsType } from "../lib/ts-primitive-types.js";

type MessageIds =
  | "expressionEffectReturnsPromise"
  | "expressionEffectUnsafeReturn"
  | "unstableHookDependency"
  | "unstableInlineHookDependency";

type EffectHookName = "useEffect" | "useLayoutEffect";
type DepArrayHookName = EffectHookName | "useCallback" | "useMemo";

type Reporter = (d: TSESLint.ReportDescriptor<MessageIds>) => void;

type HookCheckEnv = Readonly<{
  checkerCtx: O.Option<CheckerContext>;
  sourceCode: Readonly<TSESLint.SourceCode>;
  report: Reporter;
}>;

type HookCheckTarget = Readonly<{
  hook: DepArrayHookName;
  env: HookCheckEnv;
}>;

type DepCheckContext = Readonly<{
  hook: DepArrayHookName;
  env: HookCheckEnv;
  scope: TSESLint.Scope.Scope;
}>;

type DepArrayElement = TSESTree.ArrayExpression["elements"][number];

const EFFECT_HOOK_MAP: ReadonlyMap<string, EffectHookName> = new Map([
  ["useEffect", "useEffect"],
  ["useLayoutEffect", "useLayoutEffect"],
]);
const DEP_HOOK_MAP: ReadonlyMap<string, DepArrayHookName> = new Map([
  ["useEffect", "useEffect"],
  ["useLayoutEffect", "useLayoutEffect"],
  ["useCallback", "useCallback"],
  ["useMemo", "useMemo"],
]);
const THENABLE_TYPE_NAMES: ReadonlySet<string> = new Set(["Promise", "PromiseLike"]);
const UNDEFINED_NAMES: ReadonlySet<string> = new Set(["undefined"]);
const UNSTABLE_EXPR_TYPES: ReadonlySet<AST_NODE_TYPES> = new Set([
  AST_NODE_TYPES.ObjectExpression,
  AST_NODE_TYPES.ArrayExpression,
  AST_NODE_TYPES.NewExpression,
  AST_NODE_TYPES.ArrowFunctionExpression,
  AST_NODE_TYPES.FunctionExpression,
]);

const isAnyOrUnknown = (t: ts.Type) => (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
const isVoidOrUndefined = (t: ts.Type) =>
  (t.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0;

const isStrictlyVoidOrUndefined = (t: ts.Type) =>
  isVoidOrUndefined(t) ||
  (t.isUnion() && t.types.length > 0 && RA.every(isVoidOrUndefined)(t.types));

const hasCallableSignature = (t: ts.Type) =>
  t.getCallSignatures().length > 0 ||
  (t.isUnion() && RA.some((m: ts.Type) => m.getCallSignatures().length > 0)(t.types));

const isCallableSymbol = (checker: ts.TypeChecker) =>
  flow((sym: ts.Symbol) => checker.getTypeOfSymbol(sym), hasCallableSignature);

const hasCallableThenProperty = (t: ts.Type, checker: ts.TypeChecker) => {
  const check = flow(
    (type: ts.Type) => checker.getPropertyOfType(type, "then"),
    O.fromNullable,
    O.exists(isCallableSymbol(checker)),
  );
  return check(t);
};

const hasPromiseSymbolName = flow(
  (t: ts.Type) => t.getSymbol(),
  O.fromNullable,
  O.exists((sym: ts.Symbol) => THENABLE_TYPE_NAMES.has(sym.name)),
);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive type check
const isThenableType = (t: ts.Type, checker: ts.TypeChecker): boolean =>
  !isAnyOrUnknown(t) &&
  (hasPromiseSymbolName(t) ||
    hasCallableThenProperty(t, checker) ||
    (t.isUnion() && RA.some((m: ts.Type) => isThenableType(m, checker))(t.types)));

const hasOptionalOrRestSyntax = (param: ts.ParameterDeclaration) =>
  Boolean(param.dotDotDotToken) || Boolean(param.initializer) || Boolean(param.questionToken);

const isOptionalOrRestDecl = (decl: ts.Declaration) =>
  ts.isParameter(decl) && hasOptionalOrRestSyntax(decl);

const isOptionalOrRestParam = (param: ts.Symbol) =>
  (param.flags & ts.SymbolFlags.Optional) !== 0 ||
  O.exists(isOptionalOrRestDecl)(O.fromNullable(param.valueDeclaration));

const isZeroArgVoidCleanupSig = (sig: ts.Signature, checker: ts.TypeChecker) =>
  RA.every(isOptionalOrRestParam)(sig.getParameters()) &&
  isStrictlyVoidOrUndefined(checker.getReturnTypeOfSignature(sig));

const isCleanupFunctionType = (t: ts.Type, checker: ts.TypeChecker) => {
  const sigs = t.getCallSignatures();
  return (
    !isAnyOrUnknown(t) &&
    !isThenableType(t, checker) &&
    sigs.length > 0 &&
    RA.every((sig: ts.Signature) => isZeroArgVoidCleanupSig(sig, checker))(sigs)
  );
};

const isAllowedEffectMember = (t: ts.Type, checker: ts.TypeChecker) =>
  isVoidOrUndefined(t) || isCleanupFunctionType(t, checker);

const isAllowedEffectReturnType = (t: ts.Type, checker: ts.TypeChecker) =>
  t.isUnion()
    ? t.types.length > 0 && RA.every((m: ts.Type) => isAllowedEffectMember(m, checker))(t.types)
    : isAllowedEffectMember(t, checker);

const isUndefinedIdentifier = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.Identifier && UNDEFINED_NAMES.has(expr.name);

const isVoidUnaryExpr = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.UnaryExpression && expr.operator === "void";

const isSyntaxCleanupFn = (expr: TSESTree.Expression) =>
  match(expr)
    .with({ type: AST_NODE_TYPES.ArrowFunctionExpression }, (fn) =>
      !fn.async &&
      fn.params.length === 0 &&
      (fn.body.type === AST_NODE_TYPES.BlockStatement || isUndefinedIdentifier(fn.body)),
    )
    .with(
      { type: AST_NODE_TYPES.FunctionExpression },
      (fn) => !fn.async && fn.params.length === 0,
    )
    .with(P._, () => false)
    .exhaustive();

const isSyntaxAllowedEffectBody = (body: TSESTree.Expression) =>
  isUndefinedIdentifier(body) || isVoidUnaryExpr(body) || isSyntaxCleanupFn(body);

const classifyBodyType = (bodyType: ts.Type, checker: ts.TypeChecker) =>
  match({
    isThenable: isThenableType(bodyType, checker),
    isAllowed: isAllowedEffectReturnType(bodyType, checker),
  })
    .with({ isThenable: true }, () => O.some<MessageIds>("expressionEffectReturnsPromise"))
    .with({ isAllowed: true }, () => O.none satisfies O.Option<MessageIds>)
    .with(P._, () => O.some<MessageIds>("expressionEffectUnsafeReturn"))
    .exhaustive();

const classifyBodyWithChecker = (body: TSESTree.Expression) =>
  flow(
    (ctx: CheckerContext) => ({ bodyType: ctx.resolveType(body), checker: ctx.checker }),
    ({ bodyType, checker }) => classifyBodyType(bodyType, checker),
  );

const classifyEffectReturn = (
  body: TSESTree.Expression,
  checkerCtx: O.Option<CheckerContext>,
) =>
  O.match(
    () =>
      isSyntaxAllowedEffectBody(body)
        ? (O.none satisfies O.Option<MessageIds>)
        : O.some<MessageIds>("expressionEffectUnsafeReturn"),
    classifyBodyWithChecker(body),
  )(checkerCtx);

const checkExpressionArrowEffect = (
  cb: TSESTree.ArrowFunctionExpression,
  { hook, env }: HookCheckTarget,
) => {
  match(cb.body)
    .with({ type: AST_NODE_TYPES.BlockStatement }, () => {})
    .with(P._, (body) => {
      O.map((messageId: MessageIds) => {
        env.report({ node: cb, messageId, data: { hook } });
      })(
        cb.async
          ? O.some<MessageIds>("expressionEffectReturnsPromise")
          : classifyEffectReturn(body, env.checkerCtx),
      );
    })
    .exhaustive();
};

const extractArrowArg = (arg: TSESTree.CallExpressionArgument) =>
  arg.type === AST_NODE_TYPES.ArrowFunctionExpression ? O.some(arg) : O.none;

const extractFirstArrowArg = flow(
  RA.head<TSESTree.CallExpressionArgument>,
  O.flatMap(extractArrowArg),
);

const checkExpressionEffectCallback = (
  node: TSESTree.CallExpression,
  target: HookCheckTarget,
) => {
  O.map((cb: TSESTree.ArrowFunctionExpression) => { checkExpressionArrowEffect(cb, target); })(
    extractFirstArrowArg(node.arguments),
  );
};

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST unwrap
const unwrapTsExpression = (expr: TSESTree.Expression): TSESTree.Expression =>
  match(expr)
    .with(
      { type: AST_NODE_TYPES.TSAsExpression },
      { type: AST_NODE_TYPES.TSSatisfiesExpression },
      { type: AST_NODE_TYPES.TSNonNullExpression },
      { type: AST_NODE_TYPES.TSTypeAssertion },
      (e) => unwrapTsExpression(e.expression),
    )
    .with(P._, () => expr)
    .exhaustive();

const isPrimitiveInContext = (node: TSESTree.Node) =>
  flow((ctx: CheckerContext) => ctx.resolveType(node), isPrimitiveTsType);

const isKnownPrimitiveNode = (node: TSESTree.Node, checkerCtx: O.Option<CheckerContext>) =>
  O.exists(isPrimitiveInContext(node))(checkerCtx);

const isUnstableCallResult = (
  expr: TSESTree.Expression,
  typedNode: TSESTree.Node,
  checkerCtx: O.Option<CheckerContext>,
) =>
  expr.type === AST_NODE_TYPES.CallExpression &&
  !isHookCallExpr(O.some(expr)) &&
  !isKnownPrimitiveNode(typedNode, checkerCtx);

const isUnstableRenderValue = (
  expr: TSESTree.Expression,
  typedNode: TSESTree.Node,
  checkerCtx: O.Option<CheckerContext>,
) => {
  const unwrapped = unwrapTsExpression(expr);
  return (
    UNSTABLE_EXPR_TYPES.has(unwrapped.type) ||
    isUnstableCallResult(unwrapped, typedNode, checkerCtx)
  );
};

const lookupUpperScope = (scope: TSESLint.Scope.Scope, name: string) =>
  O.flatMap((upper: TSESLint.Scope.Scope) => findVariableInScope(upper, name))(
    O.fromNullable(scope.upper),
  );

const lookupScopeSymbol = (scope: TSESLint.Scope.Scope, name: string) =>
  O.fromNullable(scope.set.get(name));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive scope lookup
const findVariableInScope = (scope: TSESLint.Scope.Scope, name: string): O.Option<TSESLint.Scope.Variable> =>
  O.alt(() => lookupUpperScope(scope, name))(lookupScopeSymbol(scope, name));

const extractVarScope = (variable: TSESLint.Scope.Variable) => variable.scope.variableScope;
const isFunctionScopeType = (scope: TSESLint.Scope.Scope) =>
  scope.type === TSESLint.Scope.ScopeType.function;

const isFunctionScopedVariable = flow(extractVarScope, isFunctionScopeType);

const isIdentifierDeclarator = (decl: TSESTree.VariableDeclarator) =>
  decl.id.type === AST_NODE_TYPES.Identifier;

const extractDirectDeclaratorInit = (def: TSESLint.Scope.Definition) =>
  def.type === TSESLint.Scope.DefinitionType.Variable && isIdentifierDeclarator(def.node)
    ? O.fromNullable(def.node.init)
    : O.none;

const extractRenderTimeVarInit = (variable: TSESLint.Scope.Variable) =>
  isFunctionScopedVariable(variable)
    ? O.flatMap(extractDirectDeclaratorInit)(RA.head<TSESLint.Scope.Definition>(variable.defs))
    : O.none;

const extractUnstableVarInit = (id: TSESTree.Identifier, ctx: DepCheckContext) =>
  flow(
    extractRenderTimeVarInit,
    O.filter((init) => isUnstableRenderValue(init, id, ctx.env.checkerCtx)),
  );

const checkIdentifierDependency = (id: TSESTree.Identifier, ctx: DepCheckContext) => {
  const reportIfUnstable = flow(
    O.flatMap(extractUnstableVarInit(id, ctx)),
    O.map(() => {
      ctx.env.report({
        node: id,
        messageId: "unstableHookDependency",
        data: { name: id.name, hook: ctx.hook },
      });
    }),
  );
  reportIfUnstable(findVariableInScope(ctx.scope, id.name));
};

const checkInlineDependency = (
  unwrapped: TSESTree.Expression,
  expr: TSESTree.Expression,
  { hook, env }: DepCheckContext,
) => {
  match(isUnstableRenderValue(unwrapped, expr, env.checkerCtx))
    .with(true, () => {
      env.report({ node: expr, messageId: "unstableInlineHookDependency", data: { hook } });
    })
    .with(false, () => {})
    .exhaustive();
};

const checkDependencyExpr = (expr: TSESTree.Expression, ctx: DepCheckContext) => {
  match(unwrapTsExpression(expr))
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => {
      checkIdentifierDependency(id, ctx);
    })
    .with(P._, (other) => {
      checkInlineDependency(other, expr, ctx);
    })
    .exhaustive();
};

const isNonSpreadElement = (e: NonNullable<DepArrayElement>): e is TSESTree.Expression =>
  e.type !== AST_NODE_TYPES.SpreadElement;

const extractDepExpr = flow(O.fromNullable<DepArrayElement>, O.filter(isNonSpreadElement));

const checkDependencyElements = (
  elements: ReadonlyArray<DepArrayElement>,
  depCtx: DepCheckContext,
) => {
  RA.map((expr: TSESTree.Expression) => { checkDependencyExpr(expr, depCtx); })(
    RA.filterMap(extractDepExpr)(elements),
  );
};

const extractArrayArg = (arg: TSESTree.CallExpressionArgument) =>
  arg.type === AST_NODE_TYPES.ArrayExpression ? O.some(arg) : O.none;

const lookupSecondArg = (args: ReadonlyArray<TSESTree.CallExpressionArgument>) =>
  RA.lookup(1)(args);

const extractSecondArrayArg = flow(lookupSecondArg, O.flatMap(extractArrayArg));

const checkHookDependencyArray = (
  node: TSESTree.CallExpression,
  { hook, env }: HookCheckTarget,
) => {
  O.map((deps: TSESTree.ArrayExpression) => {
    checkDependencyElements(deps.elements, { hook, env, scope: env.sourceCode.getScope(node) });
  })(extractSecondArrayArg(node.arguments));
};

const lookupEffectHook = flow((name: string) => EFFECT_HOOK_MAP.get(name), O.fromNullable);
const lookupDepHook = flow((name: string) => DEP_HOOK_MAP.get(name), O.fromNullable);

const checkHookCall = (node: TSESTree.CallExpression, env: HookCheckEnv) => {
  O.map((name: string) => {
    O.map((hook: EffectHookName) => {
      checkExpressionEffectCallback(node, { hook, env });
    })(lookupEffectHook(name));
    O.map((hook: DepArrayHookName) => {
      checkHookDependencyArray(node, { hook, env });
    })(lookupDepHook(name));
  })(resolveCalleeName(node.callee));
};

const buildHookListeners = (env: HookCheckEnv) => ({
  CallExpression: (node: TSESTree.CallExpression) => { checkHookCall(node, env); },
});

export const noUnsafeReactHooks = createRule<[], MessageIds>({
  name: "no-unsafe-react-hooks",
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid unsafe expression-bodied useEffect/useLayoutEffect return values (such as Promises or non-cleanup values) and unmemoized render-time object literals or call results in React hook dependency arrays.",
    },
    messages: {
      expressionEffectReturnsPromise:
        "`{{hook}}` expression-bodied callback returns a Promise/thenable. React effects must return `void`/`undefined` or a cleanup function `() => void`; use a block body `{ void fn(); }` for side-effect-only effects.",
      expressionEffectUnsafeReturn:
        "`{{hook}}` expression-bodied callback must return strictly `void`/`undefined` or a cleanup function `() => void`. Use a block body `{ fn(); }` for side-effect-only effects.",
      unstableHookDependency:
        "Unmemoized render-time value `{{name}}` passed directly into `{{hook}}` dependency array changes identity on every render. Wrap it in `useMemo` or depend on primitive values instead.",
      unstableInlineHookDependency:
        "Unmemoized render-time expression passed directly into `{{hook}}` dependency array changes identity on every render. Wrap it in `useMemo` or depend on primitive values instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) =>
    buildHookListeners({
      checkerCtx: toCheckerContext(ESLintUtils.getParserServices(context, true)),
      sourceCode: context.sourceCode,
      report: (d) => { context.report(d); },
    }),
});
