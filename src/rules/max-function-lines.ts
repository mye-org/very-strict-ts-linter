import { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";

type Options = [{ readonly maxLines: number }];
type MessageIds = "tooManyLines";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

export const maxFunctionLines = createRule<Options, MessageIds>({
  name: "max-function-lines",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Enforce a maximum number of lines per function body (default: 15) to encourage small, single-responsibility pure functions.",
    },
    messages: {
      tooManyLines:
        "Function body has {{actual}} lines (max {{max}}). Decompose into smaller pure functions.",
    },
    schema: [
      {
        type: "object",
        properties: {
          maxLines: { type: "number", minimum: 1 },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{ maxLines: 15 }],
  create: (context, [options]) => {
    const checkFunction = (node: FunctionNode) => {
      const startLine = node.body.loc.start.line;
      const endLine = node.body.loc.end.line;
      const lineCount = endLine - startLine + 1;
      if (lineCount > options.maxLines) {
        context.report({
          node,
          messageId: "tooManyLines",
          data: {
            actual: String(lineCount),
            max: String(options.maxLines),
          },
        });
      }
    };

    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
});
