import { AST_NODE_TYPES, ESLintUtils, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { type CheckerContext, toCheckerContext } from "../lib/checker-context.js";
import { collectEstreeChildNodes } from "../lib/estree-children.js";
import { isEsTreeFunctionNode } from "../lib/estree-function-nodes.js";
import { isCustomHookFn, isHookCallExpr, isHookName } from "../lib/react-hooks.js";
import {
  isScheduleOnRnCall,
  isWorkletFunction,
  resolveCalleeName,
} from "../lib/reanimated-worklet.js";
import { createRule } from "../lib/rule-factory.js";
import { isPrimitiveTsType } from "../lib/ts-primitive-types.js";
import { resolveDirectFunctionName } from "../lib/unsafe-function-scope.js";

type Options = [
  Readonly<
    Record<
      | "maxLogicLines"
      | "maxLogicStatements"
      | "maxHookBodyLines"
      | "maxHandlerLines"
      | "maxDerivedConsts",
      number
    >
  >,
];

type MessageIds =
  | "nonJsxHelperInTsx"
  | "forbiddenControlFlow"
  | "forbiddenNestedTernary"
  | "nonJsxArrayTransform"
  | "tooManyLogicStatements"
  | "tooManyLogicLines"
  | "tooManyDerivedConsts"
  | "noViewDestructuring"
  | "fatHookCallback"
  | "fatJsxHandler";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

type AnonFunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionExpression;

type Reporter = (d: TSESLint.ReportDescriptor<MessageIds>) => void;

const SIZED_HOOKS: ReadonlySet<string> = new Set([
  "useEffect",
  "useLayoutEffect",
  "useMemo",
  "useCallback",
]);
const MATCH_CHAIN_METHODS: ReadonlySet<string> = new Set(["exhaustive", "otherwise", "with"]);
const MATCH_BRANCH_METHODS: ReadonlySet<string> = new Set(["with", "otherwise"]);
const MAP_METHODS: ReadonlySet<string> = new Set(["map"]);
const ARRAY_TRANSFORM_METHODS: ReadonlySet<string> = new Set([
  "map",
  "filter",
  "reduce",
  "reduceRight",
  "sort",
  "toSorted",
  "flatMap",
  "every",
  "some",
  "find",
  "findIndex",
]);

const DEFAULT_OPTIONS: Options[0] = {
  maxLogicLines: 15,
  maxLogicStatements: 10,
  maxHookBodyLines: 3,
  maxHandlerLines: 3,
  maxDerivedConsts: 1,
};

const ANON_FN_TYPES: ReadonlySet<AST_NODE_TYPES> = new Set<AST_NODE_TYPES>([
  AST_NODE_TYPES.ArrowFunctionExpression,
  AST_NODE_TYPES.FunctionExpression,
]);

const toDecimalText = (value: number) => String(value);
const isTsxFilename = (filename: string) => filename.endsWith(".tsx");

const isAnonFn = (node: TSESTree.Node): node is AnonFunctionNode =>
  ANON_FN_TYPES.has(node.type);

const extractMemberPropName = (expr: TSESTree.Expression) =>
  match(expr)
    .with(
      { type: AST_NODE_TYPES.MemberExpression, property: { type: AST_NODE_TYPES.Identifier } },
      (member) => O.some(member.property.name),
    )
    .with(P._, () => O.none)
    .exhaustive();

const FP_TS_NAMESPACE_NAMES: ReadonlySet<string> = new Set([
  "O",
  "E",
  "RA",
  "RR",
  "RNEA",
  "A",
  "R",
  "T",
  "TE",
  "IO",
  "IOE",
  "RE",
  "RTE",
  "RT",
]);

const isJsxNode = (e: TSESTree.Expression) =>
  e.type === AST_NODE_TYPES.JSXElement || e.type === AST_NODE_TYPES.JSXFragment;

const extractMatchChainReceiver = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.MemberExpression &&
  !callee.computed &&
  callee.property.type === AST_NODE_TYPES.Identifier &&
  MATCH_CHAIN_METHODS.has(callee.property.name)
    ? O.some(callee.object)
    : O.none;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST predicate
const isMatchReturningJsx = (e: TSESTree.Expression): boolean =>
  e.type === AST_NODE_TYPES.CallExpression &&
  O.exists(
    (receiver: TSESTree.Expression) =>
      RA.some((arg: TSESTree.CallExpressionArgument) => isAnonFn(arg) && isJsxReturningFn(arg))(
        e.arguments,
      ) || isMatchReturningJsx(receiver),
  )(extractMatchChainReceiver(e.callee));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST predicate
const isJsxExpr = (expr: O.Option<TSESTree.Expression>): boolean =>
  O.exists(
    (e: TSESTree.Expression) =>
      isJsxNode(e) ||
      isMatchReturningJsx(e) ||
      (e.type === AST_NODE_TYPES.ConditionalExpression &&
        (isJsxExpr(O.some(e.consequent)) || isJsxExpr(O.some(e.alternate)))) ||
      (e.type === AST_NODE_TYPES.LogicalExpression &&
        (isJsxExpr(O.some(e.left)) || isJsxExpr(O.some(e.right)))),
  )(expr);

const isJsxReturningBlock = (block: TSESTree.BlockStatement) =>
  RA.some(
    (stmt: TSESTree.Statement) =>
      stmt.type === AST_NODE_TYPES.ReturnStatement &&
      isJsxExpr(O.fromNullable(stmt.argument)),
  )(block.body);

const isJsxReturningFn = (node: FunctionNode) =>
  node.body.type === AST_NODE_TYPES.BlockStatement
    ? isJsxReturningBlock(node.body)
    : isJsxExpr(O.some(node.body));

const isInsideJsxExpr: Pred.Predicate<TSESTree.Node> = flow(
  (n: TSESTree.Node) => n.parent,
  O.fromNullable,
  O.exists((p) => (p.type === AST_NODE_TYPES.JSXExpressionContainer ? true : isInsideJsxExpr(p))),
);

const isJsxAttrContainer = (parent: TSESTree.Node) =>
  parent.type === AST_NODE_TYPES.JSXExpressionContainer &&
  parent.parent.type === AST_NODE_TYPES.JSXAttribute;

const isJsxAttrCallback = ({ parent }: FunctionNode) => isJsxAttrContainer(parent);

const isHookCallee = flow(resolveCalleeName, O.exists(isHookName));

const isHookCallbackArg = (node: FunctionNode) =>
  node.parent.type === AST_NODE_TYPES.CallExpression && isHookCallee(node.parent.callee);

const isMatchBranchCallee = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.MemberExpression &&
  !callee.computed &&
  callee.property.type === AST_NODE_TYPES.Identifier &&
  MATCH_BRANCH_METHODS.has(callee.property.name);

const isMatchBranchCallback = ({ parent }: FunctionNode) =>
  parent.type === AST_NODE_TYPES.CallExpression && isMatchBranchCallee(parent.callee);

const extractStartLine = ({ loc }: TSESTree.Node) => loc.start.line;
const extractEndLine = ({ loc }: TSESTree.Node) => loc.end.line;
const measureLineSpan = (node: TSESTree.Node) => extractEndLine(node) - extractStartLine(node) + 1;
const measureStatementSpan = (first: TSESTree.Statement, last: TSESTree.Statement) =>
  extractEndLine(last) - extractStartLine(first) + 1;

const checkPreReturnLineCount =
  (maxLines: number, report: Reporter) =>
  (stmts: ReadonlyArray<TSESTree.Statement>, body: TSESTree.BlockStatement) => {
    const check = flow(
      O.apS("first", RA.head(stmts)),
      O.apS("last", RA.last(stmts)),
      O.map(({ first, last }) => measureStatementSpan(first, last)),
      O.filter((lines) => lines > maxLines),
      O.map((lines) => {
        report({
          node: body,
          messageId: "tooManyLogicLines",
          data: { actual: toDecimalText(lines), max: toDecimalText(maxLines) },
        });
      }),
    );
    check(O.Do);
  };

const toLogicBudgetDescriptor =
  (body: TSESTree.BlockStatement) =>
  (actual: number, max: number) => ({
    node: body,
    messageId: "tooManyLogicStatements" as const,
    data: { actual: toDecimalText(actual), max: toDecimalText(max) },
  });

const checkPreReturnBudget =
  (opts: Options[0], report: Reporter) =>
  (body: TSESTree.BlockStatement) => {
    const stmts = RA.takeLeftWhile(
      (s: TSESTree.Statement) => s.type !== AST_NODE_TYPES.ReturnStatement,
    )(body.body);
    match(stmts.length > opts.maxLogicStatements)
      .with(true, () => {
        report(toLogicBudgetDescriptor(body)(stmts.length, opts.maxLogicStatements));
      })
      .with(false, () => {})
      .exhaustive();
    checkPreReturnLineCount(opts.maxLogicLines, report)(stmts, body);
  };

type TsxCheckEnv = {
  readonly opts: Options[0];
  readonly report: Reporter;
  readonly visitorKeys: TSESLint.SourceCode["visitorKeys"];
  readonly scheduleOnRnTargets: ReadonlySet<string>;
  readonly checkerCtx: O.Option<CheckerContext>;
};

const isJsxHelperInit = flow(O.filter(isAnonFn), O.exists(isJsxReturningFn));

const RUN_ON_JS_NAMES: ReadonlySet<string> = new Set(["runOnJS"]);
const USE_MEMO_NAMES: ReadonlySet<string> = new Set(["useMemo"]);

const isJsBridgeCall = (node: TSESTree.CallExpression) =>
  isScheduleOnRnCall(node) ||
  O.exists((name: string) => RUN_ON_JS_NAMES.has(name))(resolveCalleeName(node.callee));

const extractFirstIdentifierArg = flow(
  (args: ReadonlyArray<TSESTree.CallExpressionArgument>) => args[0],
  O.fromNullable,
  O.filter((arg): arg is TSESTree.Identifier => arg.type === AST_NODE_TYPES.Identifier),
  O.match(
    () => [] satisfies ReadonlyArray<string>,
    (id) => [id.name],
  ),
);

const extractBridgeTargetName = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.CallExpression && isJsBridgeCall(node)
    ? extractFirstIdentifierArg(node.arguments)
    : ([] satisfies ReadonlyArray<string>);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const collectBridgeTargetList = (node: TSESTree.Node, visitorKeys: TSESLint.SourceCode["visitorKeys"]): ReadonlyArray<string> => [
  ...extractBridgeTargetName(node),
  ...RA.flatMap((child: TSESTree.Node) => collectBridgeTargetList(child, visitorKeys))(
    collectEstreeChildNodes(node, visitorKeys),
  ),
];

const collectScheduleOnRnTargets = (
  ast: TSESTree.Program,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) => new Set<string>(collectBridgeTargetList(ast, visitorKeys));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const hasWorkletDescendant = (node: TSESTree.Node, visitorKeys: TSESLint.SourceCode["visitorKeys"]): boolean =>
  (isEsTreeFunctionNode(node) && isWorkletFunction(node)) ||
  RA.some((child: TSESTree.Node) => hasWorkletDescendant(child, visitorKeys))(
    collectEstreeChildNodes(node, visitorKeys),
  );

const isWorkletOrGestureInit = (
  init: O.Option<TSESTree.Expression>,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) => O.exists((expr: TSESTree.Expression) => hasWorkletDescendant(expr, visitorKeys))(init);

const isNonRefPropertyKey = (id: TSESTree.Identifier) =>
  id.parent.type === AST_NODE_TYPES.Property &&
  id.parent.key === id &&
  !id.parent.computed &&
  !id.parent.shorthand;

const isNonComputedMemberProp = (id: TSESTree.Identifier) =>
  id.parent.type === AST_NODE_TYPES.MemberExpression &&
  id.parent.property === id &&
  !id.parent.computed;

const isIdentifierValueRef = (node: TSESTree.Node): node is TSESTree.Identifier =>
  node.type === AST_NODE_TYPES.Identifier &&
  !isNonRefPropertyKey(node) &&
  !isNonComputedMemberProp(node);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const collectIdentifierRefs = (node: TSESTree.Node, visitorKeys: TSESLint.SourceCode["visitorKeys"]): ReadonlyArray<string> => [
  ...(isIdentifierValueRef(node) ? [node.name] : []),
  ...RA.flatMap((child: TSESTree.Node) => collectIdentifierRefs(child, visitorKeys))(
    collectEstreeChildNodes(node, visitorKeys),
  ),
];

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const collectWorkletRefList = (node: TSESTree.Node, visitorKeys: TSESLint.SourceCode["visitorKeys"]): ReadonlyArray<string> =>
  isEsTreeFunctionNode(node) && isWorkletFunction(node)
    ? collectIdentifierRefs(node.body, visitorKeys)
    : RA.flatMap((child: TSESTree.Node) => collectWorkletRefList(child, visitorKeys))(
        collectEstreeChildNodes(node, visitorKeys),
      );

const collectWorkletCapturedNames = (block: TSESTree.BlockStatement, env: TsxCheckEnv) =>
  new Set<string>(collectWorkletRefList(block, env.visitorKeys));

const extractObjectPropNode = (prop: TSESTree.Property | TSESTree.RestElement) =>
  prop.type === AST_NODE_TYPES.RestElement ? prop.argument : prop.value;

const extractArrayPatternEl = flow(
  O.fromNullable<TSESTree.ArrayPattern["elements"][number]>,
  O.match(
    () => [] satisfies ReadonlyArray<TSESTree.Node>,
    (el) => [el] satisfies ReadonlyArray<TSESTree.Node>,
  ),
);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive pattern walk
const extractBoundNames = (pattern: TSESTree.Node): ReadonlyArray<string> =>
  match(pattern)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => [id.name])
    .with({ type: AST_NODE_TYPES.ObjectPattern }, (obj) =>
      RA.flatMap(flow(extractObjectPropNode, extractBoundNames))(obj.properties),
    )
    .with({ type: AST_NODE_TYPES.ArrayPattern }, (arr) =>
      RA.flatMap(flow(extractArrayPatternEl, RA.flatMap(extractBoundNames)))(arr.elements),
    )
    .with({ type: AST_NODE_TYPES.AssignmentPattern }, (a) => extractBoundNames(a.left))
    .with(P._, () => [] satisfies ReadonlyArray<string>)
    .exhaustive();

