import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as S from "fp-ts/lib/string.js";
import { pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import { getEstreeChildNodes, isFlowCallExpression, isPipeCallExpression } from "../utils/type-helpers.js";

// eslint-disable-next-line strict-fp/no-domain-raw-primitives -- ESLint rule schema requires boolean options
type Options = [Partial<Readonly<{ ignoreTrivialProjections: boolean; checkPipeSteps: boolean }>>];

type MessageIds = "mixedAbstractionLevels";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

type AbstractionCounts = Readonly<{
  high: ReadonlyArray<string>;
  low: ReadonlyArray<string>;
}>;

type AnalysisConfig = Readonly<{
  trivialProjections: "ignore" | "flag";
  pipeSteps: "check" | "skip";
  visitorKeys: TSESLint.SourceCode["visitorKeys"];
}>;

const lowLevelGlobalObjects = new Set([
  "JSON",
  "Math",
  "Object",
  "Number",
  "String",
  "Boolean",
  "Date",
  "Buffer",
  "RegExp",
  "Reflect",
  "Array",
]);

const lowLevelBuiltinFunctions = new Set([
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
]);

const lowLevelMethods = new Set([
  "trim",
  "trimStart",
  "trimEnd",
  "toLowerCase",
  "toUpperCase",
  "replace",
  "replaceAll",
  "split",
  "slice",
  "substring",
  "substr",
  "charAt",
  "charCodeAt",
  "indexOf",
  "lastIndexOf",
  "startsWith",
  "endsWith",
  "includes",
  "matchAll",
  "search",
  "padStart",
  "padEnd",
  "repeat",
  "splice",
  "join",
  "parse",
  "stringify",
  "keys",
  "values",
  "entries",
  "fromEntries",
  "assign",
  "freeze",
  "test",
  "exec",
  "isArray",
]);

const neutralCombinators = new Set([
  "pipe",
  "flow",
  "match",
  "with",
  "otherwise",
  "exhaustive",
  "map",
  "flatMap",
  "filter",
  "reduce",
  "forEach",
  "some",
  "every",
  "find",
  "findFirst",
  "fromNullable",
  "getOrElse",
  "fold",
  "exists",
  "uniq",
  "takeLeft",
  "dropLeft",
  "compact",
]);

const emptyCounts: AbstractionCounts = { high: [], low: [] };

const isFunctionNode = (node: TSESTree.Node): node is FunctionNode =>
  node.type === AST_NODE_TYPES.FunctionDeclaration ||
  node.type === AST_NODE_TYPES.FunctionExpression ||
  node.type === AST_NODE_TYPES.ArrowFunctionExpression;

const isPipeOrFlowCall = (node: TSESTree.CallExpression) =>
  isPipeCallExpression(node) || isFlowCallExpression(node);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive parent walk
const hasEnclosingFunction = (node: TSESTree.Node): boolean =>
  pipe(
    O.fromNullable(node.parent),
    O.exists((parent) => isFunctionNode(parent) || hasEnclosingFunction(parent)),
  );

const getCalleeName = (callee: TSESTree.Expression) =>
  match(callee)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => O.some(id.name))
    .with(
      { type: AST_NODE_TYPES.MemberExpression, property: { type: AST_NODE_TYPES.Identifier } },
      (mem) => O.some(mem.property.name),
    )
    .with(P._, () => O.none)
    .exhaustive();

const isLowLevelMemberCall = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.MemberExpression &&
  ((callee.object.type === AST_NODE_TYPES.Identifier &&
    lowLevelGlobalObjects.has(callee.object.name)) ||
    (callee.property.type === AST_NODE_TYPES.Identifier &&
      lowLevelMethods.has(callee.property.name)));

const isLowLevelIdentifierCall = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.Identifier && lowLevelBuiltinFunctions.has(callee.name);

const isTrivialProjectionBody = (body: TSESTree.Expression | TSESTree.BlockStatement) =>
  body.type === AST_NODE_TYPES.Identifier ||
  (body.type === AST_NODE_TYPES.MemberExpression &&
    body.object.type === AST_NODE_TYPES.Identifier);

