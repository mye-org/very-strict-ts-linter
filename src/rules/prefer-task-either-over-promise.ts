import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as IO from "fp-ts/lib/IO.js";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../lib/rule-factory.js";
import {
  hasMatchingEnclosingFunctionName,
  isUnsafeOrMustName,
} from "../lib/unsafe-function-scope.js";

type MessageIds = "preferTaskEitherNewPromise" | "preferTaskEitherPromiseChain";

const PROMISE_CONSTRUCTOR_NAMES: ReadonlySet<string> = new Set(["Promise"]);
const PROMISE_TYPE_NAMES: ReadonlySet<string> = new Set(["Promise", "PromiseLike"]);
const PROMISE_CHAIN_METHODS: ReadonlySet<string> = new Set(["then", "catch"]);
const UNSAFE_PREFIX_RE = /^unsafe([A-Z0-9_]|$)/;

const isUnsafePrefix = (name: string) => UNSAFE_PREFIX_RE.test(name);

const isExemptFunctionName = Pred.or(isUnsafePrefix)(isUnsafeOrMustName);

const isInsideUnsafeFunction = (node: TSESTree.Node) =>
  hasMatchingEnclosingFunctionName(isExemptFunctionName)(node);

const isPromiseSymbol = ({
  services,
  checker,
}: Readonly<{
  services: ParserServicesWithTypeInformation;
  checker: ts.TypeChecker;
}>) =>
  flow(
    (expr: TSESTree.Expression) => services.esTreeNodeToTSNodeMap.get(expr),
    (tsNode) => checker.getTypeAtLocation(tsNode).getSymbol(),
    O.fromNullable,
    O.exists((symbol: ts.Symbol) => PROMISE_TYPE_NAMES.has(symbol.name)),
  );

const isPromiseChainCall = ({
  callee,
  services,
  checker,
}: Readonly<{
  callee: TSESTree.MemberExpression & { property: TSESTree.Identifier };
  services: ParserServicesWithTypeInformation;
  checker: ts.TypeChecker;
}>) =>
  PROMISE_CHAIN_METHODS.has(callee.property.name) &&
  isPromiseSymbol({ services, checker })(callee.object);

const checkMemberCallee =
  (services: ParserServicesWithTypeInformation) =>
  (onMatch: (node: TSESTree.Node) => IO.IO<void>) =>
  (callee: TSESTree.MemberExpression & { property: TSESTree.Identifier }): IO.IO<void> =>
    isPromiseChainCall({
      callee,
      services,
      checker: services.program.getTypeChecker(),
    })
      ? onMatch(callee.property)
      : IO.of(undefined);

const checkCallExpression =
  (services: ParserServicesWithTypeInformation) =>
  (onMatch: (node: TSESTree.Node) => IO.IO<void>) =>
  (node: TSESTree.CallExpression): IO.IO<void> =>
    match({
      callee: node.callee,
      insideUnsafe: isInsideUnsafeFunction(node),
    })
      .with(
        {
          insideUnsafe: false,
          callee: {
            type: AST_NODE_TYPES.MemberExpression,
            computed: false,
            property: { type: AST_NODE_TYPES.Identifier },
          },
        },
        ({ callee }) => checkMemberCallee(services)(onMatch)(callee),
      )
      .otherwise(() => IO.of(undefined));

const isRawNewPromise = (node: TSESTree.NewExpression) =>
  node.callee.type === AST_NODE_TYPES.Identifier &&
  PROMISE_CONSTRUCTOR_NAMES.has(node.callee.name) &&
  !isInsideUnsafeFunction(node);

const reportWhen =
  <N extends TSESTree.Node>(predicate: Pred.Predicate<N>) =>
  (onMatch: (n: N) => IO.IO<void>) =>
    flow(
      O.fromPredicate(predicate),
      O.match(() => IO.of<void>(undefined), onMatch),
    );

const reportNode =
  (context: TSESLint.RuleContext<MessageIds, []>) =>
  (messageId: MessageIds) =>
  (node: TSESTree.Node): IO.IO<void> =>
  () => {
    context.report({ node, messageId });
  };

export const preferTaskEitherOverPromise = createRule<[], MessageIds>({
  name: "prefer-task-either-over-promise",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer `fp-ts/TaskEither` (`TE.tryCatch`, `T.fromIO`, `flow` + `TE.flatMap`) over `new Promise(...)` and `.then()`/`.catch()` promise chains.",
    },
    messages: {
      preferTaskEitherNewPromise:
        "Avoid `new Promise(...)`. Wrap async or effectful work with `TE.tryCatch` / `T.fromIO` and compose with `flow` + `TE.flatMap`.",
      preferTaskEitherPromiseChain:
        "Avoid `.then()` / `.catch()` promise chains. Use `TE.tryCatch` / `T.fromIO` composed with `flow` + `TE.flatMap` instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    NewExpression: (node) => {
      reportWhen<TSESTree.NewExpression>(isRawNewPromise)(
        reportNode(context)("preferTaskEitherNewPromise"),
      )(node)();
    },
    CallExpression: (node) => {
      checkCallExpression(ESLintUtils.getParserServices(context))(
        reportNode(context)("preferTaskEitherPromiseChain"),
      )(node)();
    },
  }),
});
