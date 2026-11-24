import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { isFiniteExhaustiveCandidate } from "../lib/finite-types.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "unterminatedMatch" | "preferExhaustive";

const TERMINATOR_METHODS: ReadonlySet<string> = new Set(["exhaustive", "otherwise", "run"]);
const MATCH_CALLEE_NAMES: ReadonlySet<string> = new Set(["match"]);

const extractTerminatorMethodName = (member: TSESTree.MemberExpression) =>
  !member.computed &&
  member.property.type === AST_NODE_TYPES.Identifier &&
  TERMINATOR_METHODS.has(member.property.name)
    ? O.some(member.property.name)
    : O.none;

const resolveCallOfMember = (member: TSESTree.MemberExpression, child: TSESTree.Node) =>
  member.object === child &&
  member.parent.type === AST_NODE_TYPES.CallExpression &&
  member.parent.callee === member
    ? O.some([member, member.parent] as const)
    : O.none;

const resolveParentMemberCall = (current: TSESTree.Node) =>
  current.parent?.type === AST_NODE_TYPES.MemberExpression
    ? resolveCallOfMember(current.parent, current)
    : O.none;

const resolveTerminatorFromStep = (
  [member, parentCall]: readonly [TSESTree.MemberExpression, TSESTree.CallExpression],
) => {
  const resolve = flow(
    extractTerminatorMethodName,
    O.map((methodName) => [parentCall, methodName] as const),
    O.alt(() => findMatchChainTerminator(parentCall)),
  );
  return resolve(member);
};

const findMatchChainTerminator: (current: TSESTree.Node) => O.Option<readonly [TSESTree.CallExpression, string]> = flow(
  resolveParentMemberCall,
  O.flatMap(resolveTerminatorFromStep),
);

const isMatchCall = (node: TSESTree.CallExpression) =>
  node.callee.type === AST_NODE_TYPES.Identifier &&
  MATCH_CALLEE_NAMES.has(node.callee.name) &&
  node.arguments.length === 1;

const isExhaustiveCandidateArg = (
  targetArg: TSESTree.CallExpressionArgument,
  services: ParserServicesWithTypeInformation,
) => {
  const check = flow(
    (arg: TSESTree.CallExpressionArgument) => services.esTreeNodeToTSNodeMap.get(arg),
    (tsNode) => services.program.getTypeChecker().getTypeAtLocation(tsNode),
    isFiniteExhaustiveCandidate,
  );
  return check(targetArg);
};

const hasFiniteFirstArg = (
  args: ReadonlyArray<TSESTree.CallExpressionArgument>,
  services: ParserServicesWithTypeInformation,
) =>
  O.exists((arg: TSESTree.CallExpressionArgument) => isExhaustiveCandidateArg(arg, services))(
    RA.head<TSESTree.CallExpressionArgument>(args),
  );

const checkTerminator =
  (
    services: ParserServicesWithTypeInformation,
    report: (n: TSESTree.Node, messageId: MessageIds) => void,
  ) =>
  (
    node: TSESTree.CallExpression,
    [terminator, methodName]: readonly [TSESTree.CallExpression, string],
  ) => {
    match({
      methodName,
      isFinite: hasFiniteFirstArg(node.arguments, services),
    })
      .with(
        { methodName: "otherwise", isFinite: true },
        { methodName: "run", isFinite: true },
        () => { report(terminator, "preferExhaustive"); },
      )
      .otherwise(() => {});
  };

const checkMatchCall =
  (
    services: ParserServicesWithTypeInformation,
    report: (n: TSESTree.Node, messageId: MessageIds) => void,
  ) =>
  (node: TSESTree.CallExpression) => {
    match(isMatchCall(node))
      .with(false, () => {})
      .with(true, () => {
        const check = flow(
          findMatchChainTerminator,
          O.match(
            () => { report(node, "unterminatedMatch"); },
            (pair) => { checkTerminator(services, report)(node, pair); },
          ),
        );
        check(node);
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
  create: (context) => ({
    CallExpression: checkMatchCall(ESLintUtils.getParserServices(context), (n, messageId) => {
      context.report({ node: n, messageId });
    }),
  }),
});
