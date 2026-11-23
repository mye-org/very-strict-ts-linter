import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { match, P } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";

// eslint-disable-next-line strict-fp/prefer-union-over-boolean -- ESLint rule schema requires boolean options
type Options = [Readonly<Record<"maxParams", number> & Record<"ignoreCallbacks", boolean>>];
type MessageIds = "tooManyParams";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

type ReportFn = (descriptor: TSESLint.ReportDescriptor<MessageIds>) => void;

const THIS_PARAM_NAMES: ReadonlySet<string> = new Set(["this"]);

const isExplicitThisParam = (param: TSESTree.Parameter) =>
  param.type === AST_NODE_TYPES.Identifier && THIS_PARAM_NAMES.has(param.name);

const countValueParams = (params: ReadonlyArray<TSESTree.Parameter>) =>
  RA.filter((param: TSESTree.Parameter) => !isExplicitThisParam(param))(params).length;

const isCallbackArgument = (node: FunctionNode) =>
  node.type !== AST_NODE_TYPES.FunctionDeclaration &&
  node.parent.type === AST_NODE_TYPES.CallExpression &&
  RA.some((arg: TSESTree.CallExpressionArgument) => arg === node)(node.parent.arguments);

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

const formatParamPayload = (node: FunctionNode, counts: readonly [number, number]) => ({
  name: resolveFunctionLabel(node),
  actual: formatCount(counts[0]),
  max: formatCount(counts[1]),
});

const shouldReportNode = (
  node: FunctionNode,
  options: Options[0],
) =>
  !(options.ignoreCallbacks && isCallbackArgument(node)) &&
  countValueParams(node.params) > options.maxParams;

const reportIfTooManyParams =
  (options: Options[0], report: ReportFn) =>
  (node: FunctionNode) => {
    match(shouldReportNode(node, options))
      .with(true, () => {
        report({
          node,
          messageId: "tooManyParams",
          data: formatParamPayload(node, [countValueParams(node.params), options.maxParams]),
        });
      })
      .with(false, () => {})
      .exhaustive();
  };

export const maxFunctionParams = createRule<Options, MessageIds>({
  name: "max-function-params",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag functions taking more than 2 parameters; discourage ad-hoc parameter objects and encourage discovering hidden domain concepts.",
    },
    messages: {
      tooManyParams:
        "Function{{name}} takes {{actual}} parameters (max {{max}}). Do not simply wrap them in an ad-hoc parameter object; look for hidden domain concepts (Value Objects), split distinct responsibilities, or move shared context into a Reader/curried boundary.",
    },
    schema: [
      {
        type: "object",
        properties: {
          maxParams: { type: "number", minimum: 1 },
          ignoreCallbacks: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ maxParams: 2, ignoreCallbacks: false }],
  },
  create: (context, [options]) => {
    const check = reportIfTooManyParams(options, (descriptor) => {
      context.report(descriptor);
    });
    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    };
  },
});
