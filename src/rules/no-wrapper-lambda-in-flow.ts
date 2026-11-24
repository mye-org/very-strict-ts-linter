import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as IO from "fp-ts/lib/IO.js";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { isFlowCallExpression } from "../lib/flow-call.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "noWrapperLambdaInFlow";

type WrapperFunction = TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression;

type ReportFn = (descriptor: TSESLint.ReportDescriptor<MessageIds>) => void;

const THIS_IDENTIFIERS: ReadonlySet<string> = new Set(["this"]);

const FP_TS_MODULE_ALIASES: ReadonlySet<string> = new Set([
  "O",
  "E",
  "RA",
  "A",
  "NEA",
  "TE",
  "RTE",
  "R",
  "T",
  "S",
  "RR",
  "IO",
  "IOE",
  "TO",
  "Ord",
  "Eq",
  "B",
  "Option",
  "Either",
  "ReadonlyArray",
  "TaskEither",
  "ReaderTaskEither",
  "Reader",
  "Task",
  "State",
  "ReadonlyRecord",
]);

const FP_TS_COMBINATOR_NAMES: ReadonlySet<string> = new Set([
  "map",
  "flatMap",
  "chain",
  "chainFirst",
  "filter",
  "filterMap",
  "bimap",
  "mapLeft",
  "orElse",
  "fold",
  "foldW",
  "match",
  "matchW",
  "reduce",
  "exists",
  "every",
  "some",
  "findFirst",
  "alt",
  "altW",
  "ap",
  "tap",
  "contramap",
  "local",
  "fromPredicate",
  "partition",
  "partitionMap",
  "traverse",
  "sequence",
]);

const isFlowMemberCall = (call: TSESTree.CallExpression) =>
  call.callee.type === AST_NODE_TYPES.MemberExpression &&
  !call.callee.computed &&
  call.callee.property.type === AST_NODE_TYPES.Identifier &&
  call.callee.property.name === "flow";

const isAnyFlowCall = Pred.or(isFlowMemberCall)(isFlowCallExpression);

const isFpTsCombinatorCallee = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.MemberExpression &&
  !callee.computed &&
  callee.object.type === AST_NODE_TYPES.Identifier &&
  FP_TS_MODULE_ALIASES.has(callee.object.name) &&
  callee.property.type === AST_NODE_TYPES.Identifier &&
  FP_TS_COMBINATOR_NAMES.has(callee.property.name);

const isSameAstNode = (target: TSESTree.Node) => (candidate: TSESTree.Node) => candidate === target;

const isDirectArgOfCall = (call: TSESTree.CallExpression) => (node: TSESTree.Node) =>
  RA.some(isSameAstNode(node))(call.arguments);

const isInsideFlowCombinatorCall = (call: TSESTree.CallExpression) =>
  call.parent.type === AST_NODE_TYPES.CallExpression &&
  isAnyFlowCall(call.parent) &&
  isDirectArgOfCall(call.parent)(call);

const isFlowOrFpTsContext = (node: WrapperFunction) =>
  node.parent.type === AST_NODE_TYPES.CallExpression &&
  isDirectArgOfCall(node.parent)(node) &&
  (isAnyFlowCall(node.parent) ||
    isFpTsCombinatorCallee(node.parent.callee) ||
    isInsideFlowCombinatorCall(node.parent));

const isSingleIdentParam = (node: WrapperFunction) =>
  !node.async &&
  !node.generator &&
  node.params.length === 1 &&
  O.exists(
    (p: TSESTree.Parameter) =>
      p.type === AST_NODE_TYPES.Identifier && !THIS_IDENTIFIERS.has(p.name),
  )(O.fromNullable(node.params[0]));

const extractSingleIdentParam = flow(
  (node: WrapperFunction) => node.params[0],
  O.fromNullable,
  O.filter(
    (p): p is TSESTree.Identifier =>
      p.type === AST_NODE_TYPES.Identifier && !THIS_IDENTIFIERS.has(p.name),
  ),
);

const extractBlockReturnCall = flow(
  (body: TSESTree.BlockStatement) => body.body,
  O.fromPredicate((stmts: ReadonlyArray<TSESTree.Statement>) => stmts.length === 1),
  O.flatMap(RA.head),
  O.filter((stmt): stmt is TSESTree.ReturnStatement => stmt.type === AST_NODE_TYPES.ReturnStatement),
  O.flatMap((ret) => O.fromNullable(ret.argument)),
  O.filter((arg): arg is TSESTree.CallExpression => arg.type === AST_NODE_TYPES.CallExpression),
);

