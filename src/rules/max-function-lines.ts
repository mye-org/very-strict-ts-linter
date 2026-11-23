import { TSESTree } from "@typescript-eslint/utils";
import { match } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";

type Options = [Record<"maxLines", number>];
type MessageIds = "tooManyLines";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

const measureLocationSpan = (loc: TSESTree.SourceLocation) =>
  loc.end.line - loc.start.line + 1;

const measureLineCount = (node: FunctionNode) =>
  measureLocationSpan(node.body.loc);

const formatLineLimitPayload = (lineCount: number, maxLines: number) => ({
  actual: String(lineCount),
  max: String(maxLines),
});

const reportIfTooLong = (
  node: FunctionNode,
  maxLines: number,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
) => {
  const lineCount = measureLineCount(node);
  match(lineCount > maxLines)
    .with(true, () => {
      report({ node, messageId: "tooManyLines", data: formatLineLimitPayload(lineCount, maxLines) });
    })
    .with(false, () => {})
    .exhaustive();
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
