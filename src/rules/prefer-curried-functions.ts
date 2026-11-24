import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as IO from "fp-ts/lib/IO.js";
import * as Monoid from "fp-ts/lib/Monoid.js";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "preferCurried";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

type ReportFn = (descriptor: TSESLint.ReportDescriptor<MessageIds>) => void;

const THIS_PARAM_NAMES: ReadonlySet<string> = new Set(["this"]);
const CONTEXT_PARAM_NAMES: ReadonlySet<string> = new Set(["context", "_context"]);

const isExplicitThisParam = (param: TSESTree.Parameter) =>
  param.type === AST_NODE_TYPES.Identifier && THIS_PARAM_NAMES.has(param.name);

const getValueParams = RA.filter(Pred.not(isExplicitThisParam));

const isRestParam = (param: TSESTree.Parameter) => param.type === AST_NODE_TYPES.RestElement;

const isRestOnly = (params: ReadonlyArray<TSESTree.Parameter>) =>
  params.length > 0 && RA.every(isRestParam)(params);

const isObjectMethodOrAccessor = (node: FunctionNode) =>
  node.type === AST_NODE_TYPES.FunctionExpression &&
  ((node.parent.type === AST_NODE_TYPES.Property &&
    (node.parent.kind === "get" || node.parent.kind === "set" || node.parent.method)) ||
    node.parent.type === AST_NODE_TYPES.MethodDefinition);

const isCallbackArgument = (node: FunctionNode) =>
  node.type !== AST_NODE_TYPES.FunctionDeclaration &&
  (node.parent.type === AST_NODE_TYPES.CallExpression ||
    node.parent.type === AST_NODE_TYPES.NewExpression) &&
  RA.some((arg: TSESTree.CallExpressionArgument) => arg === node)(node.parent.arguments);

const isContextIdentifierParam = (param: TSESTree.Parameter) =>
  param.type === AST_NODE_TYPES.Identifier && CONTEXT_PARAM_NAMES.has(param.name);

const hasContextFirstParam = flow(RA.head<TSESTree.Parameter>, O.exists(isContextIdentifierParam));

const hasOptionsArraySecondParam = flow(
  (params: ReadonlyArray<TSESTree.Parameter>) => RA.lookup(1)(params),
  O.exists((param) => param.type === AST_NODE_TYPES.ArrayPattern),
);

const isMetaProperty = (prop: TSESTree.ObjectLiteralElement) =>
  prop.type === AST_NODE_TYPES.Property &&
  prop.key.type === AST_NODE_TYPES.Identifier &&
  prop.key.name === "meta";

const isRuleObjectExpression = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.ObjectExpression && RA.some(isMetaProperty)(node.properties);

const isEslintCreateProperty = (node: FunctionNode) =>
  node.type !== AST_NODE_TYPES.FunctionDeclaration &&
  node.parent.type === AST_NODE_TYPES.Property &&
  node.parent.key.type === AST_NODE_TYPES.Identifier &&
  node.parent.key.name === "create" &&
  (hasContextFirstParam(node.params) ||
    hasOptionsArraySecondParam(node.params) ||
    isRuleObjectExpression(node.parent.parent));

const isEslintCodePathCallback = (node: FunctionNode) =>
  node.type !== AST_NODE_TYPES.FunctionDeclaration &&
  node.parent.type === AST_NODE_TYPES.Property &&
  node.parent.key.type === AST_NODE_TYPES.Identifier &&
  node.parent.key.name.startsWith("onCodePath");

const isExcludedFunction = Monoid.concatAll(Pred.getMonoidAny<FunctionNode>())([
  isObjectMethodOrAccessor,
  isCallbackArgument,
  isEslintCreateProperty,
  isEslintCodePathCallback,
]);

const shouldReportNode = (node: FunctionNode) => {
  const valueParams = getValueParams(node.params);
  return !isExcludedFunction(node) && !isRestOnly(valueParams) && valueParams.length >= 2;
};

const resolveVariableLabel = (parent: TSESTree.Node) =>
  match(parent)
    .with(
      { type: AST_NODE_TYPES.VariableDeclarator, id: { type: AST_NODE_TYPES.Identifier } },
      (decl) => ` '${decl.id.name}'`,
    )
    .with(P._, () => "")
    .exhaustive();

const resolveFunctionLabel = (node: FunctionNode) =>
  match(node)
    .with({ id: { type: AST_NODE_TYPES.Identifier } }, (fn) => ` '${fn.id.name}'`)
    .with(P._, (fn) => resolveVariableLabel(fn.parent))
    .exhaustive();

const formatCount = (count: number) => String(count);

const formatPayload = (actual: number) => (node: FunctionNode) => ({
  name: resolveFunctionLabel(node),
  actual: formatCount(actual),
});

const buildReportEffect =
  (report: ReportFn) =>
  (node: FunctionNode): IO.IO<void> =>
  () => {
    report({
      node,
      messageId: "preferCurried",
      data: formatPayload(getValueParams(node.params).length)(node),
    });
  };

const noopEffect: IO.IO<void> = IO.of(undefined);

const reportIfMultiParam =
  (report: ReportFn) =>
  (node: FunctionNode) => {
    match(shouldReportNode(node))
      .with(true, () => buildReportEffect(report)(node))
      .with(false, () => noopEffect)
      .exhaustive()();
  };

export const preferCurriedFunctions = createRule<[], MessageIds>({
  name: "prefer-curried-functions",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer data-last curried functions `(ctx) => (data) => ...` or `Reader` over multi-parameter functions for fluent `flow()` composition.",
    },
    messages: {
      preferCurried:
        "Function{{name}} takes {{actual}} parameters. Prefer data-last currying `(ctx) => (data) => ...` or `Reader` for fluent `flow()` composition.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const check = reportIfMultiParam((descriptor) => {
      context.report(descriptor);
    });
    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    };
  },
});