const isClosureExtractionExpr = (idType: AST_NODE_TYPES, init: TSESTree.Expression) =>
  init.type === AST_NODE_TYPES.MemberExpression ||
  init.type === AST_NODE_TYPES.ChainExpression ||
  (init.type === AST_NODE_TYPES.Identifier && idType !== AST_NODE_TYPES.Identifier);

const isClosureExtractionInit = (d: TSESTree.VariableDeclarator) => {
  const check = flow(
    O.fromNullable<TSESTree.VariableDeclarator["init"]>,
    O.exists((init) => isClosureExtractionExpr(d.id.type, init)),
  );
  return check(d.init);
};

const hasAllNamesCaptured = (captured: ReadonlySet<string>, names: ReadonlyArray<string>) =>
  names.length > 0 && RA.every((name: string) => captured.has(name))(names);

const isWorkletClosureExtraction = (
  d: TSESTree.VariableDeclarator,
  workletCapturedNames: ReadonlySet<string>,
) =>
  isClosureExtractionInit(d) &&
  hasAllNamesCaptured(workletCapturedNames, extractBoundNames(d.id));

const isScheduleOnRnTargetDeclarator = (
  d: TSESTree.VariableDeclarator,
  targets: ReadonlySet<string>,
) =>
  d.id.type === AST_NODE_TYPES.Identifier &&
  targets.has(d.id.name) &&
  O.exists(isAnonFn)(O.fromNullable(d.init));

