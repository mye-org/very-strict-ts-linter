import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { isFlowCallExpression } from "../lib/flow-call.js";
import { isPipeCallExpression } from "../lib/pipe-call.js";
import { createRule } from "../lib/rule-factory.js";

type Options = [Partial<Record<"maxNestingDepth", number>>];
type MessageIds = "preferFlowComposition" | "preferFlow";

const PIPE_OR_FLOW_NAMES: ReadonlySet<string> = new Set(["pipe", "flow"]);

const isPipeOrFlowMember = (member: TSESTree.MemberExpression) =>
  member.property.type === AST_NODE_TYPES.Identifier &&
  PIPE_OR_FLOW_NAMES.has(member.property.name);

const isPipeOrFlowCall = (node: TSESTree.CallExpression) =>
  isFlowCallExpression(node) ||
  isPipeCallExpression(node) ||
  (node.callee.type === AST_NODE_TYPES.MemberExpression && isPipeOrFlowMember(node.callee));

const isCallArg = (arg: TSESTree.CallExpressionArgument): arg is TSESTree.CallExpression =>
  arg.type === AST_NODE_TYPES.CallExpression;

const pickGreater = (a: number, b: number) => Math.max(a, b);

const accumulateArgDepth = (maxDepth: number, arg: TSESTree.CallExpression) =>
  pickGreater(maxDepth, computeMaxCallNestingDepth(arg));

const computeMaxArgDepth = flow(RA.filter(isCallArg), RA.reduce(0, accumulateArgDepth));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const computeMaxCallNestingDepth = (node: TSESTree.CallExpression): number =>
  isPipeOrFlowCall(node) ? 0 : 1 + computeMaxArgDepth(node.arguments);

const resolveSingleBlockReturnCall = (body: TSESTree.BlockStatement) => {
  const firstStmt = body.body[0];
  return body.body.length === 1 &&
    firstStmt?.type === AST_NODE_TYPES.ReturnStatement &&
    firstStmt.argument?.type === AST_NODE_TYPES.CallExpression
    ? O.some(firstStmt.argument)
    : O.none;
};

const resolveArrowReturnCall = (node: TSESTree.ArrowFunctionExpression) =>
  match(node.body)
    .with({ type: AST_NODE_TYPES.CallExpression }, O.some)
    .with({ type: AST_NODE_TYPES.BlockStatement }, resolveSingleBlockReturnCall)
    .with(P._, () => O.none)
    .exhaustive();

const isIdentifierParam = O.exists(
  (p: TSESTree.Parameter) => p.type === AST_NODE_TYPES.Identifier,
);

const isSingleIdentParamArrow = (node: TSESTree.ArrowFunctionExpression) =>
  !node.async && node.params.length === 1 && isIdentifierParam(O.fromNullable(node.params[0]));

const isArrowExprFlowCandidate = (node: TSESTree.CallExpression, parent: TSESTree.Node) =>
  parent.type === AST_NODE_TYPES.ArrowFunctionExpression &&
  parent.body === node &&
  isSingleIdentParamArrow(parent) &&
  computeMaxCallNestingDepth(node) >= 2;

const isSingleStmtArrowBlock = (block: TSESTree.BlockStatement) =>
  block.body.length === 1 &&
  block.parent.type === AST_NODE_TYPES.ArrowFunctionExpression &&
  isSingleIdentParamArrow(block.parent);

const isArrowBlockFlowCandidate = (node: TSESTree.CallExpression, parent: TSESTree.Node) =>
  parent.type === AST_NODE_TYPES.ReturnStatement &&
  parent.parent.type === AST_NODE_TYPES.BlockStatement &&
  isSingleStmtArrowBlock(parent.parent) &&
  computeMaxCallNestingDepth(node) >= 2;

const isDirectReturnBodyOfFlowCandidate = (node: TSESTree.CallExpression) =>
  isArrowExprFlowCandidate(node, node.parent) ||
  isArrowBlockFlowCandidate(node, node.parent);

const isReportableNestedCall = (node: TSESTree.CallExpression, maxNestingDepth: number) =>
  !isPipeOrFlowCall(node) &&
  !(node.parent.type === AST_NODE_TYPES.CallExpression && !isPipeOrFlowCall(node.parent)) &&
  !isDirectReturnBodyOfFlowCandidate(node) &&
  computeMaxCallNestingDepth(node) > maxNestingDepth;

const isDeepNonFlowCall = (call: TSESTree.CallExpression) =>
  !isPipeOrFlowCall(call) && computeMaxCallNestingDepth(call) >= 2;

const isReportableFlowArrow = (node: TSESTree.ArrowFunctionExpression) =>
  isSingleIdentParamArrow(node) && O.exists(isDeepNonFlowCall)(resolveArrowReturnCall(node));

const checkFlowArrow = (
  node: TSESTree.ArrowFunctionExpression,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  match(isReportableFlowArrow(node))
    .with(true, () => { report({ node, messageId: "preferFlow" }); })
    .with(false, () => {})
    .exhaustive();
};

const formatDepthFields = (depth: number) => ({
  depth: String(depth),
});

const checkNestedCall = (
  node: TSESTree.CallExpression,
  maxNestingDepth: number,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
) => {
  match(isReportableNestedCall(node, maxNestingDepth))
    .with(true, () => {
      report({
        node,
        messageId: "preferFlowComposition",
        data: formatDepthFields(computeMaxCallNestingDepth(node)),
      });
    })
    .with(false, () => {})
    .exhaustive();
};

export const preferFunctionComposition = createRule<Options, MessageIds>({
  name: "prefer-function-composition",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Encourage function composition with `flow` over deeply nested calls and wrapper arrow functions.",
    },
    messages: {
      preferFlowComposition: "Avoid deeply nested function calls (depth {{depth}}). Compose them with `flow(...)`.",
      preferFlow: "Avoid wrapping nested function calls in an arrow function. Use `flow(...)` instead.",
    },
    schema: [
      { type: "object", properties: { maxNestingDepth: { type: "number", minimum: 1 } }, additionalProperties: false },
    ],
    defaultOptions: [{ maxNestingDepth: 2 }],
  },
  create: (context, [options]) => ({
    ArrowFunctionExpression: (node) => { checkFlowArrow(node, (d) => { context.report(d); }); },
    CallExpression: (node) => { checkNestedCall(node, options.maxNestingDepth ?? 2, (d) => { context.report(d); }); },
  }),
});
