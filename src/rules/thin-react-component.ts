import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";

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

const SIZED_HOOKS = new Set(["useEffect", "useLayoutEffect", "useMemo", "useCallback"]);
const ARRAY_TRANSFORM_METHODS = new Set([
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

const ANON_FN_TYPES = new Set<AST_NODE_TYPES>([
  AST_NODE_TYPES.ArrowFunctionExpression,
  AST_NODE_TYPES.FunctionExpression,
]);

const isAnonFn = (node: TSESTree.Node): node is AnonFunctionNode =>
  ANON_FN_TYPES.has(node.type);

const getMemberPropName = (expr: TSESTree.Expression) =>
  match(expr.type === AST_NODE_TYPES.MemberExpression)
    .with(true, () => {
      const member = expr as TSESTree.MemberExpression;
      return member.property.type === AST_NODE_TYPES.Identifier
        ? O.some(member.property.name)
        : O.none;
    })
    .with(false, () => O.none)
    .exhaustive();

const getCalleeName = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.Identifier
    ? O.some(callee.name)
    : getMemberPropName(callee);

const isUpperChar = (ch: string) => ch >= "A" && ch <= "Z";
const isDigitChar = (ch: string) => ch >= "0" && ch <= "9";

const isHookName = (name: string) =>
  name.startsWith("use") &&
  pipe(
    O.fromNullable(name[3]),
    O.exists((ch) => isUpperChar(ch) || isDigitChar(ch)),
  );

const isHookCallExpr = (expr: O.Option<TSESTree.Expression>) =>
  pipe(
    expr,
    O.filter((n): n is TSESTree.CallExpression => n.type === AST_NODE_TYPES.CallExpression),
    O.flatMap((c) => getCalleeName(c.callee)),
    O.exists(isHookName),
  );

const isJsxNode = (e: TSESTree.Expression) =>
  e.type === AST_NODE_TYPES.JSXElement || e.type === AST_NODE_TYPES.JSXFragment;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- recursive AST predicate
const isJsxExpr = (expr: O.Option<TSESTree.Expression>): boolean =>
  pipe(
    expr,
    O.exists(
      (e) =>
        isJsxNode(e) ||
        (e.type === AST_NODE_TYPES.ConditionalExpression &&
          (isJsxExpr(O.some(e.consequent)) || isJsxExpr(O.some(e.alternate)))) ||
        (e.type === AST_NODE_TYPES.LogicalExpression &&
          (isJsxExpr(O.some(e.left)) || isJsxExpr(O.some(e.right)))),
    ),
  );

const isJsxReturningBlock = (block: TSESTree.BlockStatement) =>
  pipe(
    block.body,
    RA.some(
      (stmt) =>
        stmt.type === AST_NODE_TYPES.ReturnStatement &&
        isJsxExpr(O.fromNullable(stmt.argument)),
    ),
  );

const isJsxReturningFn = (node: FunctionNode) =>
  node.body.type === AST_NODE_TYPES.BlockStatement
    ? isJsxReturningBlock(node.body)
    : isJsxExpr(O.some(node.body));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- recursive AST predicate
const isInsideJsxExpr = (node: TSESTree.Node): boolean =>
  pipe(
    O.fromNullable(node.parent),
    O.exists((p) =>
      p.type === AST_NODE_TYPES.JSXExpressionContainer ? true : isInsideJsxExpr(p),
    ),
  );

const isJsxAttrHandler = (node: FunctionNode) =>
  node.parent.type === AST_NODE_TYPES.JSXExpressionContainer &&
  node.parent.parent.type === AST_NODE_TYPES.JSXAttribute;

const isHookCallbackArg = (node: FunctionNode) =>
  node.parent.type === AST_NODE_TYPES.CallExpression &&
  pipe(getCalleeName(node.parent.callee), O.exists(isHookName));

const getLineSpan = (node: TSESTree.Node) =>
  node.loc.end.line - node.loc.start.line + 1;

const checkPreReturnLineCount = (
  stmts: ReadonlyArray<TSESTree.Statement>,
  body: TSESTree.BlockStatement,
  maxLines: number,
  report: Reporter,
) => {
  pipe(
    O.Do,
    O.bind("first", () => RA.head(stmts)),
    O.bind("last", () => RA.last(stmts)),
    O.map(({ first, last }) => last.loc.end.line - first.loc.start.line + 1),
    O.filter((lines) => lines > maxLines),
    O.map((lines) => {
      report({ node: body, messageId: "tooManyLogicLines", data: { actual: String(lines), max: String(maxLines) } });
    }),
  );
};

const checkPreReturnBudget = (
  body: TSESTree.BlockStatement,
  opts: Options[0],
  report: Reporter,
) => {
  const stmts = pipe(
    body.body,
    RA.takeLeftWhile((s) => s.type !== AST_NODE_TYPES.ReturnStatement),
  );
  match(stmts.length > opts.maxLogicStatements)
    .with(true, () => {
      report({ node: body, messageId: "tooManyLogicStatements", data: { actual: String(stmts.length), max: String(opts.maxLogicStatements) } });
    })
    .with(false, () => {})
    .exhaustive();
  checkPreReturnLineCount(stmts, body, opts.maxLogicLines, report);
};

const isJsxHelperInit = (init: O.Option<TSESTree.Expression>) =>
  pipe(init, O.filter(isAnonFn), O.exists(isJsxReturningFn));

const getDerivedDeclarators = (body: TSESTree.BlockStatement) =>
  pipe(
    body.body,
    RA.flatMap((stmt) =>
      stmt.type === AST_NODE_TYPES.VariableDeclaration ? stmt.declarations : [],
    ),
    RA.filter((d) => !isHookCallExpr(O.fromNullable(d.init)) && !isJsxHelperInit(O.fromNullable(d.init))),
  );

const reportDestructuredView = (
  derived: ReadonlyArray<TSESTree.VariableDeclarator>,
  report: Reporter,
) => {
  pipe(
    derived,
    RA.filter((d) => d.id.type === AST_NODE_TYPES.ObjectPattern),
    RA.map((d) => {
      report({ node: d.id, messageId: "noViewDestructuring" });
    }),
  );
};

const checkDerivedConsts = (
  body: TSESTree.BlockStatement,
  maxDerivedConsts: number,
  report: Reporter,
) => {
  const derived = getDerivedDeclarators(body);
  reportDestructuredView(derived, report);
  match(derived.length > maxDerivedConsts)
    .with(true, () => {
      report({ node: body, messageId: "tooManyDerivedConsts", data: { actual: String(derived.length), max: String(maxDerivedConsts) } });
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
  match(!isJsxAttrHandler(node) && !isHookCallbackArg(node) && !isInsideJsxExpr(node))
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
  pipe(
    O.fromNullable(node.arguments[0]),
    O.filter(isAnonFn),
    O.map((fn) => ({ name, fn, lines: getLineSpan(fn.body) })),
  );

const checkSizedHookCall = (
  node: TSESTree.CallExpression,
  maxHookBodyLines: number,
  report: Reporter,
) => {
  pipe(
    getCalleeName(node.callee),
    O.filter((name) => SIZED_HOOKS.has(name)),
    O.flatMap(extractHookCallback(node)),
    O.filter(({ lines }) => lines > maxHookBodyLines),
    O.map(({ name, fn, lines }) => {
      report({ node: fn, messageId: "fatHookCallback", data: { hook: name, actual: String(lines), max: String(maxHookBodyLines) } });
    }),
  );
};

const checkArrayTransformCall = (node: TSESTree.CallExpression, report: Reporter) => {
  pipe(
    getMemberPropName(node.callee),
    O.filter((method) => ARRAY_TRANSFORM_METHODS.has(method)),
    O.filter((method) => !(method === "map" && isInsideJsxExpr(node))),
    O.map((method) => {
      report({ node, messageId: "nonJsxArrayTransform", data: { method } });
    }),
  );
};

const checkJsxHandlerAttr = (
  node: TSESTree.JSXAttribute,
  maxHandlerLines: number,
  report: Reporter,
) => {
  pipe(
    O.fromNullable(node.value),
    O.filter((v): v is TSESTree.JSXExpressionContainer => v.type === AST_NODE_TYPES.JSXExpressionContainer),
    O.map((c) => c.expression),
    O.filter(isAnonFn),
    O.map((fn) => ({ fn, lines: getLineSpan(fn.body) })),
    O.filter(({ lines }) => lines > maxHandlerLines),
    O.map(({ fn, lines }) => {
      report({ node: fn, messageId: "fatJsxHandler", data: { actual: String(lines), max: String(maxHandlerLines) } });
    }),
  );
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
    context.filename.endsWith(".tsx")
      ? buildTsxListeners(options, (d) => {
          context.report(d);
        })
      : {},
});
