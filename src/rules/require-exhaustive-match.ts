import { AST_NODE_TYPES, ESLintUtils, TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";
import { isFiniteExhaustiveCandidate } from "../utils/type-helpers.js";

type MessageIds = "unterminatedMatch" | "preferExhaustive";

const TERMINATOR_METHODS = new Set(["exhaustive", "otherwise", "run"]);

const findMatchChainTerminator = (
  matchCall: TSESTree.CallExpression,
): { terminator: TSESTree.CallExpression | null; methodName: string | null } => {
  let current: TSESTree.Node = matchCall;
  while (
    current.parent.type === AST_NODE_TYPES.MemberExpression &&
    current.parent.object === current &&
    current.parent.parent.type === AST_NODE_TYPES.CallExpression &&
    current.parent.parent.callee === current.parent
  ) {
    const member: TSESTree.MemberExpression = current.parent;
    const call: TSESTree.CallExpression = current.parent.parent;
    const propName =
      member.property.type === AST_NODE_TYPES.Identifier
        ? member.property.name
        : null;

    if (propName && TERMINATOR_METHODS.has(propName)) {
      return { terminator: call, methodName: propName };
    }
    current = call;
  }
  return { terminator: null, methodName: null };
};

export const requireExhaustiveMatch = createRule<[], MessageIds>({
  name: "require-exhaustive-match",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require `ts-pattern` `match(...)` chains to terminate with `.exhaustive()`, and flag `.otherwise()` on finite unions/enums/booleans.",
    },
    messages: {
      unterminatedMatch:
        "`match(...)` chain must terminate with `.exhaustive()` (or `.otherwise()` when exhaustive matching is not feasible).",
      preferExhaustive:
        "Use `.exhaustive()` instead of `.otherwise()` for finite union, boolean, or enum types.",
    },
    schema: [],
  },
  defaultOptions: [],
  create: (context) => {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    return {
      CallExpression: (node: TSESTree.CallExpression) => {
        if (
          node.callee.type !== AST_NODE_TYPES.Identifier ||
          node.callee.name !== "match" ||
          node.arguments.length !== 1
        ) {
          return;
        }

        const { terminator, methodName } = findMatchChainTerminator(node);
        if (!terminator || !methodName) {
          context.report({ node, messageId: "unterminatedMatch" });
          return;
        }

        if (methodName === "otherwise") {
          const targetArg = node.arguments[0];
          if (!targetArg) {
            return;
          }
          const tsNode = services.esTreeNodeToTSNodeMap.get(targetArg);
          const type = checker.getTypeAtLocation(tsNode);
          if (isFiniteExhaustiveCandidate(type)) {
            context.report({
              node: terminator,
              messageId: "preferExhaustive",
            });
          }
        }
      },
    };
  },
});
