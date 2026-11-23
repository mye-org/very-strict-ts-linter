import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";
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
  match(expr.type === AST_NODE_TYPES.MemberExpression)
    .with(true, () => {
      const member = expr as TSESTree.MemberExpression;
      return member.property.type === AST_NODE_TYPES.Identifier
        ? O.some(member.property.name)
        : O.none;
    })
    .with(false, () => O.none)
    .exhaustive();

const resolveCalleeName = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.Identifier
    ? O.some(callee.name)
    : extractMemberPropName(callee);

const isUpperChar = (ch: string) => ch >= "A" && ch <= "Z";
const isDigitChar = (ch: string) => ch >= "0" && ch <= "9";

const isHookName = (name: string) =>
  name.startsWith("use") &&
  O.exists((ch: string) => isUpperChar(ch) || isDigitChar(ch))(O.fromNullable(name[3]));

const isHookCallExpr = flow(
  O.filter(
    (n: TSESTree.Expression): n is TSESTree.CallExpression =>
      n.type === AST_NODE_TYPES.CallExpression,
  ),
  O.flatMap((c) => resolveCalleeName(c.callee)),
  O.exists(isHookName),
);

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

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST predicate
const isInsideJsxExpr = (node: TSESTree.Node): boolean =>
  flow(
    (n: TSESTree.Node) => n.parent,
    O.fromNullable,
    O.exists((p) => (p.type === AST_NODE_TYPES.JSXExpressionContainer ? true : isInsideJsxExpr(p))),
  )(node);

const isJsxAttrContainer = (parent: TSESTree.Node) =>
  parent.type === AST_NODE_TYPES.JSXExpressionContainer &&
  parent.parent.type === AST_NODE_TYPES.JSXAttribute;

const isJsxAttrCallback = ({ parent }: FunctionNode) => isJsxAttrContainer(parent);

const isHookCallbackArg = (node: FunctionNode) =>
  node.parent.type === AST_NODE_TYPES.CallExpression &&
  flow(resolveCalleeName, O.exists(isHookName))(node.parent.callee);

const isCustomHookFn = flow(resolveDirectFunctionName, O.exists(isHookName));

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

const checkPreReturnLineCount = (
  stmts: ReadonlyArray<TSESTree.Statement>,
  body: TSESTree.BlockStatement,
  maxLines: number,
  report: Reporter,
) => {
  flow(
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
  )(O.Do);
};

const toLogicBudgetDescriptor = (
  body: TSESTree.BlockStatement,
  actual: number,
  max: number,
) => ({
  node: body,
  messageId: "tooManyLogicStatements" as const,
  data: { actual: toDecimalText(actual), max: toDecimalText(max) },
});

const checkPreReturnBudget = (
  body: TSESTree.BlockStatement,
  opts: Options[0],
  report: Reporter,
) => {
  const stmts = RA.takeLeftWhile(
    (s: TSESTree.Statement) => s.type !== AST_NODE_TYPES.ReturnStatement,
  )(body.body);
  match(stmts.length > opts.maxLogicStatements)
    .with(true, () => { report(toLogicBudgetDescriptor(body, stmts.length, opts.maxLogicStatements)); })
    .with(false, () => {})
    .exhaustive();
  checkPreReturnLineCount(stmts, body, opts.maxLogicLines, report);
};

const isJsxHelperInit = flow(O.filter(isAnonFn), O.exists(isJsxReturningFn));

const collectDerivedDeclarators = (body: TSESTree.BlockStatement) =>
  flow(
    RA.flatMap((stmt: TSESTree.Statement) =>
      stmt.type === AST_NODE_TYPES.VariableDeclaration ? stmt.declarations : [],
    ),
    RA.filter(
      (d) => !isHookCallExpr(O.fromNullable(d.init)) && !isJsxHelperInit(O.fromNullable(d.init)),
    ),
  )(body.body);

const reportIfObjectPattern = (report: Reporter) => (d: TSESTree.VariableDeclarator) => {
  match(d.id.type === AST_NODE_TYPES.ObjectPattern)
    .with(true, () => { report({ node: d.id, messageId: "noViewDestructuring" }); })
    .with(false, () => {})
    .exhaustive();
};

const reportDestructuredView = (
  derived: ReadonlyArray<TSESTree.VariableDeclarator>,
  report: Reporter,
) => {
  RA.map(reportIfObjectPattern(report))(derived);
};

