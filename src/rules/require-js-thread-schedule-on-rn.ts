import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { isEsTreeFunctionNode } from "../lib/estree-function-nodes.js";
import { isScheduleOnRnCall, isWorkletFunction } from "../lib/reanimated-worklet.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds =
  | "inlineWorkletCallback"
  | "uiRuntimeCreatedCallback"
  | "uiRuntimeDefinedCallback";

type Reporter = (d: TSESLint.ReportDescriptor<MessageIds>) => void;

const isTsxFilename = (filename: string) => filename.endsWith(".tsx");

const isInsideWorklet: Pred.Predicate<TSESTree.Node> = flow(
  (n: TSESTree.Node) => n.parent,
  O.fromNullable,
  O.exists((parent) =>
    (isEsTreeFunctionNode(parent) && isWorkletFunction(parent)) || isInsideWorklet(parent),
  ),
);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive scope lookup
const resolveLexicalVariable = (scope: TSESLint.Scope.Scope, name: string): O.Option<TSESLint.Scope.Variable> =>
  O.alt(() =>
    O.flatMap((upper: TSESLint.Scope.Scope) => resolveLexicalVariable(upper, name))(
      O.fromNullable(scope.upper),
    ),
  )(RA.findFirst((v: TSESLint.Scope.Variable) => v.name === name)(scope.variables));

const isUiRuntimeDefinition = (def: TSESLint.Scope.Definition) =>
  def.type !== TSESLint.Scope.DefinitionType.ImportBinding &&
  def.type !== TSESLint.Scope.DefinitionType.Parameter &&
  isInsideWorklet(def.node);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const extractRootIdentifier = (expr: TSESTree.Expression): O.Option<TSESTree.Identifier> =>
  match(expr)
    .with({ type: AST_NODE_TYPES.Identifier }, O.some)
    .with({ type: AST_NODE_TYPES.MemberExpression }, (m) => extractRootIdentifier(m.object))
    .with({ type: AST_NODE_TYPES.ChainExpression }, (c) => extractRootIdentifier(c.expression))
    .with(P._, () => O.none)
    .exhaustive();

const resolveIdVariable =
  (scope: TSESLint.Scope.Scope) => (id: TSESTree.Identifier) => {
    const resolve = flow(
      (name: string) => resolveLexicalVariable(scope, name),
      O.map((variable) => ({ name: id.name, variable })),
    );
    return resolve(id.name);
  };

const checkIdentifierOrMemberArg = (
  arg: TSESTree.Expression,
  scope: TSESLint.Scope.Scope,
  report: Reporter,
) => {
  const check = flow(
    extractRootIdentifier,
    O.flatMap(resolveIdVariable(scope)),
    O.filter(({ variable }) => RA.some(isUiRuntimeDefinition)(variable.defs)),
    O.map(({ name }) => {
      report({ node: arg, messageId: "uiRuntimeDefinedCallback", data: { name } });
    }),
  );
  check(arg);
};

const reportTargetByKind = (
  arg: TSESTree.CallExpressionArgument,
  node: TSESTree.CallExpression,
  sourceCode: TSESLint.SourceCode,
  report: Reporter,
) => {
  match(arg)
    .with(
      { type: AST_NODE_TYPES.ArrowFunctionExpression },
      { type: AST_NODE_TYPES.FunctionExpression },
      () => {
        report({ node: arg, messageId: "inlineWorkletCallback" });
      },
    )
    .with({ type: AST_NODE_TYPES.CallExpression }, () => {
      report({ node: arg, messageId: "uiRuntimeCreatedCallback" });
    })
    .with(
      { type: AST_NODE_TYPES.Identifier },
      { type: AST_NODE_TYPES.MemberExpression },
      { type: AST_NODE_TYPES.ChainExpression },
      (expr) => {
        checkIdentifierOrMemberArg(expr, sourceCode.getScope(node), report);
      },
    )
    .with(P._, () => {})
    .exhaustive();
};

const checkScheduleOnRnCall = (
  node: TSESTree.CallExpression,
  sourceCode: TSESLint.SourceCode,
  report: Reporter,
) => {
  const check = flow(
    O.fromPredicate((c: TSESTree.CallExpression) => isScheduleOnRnCall(c) && isInsideWorklet(c)),
    O.flatMap((c) => O.fromNullable(c.arguments[0])),
    O.map((arg) => {
      reportTargetByKind(arg, node, sourceCode, report);
    }),
  );
  check(node);
};

export const requireJsThreadScheduleOnRn = createRule<[], MessageIds>({
  name: "require-js-thread-schedule-on-rn",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require functions passed to Reanimated `scheduleOnRN` inside worklets in .tsx files to be defined in JavaScript thread scope (component body or module scope), not in the UI runtime.",
    },
    messages: {
      inlineWorkletCallback:
        "Function passed to `scheduleOnRN` is defined inline inside a worklet (UI runtime). Define it in the JavaScript thread scope (component body or module scope) instead.",
      uiRuntimeCreatedCallback:
        "Function passed to `scheduleOnRN` is created inside a worklet (UI runtime). Define it in the JavaScript thread scope and pass any arguments as additional parameters to `scheduleOnRN`.",
      uiRuntimeDefinedCallback:
        "Function `{{name}}` passed to `scheduleOnRN` is defined inside a worklet (UI runtime). Define it in the JavaScript thread scope (component body or module scope) instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) =>
    isTsxFilename(context.filename)
      ? {
          CallExpression: (node) => {
            checkScheduleOnRnCall(node, context.sourceCode, (d) => {
              context.report(d);
            });
          },
        }
      : {},
});
