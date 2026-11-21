import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESTree } from "@typescript-eslint/utils";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../utils/create-rule.js";
import {
  isInsideUnsafeOrMustFunction,
  isUnsafeOrMustName,
} from "../utils/type-helpers.js";

type MessageIds = "noTryCatch" | "noAsyncAwait" | "noRawPromise";

const PROMISE_TERMINAL_METHODS = new Set(["then", "catch", "finally"]);
const PROMISE_STATIC_METHODS = new Set([
  "resolve",
  "reject",
  "all",
  "allSettled",
  "race",
  "any",
]);

const isExemptNamedArrowOrFn = (node: TSESTree.Node) =>
  (node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionExpression) &&
  node.parent.type === AST_NODE_TYPES.VariableDeclarator &&
  node.parent.id.type === AST_NODE_TYPES.Identifier &&
  isUnsafeOrMustName(node.parent.id.name);

const isExemptFunction = (node: TSESTree.Node) =>
  isInsideUnsafeOrMustFunction(node) ||
  (node.type === AST_NODE_TYPES.FunctionDeclaration &&
    Boolean(node.id) &&
    isUnsafeOrMustName(node.id?.name ?? "")) ||
  isExemptNamedArrowOrFn(node);

const isAsyncFunctionNode = (node: TSESTree.Node) =>
  (node.type === AST_NODE_TYPES.FunctionDeclaration ||
    node.type === AST_NODE_TYPES.FunctionExpression ||
    node.type === AST_NODE_TYPES.ArrowFunctionExpression) &&
  node.async;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const isInsideAsyncFunction = (node: TSESTree.Node): boolean =>
  node.parent
    ? isAsyncFunctionNode(node.parent) || isInsideAsyncFunction(node.parent)
    : false;

const isPromiseStaticCall = (object: TSESTree.Expression, propName: string) =>
  object.type === AST_NODE_TYPES.Identifier &&
  object.name === "Promise" &&
  PROMISE_STATIC_METHODS.has(propName);

const isPromiseSymbol = (
  object: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) => {
  const symbol = checker
    .getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(object))
    .getSymbol();
  return symbol?.name === "Promise" || symbol?.name === "PromiseLike";
};

const isPromiseTerminalCall = (
  object: TSESTree.Expression,
  propName: string,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) => PROMISE_TERMINAL_METHODS.has(propName) && isPromiseSymbol(object, services, checker);

const reportPromiseMemberCall = (
  node: TSESTree.CallExpression,
  callee: TSESTree.MemberExpression & { property: TSESTree.Identifier },
  services: ParserServicesWithTypeInformation,
  report: (n: TSESTree.Node, messageId: MessageIds) => void,
) => {
  match({
    isStatic: isPromiseStaticCall(callee.object, callee.property.name),
    isTerminal: isPromiseTerminalCall(callee.object, callee.property.name, services, services.program.getTypeChecker()),
  })
    .with({ isStatic: true }, () => { report(node, "noRawPromise"); })
    .with({ isTerminal: true }, () => { report(callee.property, "noRawPromise"); })
    .otherwise(() => {});
};

const checkCallExpression = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
  report: (n: TSESTree.Node, messageId: MessageIds) => void,
) => {
  match({ callee: node.callee, insideUnsafe: isInsideUnsafeOrMustFunction(node) })
    .with(
      { insideUnsafe: false, callee: { type: AST_NODE_TYPES.MemberExpression, property: { type: AST_NODE_TYPES.Identifier } } },
      ({ callee }) => { reportPromiseMemberCall(node, callee, services, report); },
    )
    .otherwise(() => {});
};

const isRawNewPromise = (node: TSESTree.NewExpression) =>
  node.callee.type === AST_NODE_TYPES.Identifier &&
  node.callee.name === "Promise" &&
  !isInsideUnsafeOrMustFunction(node);

const reportWhenTrue = (cond: boolean, fn: () => void) => {
  match(cond).with(true, fn).with(false, () => {}).exhaustive();
};

export const preferMonadicErrorHandling = createRule<[], MessageIds>({
  name: "prefer-monadic-error-handling",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Encourage monadic error and async handling (`Either`, `Task`, `TaskEither`) over `try/catch`, `async/await`, and raw `Promise`.",
    },
    messages: {
      noTryCatch: "Avoid `try/catch`. Use `E.tryCatch` or `TE.tryCatch` from `fp-ts` instead.",
      noAsyncAwait: "Avoid `async/await`. Use `Task` or `TaskEither` (`T.*`, `TE.*`) from `fp-ts` instead.",
      noRawPromise: "Avoid raw `Promise` (`.then()`/`.catch()`/`new Promise()`). Use `Task` or `TaskEither` instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const checkAsync = (node: TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression) => {
      reportWhenTrue(node.async && !isExemptFunction(node), () => { context.report({ node, messageId: "noAsyncAwait" }); });
    };
    return {
      TryStatement: (node) => { reportWhenTrue(!isInsideUnsafeOrMustFunction(node), () => { context.report({ node, messageId: "noTryCatch" }); }); },
      FunctionDeclaration: checkAsync,
      FunctionExpression: checkAsync,
      ArrowFunctionExpression: checkAsync,
      AwaitExpression: (node) => { reportWhenTrue(!isInsideAsyncFunction(node) && !isInsideUnsafeOrMustFunction(node), () => { context.report({ node, messageId: "noAsyncAwait" }); }); },
      NewExpression: (node) => { reportWhenTrue(isRawNewPromise(node), () => { context.report({ node, messageId: "noRawPromise" }); }); },
      CallExpression: (node) => { checkCallExpression(node, ESLintUtils.getParserServices(context), (n, id) => { context.report({ node: n, messageId: id }); }); },
    };
  },
});