const isSingleHighCallBody = (body: TSESTree.Expression | TSESTree.BlockStatement) =>
  body.type === AST_NODE_TYPES.CallExpression &&
  !isLowLevelMemberCall(body.callee) &&
  !isLowLevelIdentifierCall(body.callee);

const isAcceptableInlineArrow = (node: FunctionNode, trivialMode: AnalysisConfig["trivialProjections"]) =>
  node.type === AST_NODE_TYPES.ArrowFunctionExpression &&
  ((trivialMode === "ignore" && isTrivialProjectionBody(node.body)) ||
    isSingleHighCallBody(node.body));

const isRegexNode = (node: TSESTree.Node) =>
  (node.type === AST_NODE_TYPES.Literal && "regex" in node) ||
  (node.type === AST_NODE_TYPES.NewExpression &&
    node.callee.type === AST_NODE_TYPES.Identifier &&
    node.callee.name === "RegExp");

const isControlFlowStatement = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.IfStatement ||
  node.type === AST_NODE_TYPES.SwitchStatement ||
  node.type === AST_NODE_TYPES.ForStatement ||
  node.type === AST_NODE_TYPES.ForInStatement ||
  node.type === AST_NODE_TYPES.ForOfStatement ||
  node.type === AST_NODE_TYPES.WhileStatement ||
  node.type === AST_NODE_TYPES.DoWhileStatement ||
  node.type === AST_NODE_TYPES.TryStatement;

const mergeCounts = (a: AbstractionCounts, b: AbstractionCounts) => ({
  high: [...a.high, ...b.high],
  low: [...a.low, ...b.low],
});

const collectWithinBody = (
  node: TSESTree.Node,
  scope: "root" | "nested",
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
): ReadonlyArray<TSESTree.Node> =>
  scope === "nested" && isFunctionNode(node)
    ? [node]
    : [
        node,
        ...pipe(
          getEstreeChildNodes(node, visitorKeys),
          RA.flatMap((child) => collectWithinBody(child, "nested", visitorKeys)),
        ),
      ];

const toLowCount = (name: string) => ({ high: [] as ReadonlyArray<string>, low: [`${name}()`] });
const toHighCount = (name: string) => ({ high: [`${name}()`], low: [] as ReadonlyArray<string> });

const classifyCall = (node: TSESTree.CallExpression) =>
  isLowLevelMemberCall(node.callee) || isLowLevelIdentifierCall(node.callee)
    ? pipe(getCalleeName(node.callee), O.map(toLowCount), O.getOrElse(() => emptyCounts))
    : pipe(
        getCalleeName(node.callee),
        O.filter((name) => !neutralCombinators.has(name)),
        O.map(toHighCount),
        O.getOrElse(() => emptyCounts),
      );

const classifyFunctionStep = (
  fn: FunctionNode,
  trivialMode: AnalysisConfig["trivialProjections"],
) =>
  isAcceptableInlineArrow(fn, trivialMode) ? emptyCounts : { high: [] as ReadonlyArray<string>, low: ["inline lambda"] };

const classifyNonIdStep = (
  arg: TSESTree.CallExpressionArgument,
  trivialMode: AnalysisConfig["trivialProjections"],
) => (isFunctionNode(arg) ? classifyFunctionStep(arg, trivialMode) : emptyCounts);

const classifyPipeStep = (
  arg: TSESTree.CallExpressionArgument,
  trivialMode: AnalysisConfig["trivialProjections"],
) =>
  arg.type === AST_NODE_TYPES.Identifier
    ? { high: [arg.name], low: [] as ReadonlyArray<string> }
    : classifyNonIdStep(arg, trivialMode);

const getPipeSteps = (node: TSESTree.CallExpression) =>
  isPipeCallExpression(node) ? RA.dropLeft(1)(node.arguments) : node.arguments;

