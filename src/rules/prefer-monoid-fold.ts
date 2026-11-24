import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { collectEstreeChildNodes } from "../lib/estree-children.js";
import { createRule } from "../lib/rule-factory.js";

type Options = [];
type MessageIds = "preferMonoidFold";
type MonoidKind = "sum" | "string" | "all" | "any" | "array" | "record";
type FunctionWithBody = TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression;

const MONOID_SUGGESTION = {
  sum: "N.MonoidSum",
  string: "S.Monoid",
  all: "B.MonoidAll",
  any: "B.MonoidAny",
  array: "RA.getMonoid",
  record: "RR.getMonoid",
} as const satisfies Readonly<Record<MonoidKind, string>>;

const isReduceCallee = (callee: TSESTree.Expression) =>
  match(callee)
    .with(
      P.union(
        { type: AST_NODE_TYPES.Identifier, name: "reduce" },
        {
          type: AST_NODE_TYPES.MemberExpression,
          computed: false,
          property: { type: AST_NODE_TYPES.Identifier, name: "reduce" },
        },
      ),
      () => true,
    )
    .otherwise(() => false);

const classifyInitMonoid = (arg: TSESTree.CallExpressionArgument) =>
  match(arg)
    .with({ type: AST_NODE_TYPES.Literal, value: 0 }, () => O.some<MonoidKind>("sum"))
    .with({ type: AST_NODE_TYPES.Literal, value: "" }, () => O.some<MonoidKind>("string"))
    .with({ type: AST_NODE_TYPES.Literal, value: true }, () => O.some<MonoidKind>("all"))
    .with({ type: AST_NODE_TYPES.Literal, value: false }, () => O.some<MonoidKind>("any"))
    .with({ type: AST_NODE_TYPES.ArrayExpression, elements: [] }, () =>
      O.some<MonoidKind>("array"),
    )
    .with({ type: AST_NODE_TYPES.ObjectExpression, properties: [] }, () =>
      O.some<MonoidKind>("record"),
    )
    .otherwise(() => O.none);

const asReducerFunction = (arg: TSESTree.CallExpressionArgument) =>
  match(arg)
    .with(
      { type: P.union(AST_NODE_TYPES.ArrowFunctionExpression, AST_NODE_TYPES.FunctionExpression) },
      O.some,
    )
    .otherwise(() => O.none);

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

const resolveReducerParts = (fn: FunctionWithBody) =>
  match(fn)
    .with(
      {
        async: false,
        generator: false,
        params: [{ type: AST_NODE_TYPES.Identifier }, { type: AST_NODE_TYPES.Identifier }],
      },
      ({ params }) =>
        O.map((bodyExpr: TSESTree.Expression) => ({
          accName: params[0].name,
          elemName: params[1].name,
          bodyExpr,
        }))(resolveFunctionReturnExpr(fn)),
    )
    .otherwise(() => O.none);

const collectChildren =
  (visitorKeys: TSESLint.SourceCode["visitorKeys"]) => (node: TSESTree.Node) =>
    collectEstreeChildNodes(visitorKeys)(node);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const referencesIdentifier =
  (visitorKeys: TSESLint.SourceCode["visitorKeys"]) =>
  (name: string) =>
  (node: TSESTree.Node): boolean =>
    match(node)
      .with({ type: AST_NODE_TYPES.Identifier }, (id) => id.name === name)
      .with({ type: AST_NODE_TYPES.MemberExpression, computed: false }, (mem) =>
        referencesIdentifier(visitorKeys)(name)(mem.object),
      )
      .otherwise(
        flow(collectChildren(visitorKeys), RA.some(referencesIdentifier(visitorKeys)(name))),
      );

const andNotReferencing = (visitorKeys: TSESLint.SourceCode["visitorKeys"]) =>
  flow(referencesIdentifier(visitorKeys), Pred.not, Pred.and);

const isElementContribution =
  (visitorKeys: TSESLint.SourceCode["visitorKeys"]) => (accName: string) =>
    flow(referencesIdentifier(visitorKeys), andNotReferencing(visitorKeys)(accName));