const isUseMemoCallExpr = flow(
  O.filter(
    (n: TSESTree.Expression): n is TSESTree.CallExpression =>
      n.type === AST_NODE_TYPES.CallExpression,
  ),
  O.flatMap((c) => resolveCalleeName(c.callee)),
  O.exists((name) => USE_MEMO_NAMES.has(name)),
);

const extractPropTargetIdentifier = (val: TSESTree.Property["value"]) =>
  match(val)
    .with({ type: AST_NODE_TYPES.Identifier }, O.some)
    .with({ type: AST_NODE_TYPES.AssignmentPattern, left: { type: AST_NODE_TYPES.Identifier } }, (p) => O.some(p.left))
    .with(P._, () => O.none satisfies O.Option<TSESTree.Identifier>)
    .exhaustive();

const extractShallowPropIdentifier = (prop: TSESTree.Property | TSESTree.RestElement) =>
  prop.type === AST_NODE_TYPES.Property ? extractPropTargetIdentifier(prop.value) : O.none;

const isPrimitiveIdentifier = (id: TSESTree.Identifier, ctx: CheckerContext) =>
  isPrimitiveTsType(ctx.resolveType(id));

const isShallowPrimitiveProperty = (
  prop: TSESTree.Property | TSESTree.RestElement,
  ctx: CheckerContext,
) => O.exists((id: TSESTree.Identifier) => isPrimitiveIdentifier(id, ctx))(
  extractShallowPropIdentifier(prop),
);

