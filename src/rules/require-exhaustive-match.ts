import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { pipe } from "fp-ts/lib/function.js";
import { createRule } from "../utils/create-rule.js";
import { isFiniteExhaustiveCandidate } from "../utils/type-helpers.js";

type MessageIds = "unterminatedMatch" | "preferExhaustive";

const TERMINATOR_METHODS = new Set(["exhaustive", "otherwise", "run"]);

const getTerminatorPropName = (member: TSESTree.MemberExpression) =>
  member.property.type === AST_NODE_TYPES.Identifier &&
  TERMINATOR_METHODS.has(member.property.name)
    ? O.some(member.property.name)
    : O.none;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const findMatchChainTerminator = (current: TSESTree.Node): O.Option<readonly [TSESTree.CallExpression, string]> => {
  if (current.parent?.type !== AST_NODE_TYPES.MemberExpression || current.parent.object !== current || current.parent.parent.type !== AST_NODE_TYPES.CallExpression || current.parent.parent.callee !== current.parent) {
    return O.none;
  }
  const parentCall = current.parent.parent;
  return pipe(getTerminatorPropName(current.parent), O.map((methodName) => [parentCall, methodName] as const), O.alt(() => findMatchChainTerminator(parentCall)));
};

const isMatchCall = (node: TSESTree.CallExpression) =>
  node.callee.type === AST_NODE_TYPES.Identifier &&
  node.callee.name === "match" &&
  node.arguments.length === 1;

const isExhaustiveCandidateArg = (
  targetArg: TSESTree.CallExpressionArgument,
  services: ParserServicesWithTypeInformation,
) =>
  pipe(
    services.esTreeNodeToTSNodeMap.get(targetArg),
    (tsNode) => services.program.getTypeChecker().getTypeAtLocation(tsNode),
    isFiniteExhaustiveCandidate,
  );

const checkMatchCall = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
  report: (n: TSESTree.Node, messageId: MessageIds) => void,
) => {
  if (!isMatchCall(node)) { return; }
  pipe(
    findMatchChainTerminator(node),
    O.match(
      () => { report(node, "unterminatedMatch"); },
      ([terminator, methodName]) => {
        const targetArg = node.arguments[0];
        if (methodName === "otherwise" && targetArg && isExhaustiveCandidateArg(targetArg, services)) { report(terminator, "preferExhaustive"); }
      },
    ),
  );
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
    defaultOptions: [],
  },
  create: (context) => ({
    CallExpression: (node) => {
      checkMatchCall(node, ESLintUtils.getParserServices(context), (n, messageId) => {
        context.report({ node: n, messageId });
      });
    },
  }),
});
