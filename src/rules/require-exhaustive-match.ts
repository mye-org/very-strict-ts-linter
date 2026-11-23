import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import { isFiniteExhaustiveCandidate } from "../utils/type-helpers.js";

type MessageIds = "unterminatedMatch" | "preferExhaustive";

const TERMINATOR_METHODS = new Set(["exhaustive", "otherwise", "run"]);

const getTerminatorPropName = (member: TSESTree.MemberExpression) =>
  !member.computed &&
  member.property.type === AST_NODE_TYPES.Identifier &&
  TERMINATOR_METHODS.has(member.property.name)
    ? O.some(member.property.name)
    : O.none;

const getParentMemberCall = (current: TSESTree.Node) =>
  current.parent?.type === AST_NODE_TYPES.MemberExpression &&
  current.parent.object === current &&
  current.parent.parent.type === AST_NODE_TYPES.CallExpression &&
  current.parent.parent.callee === current.parent
    ? O.some([current.parent, current.parent.parent] as const)
    : O.none;

const resolveTerminatorFromStep = (
  [member, parentCall]: readonly [TSESTree.MemberExpression, TSESTree.CallExpression],
) =>
  pipe(
    getTerminatorPropName(member),
    O.map((methodName) => [parentCall, methodName] as const),
    O.alt(() => findMatchChainTerminator(parentCall)),
  );

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const findMatchChainTerminator = (current: TSESTree.Node): O.Option<readonly [TSESTree.CallExpression, string]> =>
  pipe(
    getParentMemberCall(current),
    O.flatMap(resolveTerminatorFromStep),
  );

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

const checkTerminator = (
  node: TSESTree.CallExpression,
  terminator: TSESTree.CallExpression,
  methodName: string,
  services: ParserServicesWithTypeInformation,
  report: (n: TSESTree.Node, messageId: MessageIds) => void,
) => {
  match({
    methodName,
    isFinite: Boolean(node.arguments[0] && isExhaustiveCandidateArg(node.arguments[0], services)),
  })
    .with({ methodName: "otherwise", isFinite: true }, () => { report(terminator, "preferExhaustive"); })
    .with({ methodName: "run", isFinite: true }, () => { report(terminator, "preferExhaustive"); })
    .otherwise(() => {});
};

const checkMatchCall = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
  report: (n: TSESTree.Node, messageId: MessageIds) => void,
) => {
  match(isMatchCall(node))
    .with(false, () => {})
    .with(true, () => {
      pipe(
        findMatchChainTerminator(node),
        O.match(
          () => { report(node, "unterminatedMatch"); },
          ([terminator, methodName]) => { checkTerminator(node, terminator, methodName, services, report); },
        ),
      );
    })
    .exhaustive();
};

export const requireExhaustiveMatch = createRule<[], MessageIds>({
  name: "require-exhaustive-match",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require `ts-pattern` `match(...)` chains to terminate with `.exhaustive()`, and flag `.otherwise()`/`.run()` on finite unions/enums/booleans.",
    },
    messages: {
      unterminatedMatch:
        "`match(...)` chain must terminate with `.exhaustive()` (or `.otherwise()` when exhaustive matching is not feasible).",
      preferExhaustive:
        "Use `.exhaustive()` instead of `.otherwise()` or `.run()` for finite union, boolean, or enum types.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const services = ESLintUtils.getParserServices(context);
    return {
      CallExpression: (node) => {
        checkMatchCall(node, services, (n, messageId) => {
          context.report({ node: n, messageId });
        });
      },
    };
  },
});