const isShallowPrimitiveObjectPattern = (
  pattern: TSESTree.ObjectPattern,
  checkerCtx: O.Option<CheckerContext>,
) =>
  pattern.properties.length > 0 &&
  O.exists((ctx: CheckerContext) =>
    RA.every((prop: TSESTree.Property | TSESTree.RestElement) =>
      isShallowPrimitiveProperty(prop, ctx),
    )(pattern.properties),
  )(checkerCtx);

const extractBodyDeclarators = RA.flatMap((stmt: TSESTree.Statement) =>
  stmt.type === AST_NODE_TYPES.VariableDeclaration ? stmt.declarations : [],
);

const isBaseExemptDeclarator = ({
  d,
  env,
  workletCapturedNames,
}: Readonly<{
  d: TSESTree.VariableDeclarator;
  env: TsxCheckEnv;
  workletCapturedNames: ReadonlySet<string>;
}>) =>
  isHookCallExpr(O.fromNullable(d.init)) ||
  isJsxHelperInit(O.fromNullable(d.init)) ||
  isWorkletOrGestureInit(O.fromNullable(d.init), env.visitorKeys) ||
  isScheduleOnRnTargetDeclarator(d, env.scheduleOnRnTargets) ||
  isWorkletClosureExtraction(d, workletCapturedNames);