const extractBodyCall = (node: WrapperFunction) =>
  match(node.body)
    .with({ type: AST_NODE_TYPES.CallExpression }, O.some)
    .with({ type: AST_NODE_TYPES.BlockStatement }, extractBlockReturnCall)
    .with(P._, () => O.none satisfies O.Option<TSESTree.CallExpression>)
    .exhaustive();

const matchesParamIdent = (param: TSESTree.Identifier) => (id: TSESTree.Identifier) =>
  id === param;

const hasParamIdent = (param: TSESTree.Identifier) => (variable: TSESLint.Scope.Variable) =>
  RA.some(matchesParamIdent(param))(variable.identifiers);

const findInVars =
  (declaredVars: ReadonlyArray<TSESLint.Scope.Variable>) =>
  (pred: (variable: TSESLint.Scope.Variable) => boolean) =>
    RA.findFirst(pred)(declaredVars);

const findParamVariable = (declaredVars: ReadonlyArray<TSESLint.Scope.Variable>) =>
  flow(hasParamIdent, findInVars(declaredVars));

const isRefDirectArg = (call: TSESTree.CallExpression) => (ref: TSESLint.Scope.Reference) =>
  isDirectArgOfCall(call)(ref.identifier);

const hasSingleForwardedReadRef =
  (call: TSESTree.CallExpression) => (variable: TSESLint.Scope.Variable) => {
    const readRefs = RA.filter((ref: TSESLint.Scope.Reference) => ref.isRead())(variable.references);
    return readRefs.length === 1 && O.exists(isRefDirectArg(call))(RA.head(readRefs));
  };

const hasForwardedParamRef =
  (call: TSESTree.CallExpression) =>
  (declaredVars: ReadonlyArray<TSESLint.Scope.Variable>) =>
  (node: WrapperFunction) => {
    const check = flow(
      extractSingleIdentParam,
      O.flatMap(findParamVariable(declaredVars)),
      O.exists(hasSingleForwardedReadRef(call)),
    );
    return check(node);
  };

const isMultiArgAdaptingCall =
  (sourceCode: Readonly<TSESLint.SourceCode>) =>
  (node: WrapperFunction) =>
  (call: TSESTree.CallExpression) =>
    call.callee.type !== AST_NODE_TYPES.Super &&
    call.arguments.length >= 2 &&
    hasForwardedParamRef(call)(sourceCode.getDeclaredVariables(node))(node);

const isWrapperLambdaInFlow =
  (sourceCode: Readonly<TSESLint.SourceCode>) => (node: WrapperFunction) =>
    isSingleIdentParam(node) &&
    isFlowOrFpTsContext(node) &&
    O.exists(isMultiArgAdaptingCall(sourceCode)(node))(extractBodyCall(node));

const buildReportEffect =
  (report: ReportFn) =>
  (node: WrapperFunction): IO.IO<void> =>
  () => {
    report({ node, messageId: "noWrapperLambdaInFlow" });
  };

const noopEffect: IO.IO<void> = IO.of(undefined);

const checkWrapper =
  (sourceCode: Readonly<TSESLint.SourceCode>) =>
  (report: ReportFn) =>
  (node: WrapperFunction) => {
    match(isWrapperLambdaInFlow(sourceCode)(node))
      .with(true, () => buildReportEffect(report)(node))
      .with(false, () => noopEffect)
      .exhaustive()();
  };

export const noWrapperLambdaInFlow = createRule<[], MessageIds>({
  name: "no-wrapper-lambda-in-flow",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow wrapper lambdas in `flow()` or `fp-ts` combinators that only adapt a multi-argument function to 1 argument by forwarding the parameter alongside captured arguments.",
    },
    messages: {
      noWrapperLambdaInFlow:
        "Avoid wrapper lambda that adapts a multi-argument function inside `flow()` or an `fp-ts` combinator. Curry the target function data-last `(ctx) => (data) => ...` so it can be passed directly.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const check = checkWrapper(context.sourceCode)((descriptor) => {
      context.report(descriptor);
    });
    return {
      ArrowFunctionExpression: check,
      FunctionExpression: check,
    };
  },
});