const isAccIdentifier = (accName: string) => (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.Identifier && node.name === accName;

const matchesMonoidBody =
  (visitorKeys: TSESLint.SourceCode["visitorKeys"]) =>
  (accName: string) =>
  (elemName: string) =>
  (kind: MonoidKind) =>
  (bodyExpr: TSESTree.Expression) =>
    match([kind, bodyExpr] as const)
      .with(
        [P.union("sum", "string"), { type: AST_NODE_TYPES.BinaryExpression, operator: "+" }],
        ([, bin]) =>
          isAccIdentifier(accName)(bin.left) &&
          isElementContribution(visitorKeys)(accName)(elemName)(bin.right),
      )
      .with(
        P.union(
          ["all", { type: AST_NODE_TYPES.LogicalExpression, operator: "&&" }],
          ["any", { type: AST_NODE_TYPES.LogicalExpression, operator: "||" }],
        ),
        ([, log]) =>
          isAccIdentifier(accName)(log.left) &&
          isElementContribution(visitorKeys)(accName)(elemName)(log.right),
      )
      .with(
        [
          "array",
          {
            type: AST_NODE_TYPES.ArrayExpression,
            elements: [
              { type: AST_NODE_TYPES.SpreadElement },
              { type: AST_NODE_TYPES.SpreadElement },
            ],
          },
        ],
        ([, arr]) =>
          isAccIdentifier(accName)(arr.elements[0].argument) &&
          isElementContribution(visitorKeys)(accName)(elemName)(arr.elements[1].argument),
      )
      .with(
        [
          "record",
          {
            type: AST_NODE_TYPES.ObjectExpression,
            properties: [
              { type: AST_NODE_TYPES.SpreadElement },
              { type: AST_NODE_TYPES.SpreadElement },
            ],
          },
        ],
        ([, obj]) =>
          isAccIdentifier(accName)(obj.properties[0].argument) &&
          isElementContribution(visitorKeys)(accName)(elemName)(obj.properties[1].argument),
      )
      .otherwise(() => false);

const resolveInitAndReducer =
  (arg0: TSESTree.CallExpressionArgument) => (arg1: TSESTree.CallExpressionArgument) =>
    match([
      classifyInitMonoid(arg0),
      asReducerFunction(arg1),
      classifyInitMonoid(arg1),
      asReducerFunction(arg0),
    ] as const)
      .with(
        [
          { _tag: "Some", value: P.select("kind") },
          { _tag: "Some", value: P.select("fn") },
          P._,
          P._,
        ],
        ({ kind, fn }) =>
          O.some<Readonly<{ kind: MonoidKind; fn: FunctionWithBody }>>({ kind, fn }),
      )
      .with(
        [
          P._,
          P._,
          { _tag: "Some", value: P.select("kind") },
          { _tag: "Some", value: P.select("fn") },
        ],
        ({ kind, fn }) =>
          O.some<Readonly<{ kind: MonoidKind; fn: FunctionWithBody }>>({ kind, fn }),
      )
      .otherwise(() => O.none);

const matchReducerWithKind =
  (visitorKeys: TSESLint.SourceCode["visitorKeys"]) => (kind: MonoidKind) =>
    flow(
      resolveReducerParts,
      O.flatMap(
        ({
          accName,
          elemName,
          bodyExpr,
        }: Readonly<{ accName: string; elemName: string; bodyExpr: TSESTree.Expression }>) =>
          matchesMonoidBody(visitorKeys)(accName)(elemName)(kind)(bodyExpr)
            ? O.some(MONOID_SUGGESTION[kind])
            : O.none,
      ),
    );

const resolveMonoidSuggestion =
  (visitorKeys: TSESLint.SourceCode["visitorKeys"]) => (node: TSESTree.CallExpression) =>
    match(node)
      .with(
        { arguments: [P.select("arg0"), P.select("arg1")] },
        ({ arg0, arg1 }) =>
          isReduceCallee(node.callee)
            ? O.flatMap(({ kind, fn }: Readonly<{ kind: MonoidKind; fn: FunctionWithBody }>) =>
                matchReducerWithKind(visitorKeys)(kind)(fn),
              )(resolveInitAndReducer(arg0)(arg1))
            : O.none,
      )
      .otherwise(() => O.none);

const checkReduceCall =
  (visitorKeys: TSESLint.SourceCode["visitorKeys"]) =>
  (
    report: (
      d: Readonly<{
        node: TSESTree.Node;
        messageId: MessageIds;
        data: Readonly<Record<string, string>>;
      }>,
    ) => void,
  ) =>
  (node: TSESTree.CallExpression) => {
    O.match(
      () => {},
      (monoid: string) => {
        report({ node, messageId: "preferMonoidFold", data: { monoid } });
      },
    )(resolveMonoidSuggestion(visitorKeys)(node));
  };

export const preferMonoidFold = createRule<Options, MessageIds>({
  name: "prefer-monoid-fold",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer `RA.foldMap(M)` or `M.concatAll` over `reduce` with monoidal identity and combination.",
    },
    messages: {
      preferMonoidFold:
        "Avoid manual monoidal reduce. Use `RA.foldMap({{monoid}})` or `{{monoid}}.concatAll` instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    CallExpression: checkReduceCall(context.sourceCode.visitorKeys)((d) => {
      context.report(d);
    }),
  }),
});