const collectUseMemoNames = RA.filterMap((d: TSESTree.VariableDeclarator) =>
  d.id.type === AST_NODE_TYPES.Identifier && isUseMemoCallExpr(O.fromNullable(d.init))
    ? O.some(d.id.name)
    : O.none,
);

const collectSingleViewName = (
  declarators: ReadonlyArray<TSESTree.VariableDeclarator>,
  isBaseExempt: (d: TSESTree.VariableDeclarator) => boolean,
) => {
  const viewIds = RA.filterMap((d: TSESTree.VariableDeclarator) =>
    d.id.type === AST_NODE_TYPES.Identifier && !isBaseExempt(d)
      ? O.some(d.id.name)
      : O.none,
  )(declarators);
  return viewIds.length === 1 ? viewIds : ([] satisfies ReadonlyArray<string>);
};

const isPrimitiveViewDestructuring = ({
  d,
  sources,
  checkerCtx,
}: Readonly<{
  d: TSESTree.VariableDeclarator;
  sources: ReadonlySet<string>;
  checkerCtx: O.Option<CheckerContext>;
}>) =>
  d.id.type === AST_NODE_TYPES.ObjectPattern &&
  O.exists(
    (init: TSESTree.Expression) =>
      init.type === AST_NODE_TYPES.Identifier && sources.has(init.name),
  )(O.fromNullable(d.init)) &&
  isShallowPrimitiveObjectPattern(d.id, checkerCtx);

const filterDerivedWithSources =
  (sources: ReadonlySet<string>, checkerCtx: O.Option<CheckerContext>) =>
  (
    declarators: ReadonlyArray<TSESTree.VariableDeclarator>,
    isBaseExempt: (d: TSESTree.VariableDeclarator) => boolean,
  ) =>
    RA.filter(
      (d: TSESTree.VariableDeclarator) =>
        !isBaseExempt(d) && !isPrimitiveViewDestructuring({ d, sources, checkerCtx }),
    )(declarators);