const checkDerivedConsts = (
  body: TSESTree.BlockStatement,
  maxDerivedConsts: number,
  report: Reporter,
) => {
  const derived = collectDerivedDeclarators(body);
  reportDestructuredView(derived, report);
  match(derived.length > maxDerivedConsts)
    .with(true, () => {
      report({
        node: body,
        messageId: "tooManyDerivedConsts",
        data: { actual: toDecimalText(derived.length), max: toDecimalText(maxDerivedConsts) },
      });
    })
    .with(false, () => {})
    .exhaustive();
};

const checkComponentBlock = (
  block: TSESTree.BlockStatement,
  opts: Options[0],
  report: Reporter,
) => {
  checkPreReturnBudget(block, opts, report);
  checkDerivedConsts(block, opts.maxDerivedConsts, report);
};

const checkNonComponentFn = (node: FunctionNode, report: Reporter) => {
  match(
    !isJsxAttrCallback(node) &&
      !isHookCallbackArg(node) &&
      !isCustomHookFn(node) &&
      !isMatchBranchCallback(node) &&
      !isInsideJsxExpr(node),
  )
    .with(true, () => { report({ node, messageId: "nonJsxHelperInTsx" }); })
    .with(false, () => {})
    .exhaustive();
};

const checkComponentFunction = (
  node: FunctionNode,
  opts: Options[0],
  report: Reporter,
) => {
  match(isJsxReturningFn(node))
    .with(true, () => {
      match(node.body.type === AST_NODE_TYPES.BlockStatement)
        .with(true, () => { checkComponentBlock(node.body as TSESTree.BlockStatement, opts, report); })
        .with(false, () => {})
        .exhaustive();
    })
    .with(false, () => { checkNonComponentFn(node, report); })
    .exhaustive();
};

const extractHookCallback = (node: TSESTree.CallExpression) => (name: string) =>
  flow(
    (call: TSESTree.CallExpression) => call.arguments[0],
    O.fromNullable,
    O.filter(isAnonFn),
    O.map((fn) => ({ name, fn, lines: measureLineSpan(fn.body) })),
  )(node);

const checkSizedHookCall = (
  node: TSESTree.CallExpression,
  maxHookBodyLines: number,
  report: Reporter,
) => {
  flow(
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
  )(node.callee);
};

const isFpTsNamespaceReceiver = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.MemberExpression &&
  callee.object.type === AST_NODE_TYPES.Identifier &&
  FP_TS_NAMESPACE_NAMES.has(callee.object.name);

const reportNonJsxArrayTransform = (node: TSESTree.CallExpression, report: Reporter) => {
  flow(
    extractMemberPropName,
    O.filter((method) => ARRAY_TRANSFORM_METHODS.has(method)),
    O.filter((method) => !(MAP_METHODS.has(method) && isInsideJsxExpr(node))),
    O.map((method) => {
      report({ node, messageId: "nonJsxArrayTransform", data: { method } });
    }),
  )(node.callee);
};

const checkArrayTransformCall = (node: TSESTree.CallExpression, report: Reporter) => {
  match(isFpTsNamespaceReceiver(node.callee))
    .with(true, () => {})
    .with(false, () => { reportNonJsxArrayTransform(node, report); })
    .exhaustive();
};

const toFatJsxHandlerDescriptor = (fn: AnonFunctionNode, lines: number, maxLines: number) => ({
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

const checkJsxHandlerAttr = (
  node: TSESTree.JSXAttribute,
  maxHandlerLines: number,
  report: Reporter,
) => {
  flow(
    extractJsxAttrCallback,
    O.filter(({ lines }) => lines > maxHandlerLines),
    O.map(({ fn, lines }) => {
      report(toFatJsxHandlerDescriptor(fn, lines, maxHandlerLines));
    }),
  )(node);
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

const buildTsxListeners = (opts: Options[0], report: Reporter) => ({
  ...buildControlFlowListeners(report),
  FunctionDeclaration: (node: TSESTree.FunctionDeclaration) => { checkComponentFunction(node, opts, report); },
  FunctionExpression: (node: TSESTree.FunctionExpression) => { checkComponentFunction(node, opts, report); },
  ArrowFunctionExpression: (node: TSESTree.ArrowFunctionExpression) => { checkComponentFunction(node, opts, report); },
  CallExpression: (node: TSESTree.CallExpression) => {
    checkSizedHookCall(node, opts.maxHookBodyLines, report);
    checkArrayTransformCall(node, report);
  },
  JSXAttribute: (node: TSESTree.JSXAttribute) => { checkJsxHandlerAttr(node, opts.maxHandlerLines, report); },
  ConditionalExpression: (node: TSESTree.ConditionalExpression) => { checkNestedTernary(node, report); },
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
      ? buildTsxListeners(options, (d) => {
          context.report(d);
        })
      : {},
});
