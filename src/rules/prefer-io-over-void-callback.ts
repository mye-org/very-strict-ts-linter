import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as IO from "fp-ts/lib/IO.js";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { collectEstreeChildNodes } from "../lib/estree-children.js";
import { isEsTreeFunctionNode } from "../lib/estree-function-nodes.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "preferIoOverVoidCallback";

type CallbackTarget = Readonly<{
  readonly callback: TSESTree.CallExpressionArgument;
  readonly targetLabel: string;
  readonly isMapCall: boolean;
}>;

const MAP_NAMESPACES: ReadonlySet<string> = new Set([
  "RA",
  "A",
  "RNEA",
  "O",
  "E",
  "T",
  "TE",
  "IO",
  "IOE",
  "R",
  "RR",
  "RTE",
  "RE",
]);

const MAP_METHODS: ReadonlySet<string> = new Set(["map", "mapWithIndex", "tap"]);

const MATCH_HANDLER_METHODS: ReadonlySet<string> = new Set(["with", "when", "otherwise"]);

const MATCH_CHAIN_METHODS: ReadonlySet<string> = new Set([
  "with",
  "when",
  "otherwise",
  "exhaustive",
  "run",
  "narrow",
  "returnType",
]);

const VOID_SIDE_EFFECT_CALLEES: ReadonlySet<string> = new Set([
  "report",
  "log",
  "warn",
  "error",
  "info",
  "debug",
  "alert",
  "print",
]);

const VOID_FS_METHODS: ReadonlySet<string> = new Set([
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "rmSync",
  "unlinkSync",
  "rmdirSync",
  "renameSync",
  "copyFileSync",
]);

const noopIo: IO.IO<void> = () => {};

const runIo = (eff: IO.IO<void>) => {
  eff();
};

const isNestedScopeBoundary = (node: TSESTree.Node) =>
  isEsTreeFunctionNode(node) ||
  node.type === AST_NODE_TYPES.ClassDeclaration ||
  node.type === AST_NODE_TYPES.ClassExpression;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const hasValueReturnInNode =
  (visitorKeys: TSESLint.SourceCode["visitorKeys"]) =>
  (node: TSESTree.Node): boolean =>
    match(node)
      .with({ type: AST_NODE_TYPES.ReturnStatement }, (ret) => ret.argument !== null)
      .when(isNestedScopeBoundary, () => false)
      .otherwise(
        flow(
          collectEstreeChildNodes(visitorKeys),
          RA.some(hasValueReturnInNode(visitorKeys)),
        ),
      );

const isVoidBlockBody =
  (visitorKeys: TSESLint.SourceCode["visitorKeys"]) =>
  (body: TSESTree.BlockStatement) =>
    body.body.length > 0 && !RA.some(hasValueReturnInNode(visitorKeys))(body.body);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive match chain check
const isMatchChainReceiver = (expr: TSESTree.Expression): boolean =>
  match(expr)
    .with(
      {
        type: AST_NODE_TYPES.CallExpression,
        callee: { type: AST_NODE_TYPES.Identifier, name: "match" },
      },
      () => true,
    )
    .with(
      {
        type: AST_NODE_TYPES.CallExpression,
        callee: {
          type: AST_NODE_TYPES.MemberExpression,
          computed: false,
          property: { type: AST_NODE_TYPES.Identifier },
        },
      },
      (c) =>
        MATCH_CHAIN_METHODS.has(c.callee.property.name) &&
        isMatchChainReceiver(c.callee.object),
    )
    .otherwise(() => false);

const extractMapCallback =
  (objectName: string) =>
  (methodName: string) =>
  (args: ReadonlyArray<TSESTree.CallExpressionArgument>) =>
    MAP_NAMESPACES.has(objectName) && MAP_METHODS.has(methodName)
      ? O.map(
          (callback: TSESTree.CallExpressionArgument): CallbackTarget => ({
            callback,
            targetLabel: `${objectName}.${methodName}`,
            isMapCall: true,
          }),
        )(O.fromNullable(args[0]))
      : O.none;

const resolveMapCallbackTarget = (node: TSESTree.CallExpression) =>
  match(node)
    .with(
      {
        callee: {
          type: AST_NODE_TYPES.MemberExpression,
          computed: false,
          object: { type: AST_NODE_TYPES.Identifier },
          property: { type: AST_NODE_TYPES.Identifier },
        },
      },
      (c) =>
        extractMapCallback(c.callee.object.name)(c.callee.property.name)(
          c.arguments,
        ),
    )
    .otherwise(() => O.none);

const resolveMatchHandlerArg =
  (methodName: string) =>
  (args: ReadonlyArray<TSESTree.CallExpressionArgument>) =>
    match(methodName)
      .with("otherwise", () => O.fromNullable(args[0]))
      .otherwise(() =>
        args.length >= 2 ? O.fromNullable(args[args.length - 1]) : O.none,
      );

const extractMatchCallback =
  (methodName: string) =>
  (receiver: TSESTree.Expression) =>
  (args: ReadonlyArray<TSESTree.CallExpressionArgument>) =>
    MATCH_HANDLER_METHODS.has(methodName) && isMatchChainReceiver(receiver)
      ? O.map(
          (callback: TSESTree.CallExpressionArgument): CallbackTarget => ({
            callback,
            targetLabel: `match(...).${methodName}(...)`,
            isMapCall: false,
          }),
        )(resolveMatchHandlerArg(methodName)(args))
      : O.none;

