import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { hasFunctionInit } from "../lib/estree-function-nodes.js";
import { isFlowCallExpression } from "../lib/flow-call.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "unnecessaryLocalConst";

const isFunctionNode = O.exists(
  (n: TSESTree.Node) =>
    n.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    n.type === AST_NODE_TYPES.FunctionDeclaration ||
    n.type === AST_NODE_TYPES.FunctionExpression,
);

const isFlowInit = O.exists(
  (init: TSESTree.Expression) =>
    init.type === AST_NODE_TYPES.CallExpression && isFlowCallExpression(init),
);

const isLocalHelperFunction = (declarator: TSESTree.VariableDeclarator) =>
  hasFunctionInit(declarator) || isFlowInit(O.fromNullable(declarator.init));

const hasSingleReadRef = (v: TSESLint.Scope.Variable) =>
  RA.size(RA.filter((ref: TSESLint.Scope.Reference) => ref.isRead())(v.references)) === 1;

const hasSingleRead = (
  declarator: TSESTree.VariableDeclarator,
  sourceCode: Readonly<TSESLint.SourceCode>,
) => {
  const find = flow(
    (d: TSESTree.VariableDeclarator) => sourceCode.getDeclaredVariables(d)[0],
    O.fromNullable,
    O.filter(hasSingleReadRef),
    O.map((v) => ({ declarator, name: v.name })),
  );
  return find(declarator);
};

const isSingleUseDeclarator = (
  declarator: TSESTree.VariableDeclarator,
  sourceCode: Readonly<TSESLint.SourceCode>,
) =>
  declarator.id.type === AST_NODE_TYPES.Identifier &&
  !isLocalHelperFunction(declarator)
    ? hasSingleRead(declarator, sourceCode)
    : O.none;

const isInsideFunctionBody = (node: TSESTree.VariableDeclaration) =>
  node.kind === "const" &&
  node.parent.type === AST_NODE_TYPES.BlockStatement &&
  isFunctionNode(O.fromNullable(node.parent.parent));

const reportSingleUseDeclarators =
  (
    sourceCode: Readonly<TSESLint.SourceCode>,
    report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
  ) =>
  (node: TSESTree.VariableDeclaration) => {
    const run = flow(
      RA.filterMap((d: TSESTree.VariableDeclarator) => isSingleUseDeclarator(d, sourceCode)),
      RA.map(({ declarator, name }) => {
        report({ node: declarator, messageId: "unnecessaryLocalConst", data: { name } });
      }),
    );
    run(node.declarations);
  };

export const noUnnecessaryLocalConst = createRule<[], MessageIds>({
  name: "no-unnecessary-local-const",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag single-use intermediate `const` variables inside function bodies that can be inlined into `flow(...)` or an expression.",
    },
    messages: {
      unnecessaryLocalConst:
        "Intermediate variable `{{name}}` is only used once. Inline it into `flow(...)` or the return expression.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    VariableDeclaration: (node) => {
      match(isInsideFunctionBody(node))
        .with(true, () => {
          reportSingleUseDeclarators(context.sourceCode, (d) => { context.report(d); })(node);
        })
        .with(false, () => {})
        .exhaustive();
    },
  }),
});