const collectDerivedWithCaptured =
  (env: TsxCheckEnv) =>
  (block: TSESTree.BlockStatement) => {
    const declarators = extractBodyDeclarators(block.body);
    const isBaseExempt = (d: TSESTree.VariableDeclarator) =>
      isBaseExemptDeclarator({
        d,
        env,
        workletCapturedNames: collectWorkletCapturedNames(block, env),
      });
    return filterDerivedWithSources(
      new Set<string>([
        ...collectUseMemoNames(declarators),
        ...collectSingleViewName(declarators, isBaseExempt),
      ]),
      env.checkerCtx,
    )(declarators, isBaseExempt);
  };

const collectDerivedDeclarators = collectDerivedWithCaptured;

const reportIfObjectPattern = (env: TsxCheckEnv) => (d: TSESTree.VariableDeclarator) => {
  match(
    d.id.type === AST_NODE_TYPES.ObjectPattern &&
      !isShallowPrimitiveObjectPattern(d.id, env.checkerCtx),
  )
    .with(true, () => { env.report({ node: d.id, messageId: "noViewDestructuring" }); })
    .with(false, () => {})
    .exhaustive();
};

const reportDestructuredView = (
  derived: ReadonlyArray<TSESTree.VariableDeclarator>,
  env: TsxCheckEnv,
) => {
  RA.map(reportIfObjectPattern(env))(derived);
};

const toTooManyDerivedDescriptor =
  (body: TSESTree.BlockStatement) =>
  (actual: number, max: number) => ({
    node: body,
    messageId: "tooManyDerivedConsts" as const,
    data: { actual: toDecimalText(actual), max: toDecimalText(max) },
  });

const checkDerivedConsts = (env: TsxCheckEnv) => (block: TSESTree.BlockStatement) => {
  const derived = collectDerivedDeclarators(env)(block);
  reportDestructuredView(derived, env);
  match(derived.length > env.opts.maxDerivedConsts)
    .with(true, () => {
      env.report(toTooManyDerivedDescriptor(block)(derived.length, env.opts.maxDerivedConsts));
    })
    .with(false, () => {})
    .exhaustive();
};

const checkComponentBlock = (block: TSESTree.BlockStatement, env: TsxCheckEnv) => {
  checkPreReturnBudget(env.opts, env.report)(block);
  checkDerivedConsts(env)(block);
};

const isScheduleOnRnTargetFn = (node: FunctionNode, targets: ReadonlySet<string>) =>
  O.exists((name: string) => targets.has(name))(resolveDirectFunctionName(node));

const isAllowedNonComponentFn = (node: FunctionNode, env: TsxCheckEnv) =>
  isJsxAttrCallback(node) ||
  isHookCallbackArg(node) ||
  isCustomHookFn(node) ||
  isMatchBranchCallback(node) ||
  isInsideJsxExpr(node) ||
  isWorkletFunction(node) ||
  isScheduleOnRnTargetFn(node, env.scheduleOnRnTargets);

const checkNonComponentFn = (node: FunctionNode, env: TsxCheckEnv) => {
  match(isAllowedNonComponentFn(node, env))
    .with(false, () => { env.report({ node, messageId: "nonJsxHelperInTsx" }); })
    .with(true, () => {})
    .exhaustive();
};

const checkComponentFunction = (node: FunctionNode, env: TsxCheckEnv) => {
  match(isJsxReturningFn(node))
    .with(true, () => {
      match(node.body)
        .with({ type: AST_NODE_TYPES.BlockStatement }, (body) => {
          checkComponentBlock(body, env);
        })
        .with(P._, () => {})
        .exhaustive();
    })
    .with(false, () => { checkNonComponentFn(node, env); })
    .exhaustive();
};

const extractFirstAnonFnArg = flow(
  (call: TSESTree.CallExpression) => call.arguments[0],
  O.fromNullable,
  O.filter(isAnonFn),
);

const toHookCallbackSpan = (name: string) => (fn: AnonFunctionNode) => ({
  name,
  fn,
  lines: measureLineSpan(fn.body),
});