const classifyPipeCall = (
  node: TSESTree.CallExpression,
  trivialMode: AnalysisConfig["trivialProjections"],
) =>
  pipe(
    getPipeSteps(node),
    RA.map((step) => classifyPipeStep(step, trivialMode)),
    RA.reduce(emptyCounts, mergeCounts),
  );

const isNonEmptyTemplateLiteral = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.TemplateLiteral && node.expressions.length > 0;

const toLowCounts = (low: ReadonlyArray<string>) => ({ high: [] as ReadonlyArray<string>, low });

const classifyNonCallNode = (node: TSESTree.Node) =>
  pipe(
    [
      isRegexNode(node) ? O.some("RegExp") : O.none,
      isControlFlowStatement(node) ? O.some(node.type) : O.none,
      isNonEmptyTemplateLiteral(node) ? O.some("template literal") : O.none,
    ],
    RA.compact,
    toLowCounts,
  );

const classifyCallNode = (node: TSESTree.CallExpression, config: AnalysisConfig) =>
  config.pipeSteps === "check" && isPipeOrFlowCall(node)
    ? classifyPipeCall(node, config.trivialProjections)
    : classifyCall(node);

const classifyNode = (node: TSESTree.Node, config: AnalysisConfig) =>
  node.type === AST_NODE_TYPES.CallExpression
    ? classifyCallNode(node, config)
    : classifyNonCallNode(node);

const analyzeFunctionBody = (fn: FunctionNode, config: AnalysisConfig) =>
  pipe(
    collectWithinBody(fn.body, "root", config.visitorKeys),
    RA.map((n) => classifyNode(n, config)),
    RA.reduce(emptyCounts, mergeCounts),
  );

const formatExamples = (items: ReadonlyArray<string>) =>
  pipe(items, RA.uniq(S.Eq), RA.takeLeft(3)).join(", ");

const reportIfMixed = (
  node: TSESTree.Node,
  counts: AbstractionCounts,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(counts.high.length > 0 && counts.low.length > 0)
    .with(true, () => {
      report({
        node,
        messageId: "mixedAbstractionLevels",
        data: {
          highExamples: formatExamples(counts.high),
          lowExamples: formatExamples(counts.low),
        },
      });
    })
    .with(false, () => {})
    .exhaustive();
};

const toConfig = (
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
  options?: Options[0],
) => ({
  trivialProjections: options?.ignoreTrivialProjections === false ? ("flag" as const) : ("ignore" as const),
  pipeSteps: options?.checkPipeSteps === false ? ("skip" as const) : ("check" as const),
  visitorKeys,
});

const checkFlowNode = (
  node: TSESTree.CallExpression,
  config: AnalysisConfig,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(config.pipeSteps === "check" && isFlowCallExpression(node) && !hasEnclosingFunction(node))
    .with(true, () => { reportIfMixed(node, classifyPipeCall(node, config.trivialProjections), report); })
    .with(false, () => {})
    .exhaustive();
};

const createHandlers = (
  config: AnalysisConfig,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  const check = (node: FunctionNode) => {
    reportIfMixed(node, analyzeFunctionBody(node, config), report);
  };
  return {
    FunctionDeclaration: check,
    FunctionExpression: check,
    ArrowFunctionExpression: check,
    CallExpression: (node: TSESTree.CallExpression) => { checkFlowNode(node, config, report); },
  } satisfies TSESLint.RuleListener;
};

export const singleLevelOfAbstraction = createRule<Options, MessageIds>({
  name: "single-level-of-abstraction",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Enforce the Single Level of Abstraction Principle (SLAP) by flagging functions that mix high-level calls with low-level implementation details.",
    },
    messages: {
      mixedAbstractionLevels:
        "Function mixes abstraction levels: combines high-level calls ({{highExamples}}) with low-level implementation details ({{lowExamples}}). Extract the low-level details into named helper functions.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ignoreTrivialProjections: { type: "boolean" },
          checkPipeSteps: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ ignoreTrivialProjections: true, checkPipeSteps: true }],
  },
  create: (context, [options]) =>
    createHandlers(toConfig(context.sourceCode.visitorKeys, options), (d) => { context.report(d); }),
});
