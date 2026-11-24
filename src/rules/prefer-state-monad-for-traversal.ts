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
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "preferStateMonadForTraversal";

type FunctionCandidate = Readonly<{
  readonly name: string;
  readonly reportNode: TSESTree.Node;
  readonly params: ReadonlyArray<TSESTree.Parameter>;
  readonly body: TSESTree.Node;
}>;

type ParamInfo = Readonly<{
  readonly index: number;
  readonly name: string;
  readonly paramNode: TSESTree.Identifier;
}>;

type CollectContext = Readonly<{
  readonly fnName: string;
  readonly visitorKeys: TSESLint.SourceCode["visitorKeys"];
}>;

type StateParamContext = Readonly<{
  readonly totalParams: number;
  readonly recursiveCalls: ReadonlyArray<TSESTree.CallExpression>;
  readonly services: ParserServicesWithTypeInformation;
  readonly checker: ts.TypeChecker;
}>;

const STATE_PARAM_NAMES: ReadonlySet<string> = new Set([
  "visited",
  "seen",
  "acc",
  "accumulator",
  "queue",
  "stack",
  "worklist",
  "state",
  "collected",
]);

const COLLECTION_TYPE_NAMES: ReadonlySet<string> = new Set([
  "ReadonlySet",
  "Set",
  "ReadonlyMap",
  "Map",
  "ReadonlyArray",
  "Array",
]);

const unwrapSatisfies = (expr: TSESTree.Expression): TSESTree.Expression =>
  expr.type === AST_NODE_TYPES.TSSatisfiesExpression ? expr.expression : expr;

const extractFunctionCandidateFromDecl = (
  node: TSESTree.FunctionDeclaration,
): O.Option<FunctionCandidate> =>
  node.id
    ? O.some({
        name: node.id.name,
        reportNode: node,
        params: node.params,
        body: node.body,
      })
    : O.none;

const extractFunctionCandidateFromVar = (
  node: TSESTree.VariableDeclarator,
): O.Option<FunctionCandidate> =>
  match({
    id: node.id,
    fn: O.map(unwrapSatisfies)(O.fromNullable(node.init)),
  })
    .with(
      {
        id: { type: AST_NODE_TYPES.Identifier },
        fn: {
          _tag: "Some",
          value: {
            type: P.union(
              AST_NODE_TYPES.ArrowFunctionExpression,
              AST_NODE_TYPES.FunctionExpression,
            ),
          },
        },
      },
      ({ id, fn }) =>
        O.some({
          name: id.name,
          reportNode: node,
          params: fn.value.params,
          body: fn.value.body,
        }),
    )
    .otherwise(() => O.none);

const unwrapParamIdentifier = (param: TSESTree.Parameter): O.Option<TSESTree.Identifier> =>
  match(param)
    .with({ type: AST_NODE_TYPES.Identifier }, O.some)
    .with(
      {
        type: AST_NODE_TYPES.AssignmentPattern,
        left: { type: AST_NODE_TYPES.Identifier },
      },
      (ap) => O.some(ap.left),
    )
    .otherwise(() => O.none);

const toParamInfo = (index: number) => (paramNode: TSESTree.Identifier): ParamInfo => ({
  index,
  name: paramNode.name,
  paramNode,
});

const extractParamInfos = RA.filterMapWithIndex(
  (index: number, param: TSESTree.Parameter) =>
    O.map(toParamInfo(index))(unwrapParamIdentifier(param)),
);

const isDirectCallTo = (fnName: string) => (node: TSESTree.Node): O.Option<TSESTree.CallExpression> =>
  node.type === AST_NODE_TYPES.CallExpression &&
  node.callee.type === AST_NODE_TYPES.Identifier &&
  node.callee.name === fnName
    ? O.some(node)
    : O.none;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const collectDirectCalls =
  (ctx: CollectContext) =>
  (node: TSESTree.Node): ReadonlyArray<TSESTree.CallExpression> => [
    ...O.match(
      () => [] satisfies ReadonlyArray<TSESTree.CallExpression>,
      (call: TSESTree.CallExpression) => [call] satisfies ReadonlyArray<TSESTree.CallExpression>,
    )(isDirectCallTo(ctx.fnName)(node)),
    ...RA.flatMap(collectDirectCalls(ctx))(collectEstreeChildNodes(ctx.visitorKeys)(node)),
  ];

const isCollectionSymbolName = flow(
  O.fromNullable<ts.Symbol | undefined>,
  O.exists((s: ts.Symbol) => COLLECTION_TYPE_NAMES.has(s.name)),
);

const hasCollectionTsType = (
  ctx: Readonly<{
    readonly services: ParserServicesWithTypeInformation;
    readonly checker: ts.TypeChecker;
  }>,
) =>
  flow(
    (n: TSESTree.Identifier) => ctx.services.esTreeNodeToTSNodeMap.get(n),
    (tsNode) => ctx.checker.getTypeAtLocation(tsNode),
    (tsType) =>
      isCollectionSymbolName(tsType.aliasSymbol) || isCollectionSymbolName(tsType.getSymbol()),
  );