const extractHookCallback = (node: TSESTree.CallExpression) => (name: string) => {
  const extract = flow(
    extractFirstAnonFnArg,
    O.map(toHookCallbackSpan(name)),
  );
  return extract(node);
};

const checkSizedHookCall =
  (maxHookBodyLines: number, report: Reporter) =>
  (node: TSESTree.CallExpression) => {
    const check = flow(
      resolveCalleeName,
      O.filter((name) => SIZED_HOOKS.has(name)),
      O.flatMap(extractHookCallback(node)),
      O.filter(({ lines }) => lines > maxHookBodyLines),
      O.map(({ name, fn, lines }) => {
        report({
          node: fn,
          messageId: "fatHookCallback",
          data: { hook: name, actual: toDecimalText(lines), max: toDecimalText(maxHookBodyLines) },
        });
      }),
    );
    check(node.callee);
  };

const isFpTsNamespaceReceiver = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.MemberExpression &&
  callee.object.type === AST_NODE_TYPES.Identifier &&
  FP_TS_NAMESPACE_NAMES.has(callee.object.name);

const reportNonJsxArrayTransform = (node: TSESTree.CallExpression, report: Reporter) => {
  const check = flow(
    extractMemberPropName,
    O.filter((method) => ARRAY_TRANSFORM_METHODS.has(method)),
    O.filter((method) => !(MAP_METHODS.has(method) && isInsideJsxExpr(node))),
    O.map((method) => {
      report({ node, messageId: "nonJsxArrayTransform", data: { method } });
    }),
  );
  check(node.callee);
};

const checkArrayTransformCall = (node: TSESTree.CallExpression, report: Reporter) => {
  match(isFpTsNamespaceReceiver(node.callee))
    .with(true, () => {})
    .with(false, () => { reportNonJsxArrayTransform(node, report); })
    .exhaustive();
};

const toFatJsxHandlerDescriptor =
  (fn: AnonFunctionNode) =>
  (lines: number, maxLines: number) => ({
    node: fn,
    messageId: "fatJsxHandler" as const,
    data: { actual: toDecimalText(lines), max: toDecimalText(maxLines) },
  });

const extractJsxAttrCallback = flow(
  (node: TSESTree.JSXAttribute) => node.value,
  O.fromNullable,
  O.filter(
    (v): v is TSESTree.JSXExpressionContainer => v.type === AST_NODE_TYPES.JSXExpressionContainer,
  ),
  O.map((c) => c.expression),
  O.filter(isAnonFn),
  O.map((fn) => ({ fn, lines: measureLineSpan(fn.body) })),
);

const checkJsxHandlerAttr =
  (maxHandlerLines: number, report: Reporter) =>
  (node: TSESTree.JSXAttribute) => {
    const check = flow(
      extractJsxAttrCallback,
      O.filter(({ lines }) => lines > maxHandlerLines),
      O.map(({ fn, lines }) => {
        report(toFatJsxHandlerDescriptor(fn)(lines, maxHandlerLines));
      }),
    );
    check(node);
  };

const buildControlFlowListeners = (report: Reporter) => ({
  IfStatement: (node: TSESTree.IfStatement) => { report({ node, messageId: "forbiddenControlFlow", data: { kind: "if/else" } }); },
  SwitchStatement: (node: TSESTree.SwitchStatement) => { report({ node, messageId: "forbiddenControlFlow", data: { kind: "switch" } }); },
  TryStatement: (node: TSESTree.TryStatement) => { report({ node, messageId: "forbiddenControlFlow", data: { kind: "try/catch" } }); },
  ForStatement: (node: TSESTree.ForStatement) => { report({ node, messageId: "forbiddenControlFlow", data: { kind: "for" } }); },
  ForInStatement: (node: TSESTree.ForInStatement) => { report({ node, messageId: "forbiddenControlFlow", data: { kind: "for..in" } }); },
  ForOfStatement: (node: TSESTree.ForOfStatement) => { report({ node, messageId: "forbiddenControlFlow", data: { kind: "for..of" } }); },
  WhileStatement: (node: TSESTree.WhileStatement) => { report({ node, messageId: "forbiddenControlFlow", data: { kind: "while" } }); },
  DoWhileStatement: (node: TSESTree.DoWhileStatement) => { report({ node, messageId: "forbiddenControlFlow", data: { kind: "do..while" } }); },
});