const resolveMatchCallbackTarget = (node: TSESTree.CallExpression) =>
  match(node)
    .with(
      {
        callee: {
          type: AST_NODE_TYPES.MemberExpression,
          computed: false,
          property: { type: AST_NODE_TYPES.Identifier },
        },
      },
      (c) =>
        extractMatchCallback(c.callee.property.name)(c.callee.object)(
          c.arguments,
        ),
    )
    .otherwise(() => O.none);

const resolveCallbackTarget = (node: TSESTree.CallExpression) =>
  match(resolveMapCallbackTarget(node))
    .with({ _tag: "Some" }, (some) => some)
    .with({ _tag: "None" }, () => resolveMatchCallbackTarget(node))
    .exhaustive();

const isKnownVoidSideEffectCallee = (expr: TSESTree.Expression) =>
  match(expr)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) =>
      VOID_SIDE_EFFECT_CALLEES.has(id.name),
    )
    .with(
      {
        type: AST_NODE_TYPES.MemberExpression,
        computed: false,
        object: { type: AST_NODE_TYPES.Identifier },
        property: { type: AST_NODE_TYPES.Identifier },
      },
      (m) =>
        m.object.name === "console" ||
        (m.object.name === "fs" && VOID_FS_METHODS.has(m.property.name)) ||
        m.property.name === "report",
    )
    .with(
      {
        type: AST_NODE_TYPES.MemberExpression,
        computed: false,
        property: { type: AST_NODE_TYPES.Identifier, name: "report" },
      },
      () => true,
    )
    .otherwise(() => false);

const isKnownVoidSideEffectExpr = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.CallExpression &&
  isKnownVoidSideEffectCallee(expr.callee);

const hasVoidFlag = (type: ts.Type) => (type.flags & ts.TypeFlags.Void) !== 0;

const hasAnyFlag = (type: ts.Type) => (type.flags & ts.TypeFlags.Any) !== 0;

const getNodeType = (services: ParserServicesWithTypeInformation) =>
  flow(
    (node: TSESTree.Node) => services.esTreeNodeToTSNodeMap.get(node),
    (tsNode) => services.program.getTypeChecker().getTypeAtLocation(tsNode),
  );

const isVoidExpression =
  (services: ParserServicesWithTypeInformation) =>
  (expr: TSESTree.Expression) => {
    const type = getNodeType(services)(expr);
    return hasVoidFlag(type) || (hasAnyFlag(type) && isKnownVoidSideEffectExpr(expr));
  };

const isVoidSignature = flow(
  (sig: ts.Signature) => sig.getReturnType(),
  hasVoidFlag,
);

const isVoidFunctionRef =
  (context: TSESLint.RuleContext<MessageIds, []>) =>
  (expr: TSESTree.CallExpressionArgument) => {
    const type = getNodeType(ESLintUtils.getParserServices(context))(expr);
    const signatures = type.getCallSignatures();
    return signatures.length > 0
      ? RA.every(isVoidSignature)(signatures)
      : hasAnyFlag(type) &&
          expr.type !== AST_NODE_TYPES.SpreadElement &&
          isKnownVoidSideEffectCallee(expr);
  };

const isVoidCallback =
  (context: TSESLint.RuleContext<MessageIds, []>) =>
  (target: CallbackTarget) =>
    match(target)
      .with(
        {
          callback: {
            type: P.union(
              AST_NODE_TYPES.ArrowFunctionExpression,
              AST_NODE_TYPES.FunctionExpression,
            ),
            body: { type: AST_NODE_TYPES.BlockStatement },
          },
        },
        ({ callback }) =>
          isVoidBlockBody(context.sourceCode.visitorKeys)(callback.body),
      )
      .with(
        {
          isMapCall: true,
          callback: {
            type: AST_NODE_TYPES.ArrowFunctionExpression,
            body: P.select(),
          },
        },
        (body) =>
          body.type !== AST_NODE_TYPES.BlockStatement &&
          isVoidExpression(ESLintUtils.getParserServices(context))(body),
      )
      .with(
        { isMapCall: true, callback: P.select() },
        isVoidFunctionRef(context),
      )
      .otherwise(() => false);

const reportTargetIo =
  (context: TSESLint.RuleContext<MessageIds, []>) =>
  (target: CallbackTarget): IO.IO<void> =>
  () => {
    context.report({
      node: target.callback,
      messageId: "preferIoOverVoidCallback",
      data: { target: target.targetLabel },
    });
  };

const buildListeners = (context: TSESLint.RuleContext<MessageIds, []>) => ({
  CallExpression: flow(
    resolveCallbackTarget,
    O.filter(isVoidCallback(context)),
    O.match(() => noopIo, reportTargetIo(context)),
    runIo,
  ),
});

export const preferIoOverVoidCallback = createRule<[], MessageIds>({
  name: "prefer-io-over-void-callback",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer modeling side-effecting callbacks in `map` or `match` handlers as `IO.IO<void>` (`RA.traverse(IO.Applicative)` / `IO.flatMap`) instead of returning `void`.",
    },
    messages: {
      preferIoOverVoidCallback:
        "Avoid side-effecting `void` callback in `{{target}}`. Model the effect as `IO.IO<void>` (e.g. `RA.traverse(IO.Applicative)` or `IO.flatMap`) instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: buildListeners,
});