const isUpdatedInCall = (
  ctx: Readonly<{ readonly paramIndex: number; readonly paramName: string }>,
) =>
  flow(
    (call: TSESTree.CallExpression) => call.arguments,
    RA.lookup(ctx.paramIndex),
    O.exists(
      (arg: TSESTree.CallExpressionArgument) =>
        !(arg.type === AST_NODE_TYPES.Identifier && arg.name === ctx.paramName),
    ),
  );

const isUpdatedInAnyRecursiveCall =
  (recursiveCalls: ReadonlyArray<TSESTree.CallExpression>) =>
  (param: ParamInfo) =>
    RA.some(isUpdatedInCall({ paramIndex: param.index, paramName: param.name }))(recursiveCalls);

const isStateParam =
  (ctx: StateParamContext) =>
  (param: ParamInfo) =>
    STATE_PARAM_NAMES.has(param.name) ||
    (ctx.totalParams >= 2 &&
      hasCollectionTsType({ services: ctx.services, checker: ctx.checker })(param.paramNode) &&
      isUpdatedInAnyRecursiveCall(ctx.recursiveCalls)(param));

const findStateParam =
  (
    ctx: Readonly<{
      readonly paramInfos: ReadonlyArray<ParamInfo>;
      readonly totalParams: number;
      readonly services: ParserServicesWithTypeInformation;
      readonly checker: ts.TypeChecker;
    }>,
  ) =>
  (recursiveCalls: ReadonlyArray<TSESTree.CallExpression>) =>
    RA.findFirst(
      isStateParam({
        totalParams: ctx.totalParams,
        recursiveCalls,
        services: ctx.services,
        checker: ctx.checker,
      }),
    )(ctx.paramInfos);

const checkRecursiveCalls = (
  ctx: Readonly<{
    readonly candidate: FunctionCandidate;
    readonly paramInfos: ReadonlyArray<ParamInfo>;
    readonly services: ParserServicesWithTypeInformation;
    readonly checker: ts.TypeChecker;
    readonly onReport: (stateParam: ParamInfo) => IO.IO<void>;
  }>,
) =>
  flow(
    O.fromPredicate((calls: ReadonlyArray<TSESTree.CallExpression>) => calls.length > 0),
    O.flatMap(
      findStateParam({
        paramInfos: ctx.paramInfos,
        totalParams: ctx.candidate.params.length,
        services: ctx.services,
        checker: ctx.checker,
      }),
    ),
    O.match(() => IO.of<void>(undefined), ctx.onReport),
  );

const reportFinding =
  (context: TSESLint.RuleContext<MessageIds, []>) =>
  (candidate: FunctionCandidate) =>
  (stateParam: ParamInfo): IO.IO<void> =>
  () => {
    context.report({
      node: candidate.reportNode,
      messageId: "preferStateMonadForTraversal",
      data: { fnName: candidate.name, paramName: stateParam.name },
    });
  };

const inspectBody =
  (
    ctx: Readonly<{
      readonly services: ParserServicesWithTypeInformation;
      readonly visitorKeys: TSESLint.SourceCode["visitorKeys"];
      readonly onReport: (candidate: FunctionCandidate) => (stateParam: ParamInfo) => IO.IO<void>;
    }>,
  ) =>
  (candidate: FunctionCandidate) =>
    flow(
      collectDirectCalls({
        fnName: candidate.name,
        visitorKeys: ctx.visitorKeys,
      }),
      checkRecursiveCalls({
        candidate,
        paramInfos: extractParamInfos(candidate.params),
        services: ctx.services,
        checker: ctx.services.program.getTypeChecker(),
        onReport: ctx.onReport(candidate),
      }),
    );

const checkCandidate =
  (
    ctx: Readonly<{
      readonly services: ParserServicesWithTypeInformation;
      readonly visitorKeys: TSESLint.SourceCode["visitorKeys"];
      readonly onReport: (candidate: FunctionCandidate) => (stateParam: ParamInfo) => IO.IO<void>;
    }>,
  ) =>
  (candidate: FunctionCandidate): IO.IO<void> =>
    inspectBody(ctx)(candidate)(candidate.body);

export const preferStateMonadForTraversal = createRule<[], MessageIds>({
  name: "prefer-state-monad-for-traversal",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag recursive traversal functions that manually thread a state or accumulator parameter, and suggest `fp-ts/State` (`S.gets`, `S.modify`, `S.traverseArray`).",
    },
    messages: {
      preferStateMonadForTraversal:
        "Recursive function `{{fnName}}` manually threads state parameter `{{paramName}}`. Use `fp-ts/State` (`S.gets`, `S.modify`, `S.traverseArray`) instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const inspect = checkCandidate({
      services: ESLintUtils.getParserServices(context),
      visitorKeys: context.sourceCode.visitorKeys,
      onReport: reportFinding(context),
    });
    return {
      FunctionDeclaration: (node) => {
        O.match(() => IO.of<void>(undefined), inspect)(extractFunctionCandidateFromDecl(node))();
      },
      VariableDeclarator: (node) => {
        O.match(() => IO.of<void>(undefined), inspect)(extractFunctionCandidateFromVar(node))();
      },
    };
  },
});