const checkNestedTernary = (node: TSESTree.ConditionalExpression, report: Reporter) => {
  match(node.parent.type === AST_NODE_TYPES.ConditionalExpression)
    .with(true, () => { report({ node, messageId: "forbiddenNestedTernary" }); })
    .with(false, () => {})
    .exhaustive();
};

const buildTsxListeners = (env: TsxCheckEnv) => ({
  ...buildControlFlowListeners(env.report),
  FunctionDeclaration: (node: TSESTree.FunctionDeclaration) => { checkComponentFunction(node, env); },
  FunctionExpression: (node: TSESTree.FunctionExpression) => { checkComponentFunction(node, env); },
  ArrowFunctionExpression: (node: TSESTree.ArrowFunctionExpression) => { checkComponentFunction(node, env); },
  CallExpression: (node: TSESTree.CallExpression) => {
    checkSizedHookCall(env.opts.maxHookBodyLines, env.report)(node);
    checkArrayTransformCall(node, env.report);
  },
  JSXAttribute: checkJsxHandlerAttr(env.opts.maxHandlerLines, env.report),
  ConditionalExpression: (node: TSESTree.ConditionalExpression) => { checkNestedTernary(node, env.report); },
});

const buildTsxCheckEnv = (
  context: TSESLint.RuleContext<MessageIds, Options>,
  opts: Options[0],
) => ({
  opts,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => { context.report(d); },
  visitorKeys: context.sourceCode.visitorKeys,
  scheduleOnRnTargets: collectScheduleOnRnTargets(
    context.sourceCode.ast,
    context.sourceCode.visitorKeys,
  ),
  checkerCtx: toCheckerContext(ESLintUtils.getParserServices(context, true)),
});

export const thinReactComponent = createRule<Options, MessageIds>({
  name: "thin-react-component",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Enforce thin, UI-only React / React Native components in .tsx files by extracting logic and view-model computation into pure .ts files.",
    },
    messages: {
      nonJsxHelperInTsx:
        "Non-JSX helper function in .tsx file. Extract pure logic into a separate .ts file.",
      forbiddenControlFlow:
        "Imperative/branching `{{kind}}` statement inside .tsx. Extract logic into a pure .ts view-model function.",
      forbiddenNestedTernary:
        "Nested ternary inside .tsx. Extract conditional logic into a pure .ts view-model function.",
      nonJsxArrayTransform:
        "Array `.{{method}}()` transformation outside JSX rendering. Move data transformation into a pure .ts function.",
      tooManyLogicStatements:
        "Component has {{actual}} pre-return statements (max {{max}}). Extract logic into a pure .ts view-model function.",
      tooManyLogicLines:
        "Component has {{actual}} pre-return logic lines (max {{max}}). Extract logic into a pure .ts view-model function.",
      tooManyDerivedConsts:
        "Component has {{actual}} derived variables (max {{max}}). Consolidate into a single pure .ts view-model call (e.g. `const view = toView(props)`).",
      noViewDestructuring:
        "Do not destructure the derived view-model object; bind it to a single identifier (e.g. `const view = toView(props)`) and reference `view.*` in JSX.",
      fatHookCallback:
        "`{{hook}}` callback has {{actual}} lines (max {{max}}). Delegate hook logic to an imported .ts function.",
      fatJsxHandler:
        "Inline JSX event handler has {{actual}} lines (max {{max}}). Delegate handler logic to an imported .ts function.",
    },
    schema: [
      {
        type: "object",
        properties: {
          maxLogicLines: { type: "number", minimum: 1 },
          maxLogicStatements: { type: "number", minimum: 1 },
          maxHookBodyLines: { type: "number", minimum: 1 },
          maxHandlerLines: { type: "number", minimum: 1 },
          maxDerivedConsts: { type: "number", minimum: 0 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [DEFAULT_OPTIONS],
  },
  create: (context, [options]) =>
    isTsxFilename(context.filename)
      ? buildTsxListeners(buildTsxCheckEnv(context, options))
      : {},
});
