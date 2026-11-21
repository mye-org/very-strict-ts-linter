import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";

type Options = [Partial<Record<"maxNestingDepth", number>>];
type MessageIds = "preferPipe" | "preferFlow";

const isPipeOrFlowName = (name: string) => name === "pipe" || name === "flow";

const isPipeOrFlowCall = (node: TSESTree.CallExpression) =>
  (node.callee.type === AST_NODE_TYPES.Identifier &&
    isPipeOrFlowName(node.callee.name)) ||
  (node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.property.type === AST_NODE_TYPES.Identifier &&
    isPipeOrFlowName(node.callee.property.name));

const isCallArg = (arg: TSESTree.CallExpressionArgument): arg is TSESTree.CallExpression =>
  arg.type === AST_NODE_TYPES.CallExpression;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const getMaxCallNestingDepth = (node: TSESTree.CallExpression): number =>
  isPipeOrFlowCall(node)
    ? 0
    : pipe(
        node.arguments,
        RA.filter(isCallArg),
        RA.reduce(0, (maxDepth, arg) => Math.max(maxDepth, getMaxCallNestingDepth(arg))),
        (maxChild) => 1 + maxChild,
      );

const getSingleBlockReturnCall = (body: TSESTree.BlockStatement) => {
  const firstStmt = body.body[0];
  return body.body.length === 1 &&
    firstStmt?.type === AST_NODE_TYPES.ReturnStatement &&
    firstStmt.argument?.type === AST_NODE_TYPES.CallExpression
    ? O.some(firstStmt.argument)
    : O.none;
};

const getArrowReturnCall = (node: TSESTree.ArrowFunctionExpression) =>
  match(node.body)
    .with({ type: AST_NODE_TYPES.CallExpression }, O.some)
    .with({ type: AST_NODE_TYPES.BlockStatement }, getSingleBlockReturnCall)
    .with(P._, () => O.none)
    .exhaustive();

const isSingleIdentParamArrow = (node: TSESTree.ArrowFunctionExpression) =>
  !node.async &&
  node.params.length === 1 &&
  node.params[0]?.type === AST_NODE_TYPES.Identifier;

const isArrowExprFlowCandidate = (node: TSESTree.CallExpression, parent: TSESTree.Node) =>
  parent.type === AST_NODE_TYPES.ArrowFunctionExpression &&
  parent.body === node &&
  isSingleIdentParamArrow(parent) &&
  getMaxCallNestingDepth(node) >= 2;

const isArrowBlockFlowCandidate = (node: TSESTree.CallExpression, parent: TSESTree.Node) =>
  parent.type === AST_NODE_TYPES.ReturnStatement &&
  parent.parent.type === AST_NODE_TYPES.BlockStatement &&
  parent.parent.body.length === 1 &&
  parent.parent.parent.type === AST_NODE_TYPES.ArrowFunctionExpression &&
  isSingleIdentParamArrow(parent.parent.parent) &&
  getMaxCallNestingDepth(node) >= 2;

const isDirectReturnBodyOfFlowCandidate = (node: TSESTree.CallExpression) =>
  isArrowExprFlowCandidate(node, node.parent) ||
  isArrowBlockFlowCandidate(node, node.parent);

const isReportablePipeCall = (node: TSESTree.CallExpression, maxNestingDepth: number) =>
  !isPipeOrFlowCall(node) &&
  !(node.parent.type === AST_NODE_TYPES.CallExpression && !isPipeOrFlowCall(node.parent)) &&
  !isDirectReturnBodyOfFlowCandidate(node) &&
  getMaxCallNestingDepth(node) > maxNestingDepth;

const isReportableFlowArrow = (node: TSESTree.ArrowFunctionExpression) =>
  isSingleIdentParamArrow(node) &&
  pipe(
    getArrowReturnCall(node),
    O.exists((call) => !isPipeOrFlowCall(call) && getMaxCallNestingDepth(call) >= 2),
  );

const checkFlowArrow = (
  node: TSESTree.ArrowFunctionExpression,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  match(isReportableFlowArrow(node))
    .with(true, () => { report({ node, messageId: "preferFlow" }); })
    .with(false, () => {})
    .exhaustive();
};

const checkPipeCall = (
  node: TSESTree.CallExpression,
  maxNestingDepth: number,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
) => {
  match(isReportablePipeCall(node, maxNestingDepth))
    .with(true, () => { report({ node, messageId: "preferPipe", data: { depth: String(getMaxCallNestingDepth(node)) } }); })
    .with(false, () => {})
    .exhaustive();
};

export const preferFunctionComposition = createRule<Options, MessageIds>({
  name: "prefer-function-composition",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Encourage function composition with `pipe` and `flow` over deeply nested calls and wrapper arrow functions.",
    },
    messages: {
      preferPipe: "Avoid deeply nested function calls (depth {{depth}}). Compose them with `pipe(...)`.",
      preferFlow: "Avoid wrapping nested function calls in an arrow function. Use `flow(...)` instead.",
    },
    schema: [
      { type: "object", properties: { maxNestingDepth: { type: "number", minimum: 1 } }, additionalProperties: false },
    ],
    defaultOptions: [{ maxNestingDepth: 2 }],
  },
  create: (context, [options]) => ({
    ArrowFunctionExpression: (node) => { checkFlowArrow(node, (d) => { context.report(d); }); },
    CallExpression: (node) => { checkPipeCall(node, options.maxNestingDepth ?? 2, (d) => { context.report(d); }); },
  }),
});
