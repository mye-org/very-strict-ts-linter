import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";

type Options = [];
type MessageIds = "preferPredicateCombinator" | "preferPredicateNot";

type FunctionWithBody = TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression;

const resolveSingleBlockReturnExpr = flow(
  (body: TSESTree.BlockStatement) => body.body,
  O.fromPredicate((stmts: ReadonlyArray<TSESTree.Statement>) => stmts.length === 1),
  O.flatMap(RA.head),
  O.filter(
    (stmt): stmt is TSESTree.ReturnStatement => stmt.type === AST_NODE_TYPES.ReturnStatement,
  ),
  O.flatMap((ret) => O.fromNullable(ret.argument)),
);

const resolveFunctionReturnExpr = (node: FunctionWithBody) =>
  match(node.body)
    .with({ type: AST_NODE_TYPES.BlockStatement }, resolveSingleBlockReturnExpr)
    .with(P._, O.some)
    .exhaustive();

const resolveSingleIdentifierParamName = (node: FunctionWithBody) =>
  match(node)
    .with(
      {
        async: false,
        generator: false,
        params: [{ type: AST_NODE_TYPES.Identifier }],
      },
      ({ params }) => O.some(params[0].name),
    )
    .otherwise(() => O.none);

const isUnaryPredicateCallOn = (paramName: string) => (call: TSESTree.CallExpression) =>
  !(call.callee.type === AST_NODE_TYPES.Identifier && call.callee.name === paramName) &&
  match(call.arguments)
    .with([{ type: AST_NODE_TYPES.Identifier }], ([arg]) => arg.name === paramName)
    .otherwise(() => false);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const isPredicateExpr =
  (paramName: string) =>
  (expr: TSESTree.Expression): boolean =>
    match(expr)
      .with(
        { type: AST_NODE_TYPES.UnaryExpression, operator: "!" },
        (unary) => isPredicateExpr(paramName)(unary.argument),
      )
      .with(
        { type: AST_NODE_TYPES.LogicalExpression, operator: P.union("&&", "||") },
        (logical) =>
          isPredicateExpr(paramName)(logical.left) && isPredicateExpr(paramName)(logical.right),
      )
      .with({ type: AST_NODE_TYPES.CallExpression }, isUnaryPredicateCallOn(paramName))
      .otherwise(() => false);

const classifyPredicateBody = (paramName: string) => (expr: TSESTree.Expression) =>
  match(expr)
    .with({ type: AST_NODE_TYPES.UnaryExpression, operator: "!" }, (unary) =>
      isPredicateExpr(paramName)(unary.argument)
        ? O.some<MessageIds>("preferPredicateNot")
        : O.none,
    )
    .with(
      { type: AST_NODE_TYPES.LogicalExpression, operator: P.union("&&", "||") },
      (logical) =>
        isPredicateExpr(paramName)(logical.left) && isPredicateExpr(paramName)(logical.right)
          ? O.some<MessageIds>("preferPredicateCombinator")
          : O.none,
    )
    .otherwise(() => O.none);

const resolvePredicateMessage = (node: FunctionWithBody) =>
  match([resolveSingleIdentifierParamName(node), resolveFunctionReturnExpr(node)] as const)
    .with([O.some(P.select("paramName")), O.some(P.select("expr"))], ({ paramName, expr }) =>
      classifyPredicateBody(paramName)(expr),
    )
    .otherwise(() => O.none);

const checkPredicateFunction =
  (report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void) =>
  (node: FunctionWithBody) => {
    O.match(
      () => {},
      (messageId: MessageIds) => {
        report({ node, messageId });
      },
    )(resolvePredicateMessage(node));
  };

export const preferPredicateCombinators = createRule<Options, MessageIds>({
  name: "prefer-predicate-combinators",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer fp-ts Predicate combinators (`Pred.or`, `Pred.and`, `Pred.not`, `Pred.getMonoidAny`) over inline boolean combinations of predicate calls.",
    },
    messages: {
      preferPredicateCombinator:
        "Avoid manual boolean combination of predicates. Use `Pred.or`, `Pred.and`, `Pred.not`, or `Pred.getMonoidAny` instead.",
      preferPredicateNot:
        "Avoid wrapping a predicate negation in a function. Use `Pred.not` instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const check = checkPredicateFunction((d) => {
      context.report(d);
    });
    return {
      ArrowFunctionExpression: check,
      FunctionExpression: check,
    };
  },
});
