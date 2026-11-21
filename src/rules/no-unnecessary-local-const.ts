import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "unnecessaryLocalConst";

const isFunctionNode = (node: O.Option<TSESTree.Node>) =>
  pipe(
    node,
    O.exists(
      (n) =>
        n.type === AST_NODE_TYPES.ArrowFunctionExpression ||
        n.type === AST_NODE_TYPES.FunctionDeclaration ||
        n.type === AST_NODE_TYPES.FunctionExpression,
    ),
  );

const isLocalHelperFunction = (declarator: TSESTree.VariableDeclarator) =>
  declarator.init?.type === AST_NODE_TYPES.ArrowFunctionExpression ||
  declarator.init?.type === AST_NODE_TYPES.FunctionExpression;

const hasSingleRead = (
  declarator: TSESTree.VariableDeclarator,
  sourceCode: Readonly<TSESLint.SourceCode>,
) =>
  pipe(
    O.fromNullable(sourceCode.getDeclaredVariables(declarator)[0]),
    O.filter(
      (v) => pipe(v.references, RA.filter((ref) => ref.isRead())).length === 1,
    ),
    O.map((v) => ({ declarator, name: v.name })),
  );

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

export const noUnnecessaryLocalConst = createRule<[], MessageIds>({
  name: "no-unnecessary-local-const",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag single-use intermediate `const` variables inside function bodies that can be inlined into `pipe(...)` or an expression.",
    },
    messages: {
      unnecessaryLocalConst:
        "Intermediate variable `{{name}}` is only used once. Inline it into `pipe(...)` or the return expression.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    VariableDeclaration: (node) => {
      if (!isInsideFunctionBody(node)) {
        return;
      }
      pipe(
        node.declarations as ReadonlyArray<TSESTree.VariableDeclarator>,
        RA.filterMap((d) => isSingleUseDeclarator(d, context.sourceCode)),
        RA.map(({ declarator, name }) => {
          context.report({ node: declarator, messageId: "unnecessaryLocalConst", data: { name } });
        }),
      );
    },
  }),
});
