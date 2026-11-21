import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "unnecessaryLocalConst";

const isFunctionNode = (node: TSESTree.Node | undefined): boolean =>
  node?.type === AST_NODE_TYPES.ArrowFunctionExpression ||
  node?.type === AST_NODE_TYPES.FunctionDeclaration ||
  node?.type === AST_NODE_TYPES.FunctionExpression;

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
  },
  defaultOptions: [],
  create: (context) => ({
    VariableDeclaration: (node: TSESTree.VariableDeclaration) => {
      if (node.kind !== "const") {
        return;
      }
      // Only check inside function block bodies, not module top-level
      const parentBlock = node.parent;
      if (
        parentBlock.type !== AST_NODE_TYPES.BlockStatement ||
        !isFunctionNode(parentBlock.parent)
      ) {
        return;
      }

      for (const declarator of node.declarations) {
        if (declarator.id.type !== AST_NODE_TYPES.Identifier) {
          continue;
        }
        // Allow local helper arrow functions
        if (
          declarator.init?.type === AST_NODE_TYPES.ArrowFunctionExpression ||
          declarator.init?.type === AST_NODE_TYPES.FunctionExpression
        ) {
          continue;
        }

        const declaredVars = context.sourceCode.getDeclaredVariables(declarator);
        const targetVar = declaredVars[0];
        if (!targetVar) {
          continue;
        }

        const readRefs = targetVar.references.filter((ref) => ref.isRead());
        if (readRefs.length === 1) {
          context.report({
            node: declarator,
            messageId: "unnecessaryLocalConst",
            data: { name: targetVar.name },
          });
        }
      }
    },
  }),
});
