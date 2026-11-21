import { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";

type Options = [Record<"maxLines", number>];
type MessageIds = "tooManyLines";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

const getLineCount = (node: FunctionNode) =>
  node.body.loc.end.line - node.body.loc.start.line + 1;

const reportIfTooLong = (
  node: FunctionNode,
  maxLines: number,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
) => {
  const lineCount = getLineCount(node);
  if (lineCount > maxLines) {
    report({ node, messageId: "tooManyLines", data: { actual: String(lineCount), max: String(maxLines) } });
  }
};

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
        properties: { maxLines: { type: "number", minimum: 1 } },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ maxLines: 15 }],
  },
  create: (context, [options]) => {
    const check = (node: FunctionNode) => {
      reportIfTooLong(node, options.maxLines, (d) => { context.report(d); });
    };
    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    };
  },
});
