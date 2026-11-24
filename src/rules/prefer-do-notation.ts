import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as IO from "fp-ts/lib/IO.js";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { isFlowCallExpression } from "../lib/flow-call.js";
import { isPipeCallExpression } from "../lib/pipe-call.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "preferDoNotation";

type LambdaNode = TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression;

type PackedContext = Readonly<{
  packedKeys: ReadonlySet<string>;
  hasSpread: boolean;
}>;

const STEP_OP_NAMES: ReadonlySet<string> = new Set([
  "map",
  "flatMap",
  "chain",
  "chainW",
  "filter",
  "tap",
  "mapLeft",
  "bimap",
  "orElse",
  "mapBoth",
]);

const isLambdaNode = (node: TSESTree.Node): node is LambdaNode =>
  node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
  node.type === AST_NODE_TYPES.FunctionExpression;

const getFirstLambdaArg = flow(
  (args: ReadonlyArray<TSESTree.CallExpressionArgument>) => args[0],
  O.fromNullable,
  O.filter(isLambdaNode),
);

const resolveWrapperStepLambda = (call: TSESTree.CallExpression) =>
  call.callee.type === AST_NODE_TYPES.MemberExpression &&
  call.callee.property.type === AST_NODE_TYPES.Identifier &&
  STEP_OP_NAMES.has(call.callee.property.name)
    ? getFirstLambdaArg(call.arguments)
    : O.none;

const resolveStepLambda = (step: TSESTree.CallExpressionArgument) =>
  match(step)
    .with(
      { type: P.union(AST_NODE_TYPES.ArrowFunctionExpression, AST_NODE_TYPES.FunctionExpression) },
      O.some,
    )
    .with({ type: AST_NODE_TYPES.CallExpression }, resolveWrapperStepLambda)
    .otherwise(() => O.none);

const extractObjectPatternPropName = (prop: TSESTree.Property | TSESTree.RestElement) =>
  match(prop)
    .with(
      {
        type: AST_NODE_TYPES.Property,
        value: { type: AST_NODE_TYPES.Identifier },
      },
      (p) => O.some(p.value.name),
    )
    .with(
      {
        type: AST_NODE_TYPES.RestElement,
        argument: { type: AST_NODE_TYPES.Identifier },
      },
      (r) => O.some(r.argument.name),
    )
    .otherwise(() => O.none);

const extractParamNames = (param: TSESTree.Parameter) =>
  match(param)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => new Set([id.name]))
    .with(
      { type: AST_NODE_TYPES.ObjectPattern },
      (pat) => new Set(RA.filterMap(extractObjectPatternPropName)(pat.properties)),
    )
    .otherwise(() => new Set<string>());

const resolveSingleBlockReturnExpr = flow(
  (body: TSESTree.BlockStatement) => body.body,
  O.fromPredicate((stmts: ReadonlyArray<TSESTree.Statement>) => stmts.length === 1),
  O.flatMap(RA.head),
  O.filter((stmt): stmt is TSESTree.ReturnStatement => stmt.type === AST_NODE_TYPES.ReturnStatement),
  O.flatMap((ret) => O.fromNullable(ret.argument)),
);

const unwrapTypeAssertion = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.TSAsExpression ||
  expr.type === AST_NODE_TYPES.TSSatisfiesExpression
    ? expr.expression
    : expr;

const resolveLambdaBodyExpr = (lambda: LambdaNode) =>
  match(lambda.body)
    .with({ type: AST_NODE_TYPES.BlockStatement }, resolveSingleBlockReturnExpr)
    .otherwise(O.some);

const resolveLambdaReturnObject = flow(
  resolveLambdaBodyExpr,
  O.map(unwrapTypeAssertion),
  O.filter(
    (expr): expr is TSESTree.ObjectExpression => expr.type === AST_NODE_TYPES.ObjectExpression,
  ),
);

const extractObjectPropKey = (prop: TSESTree.ObjectLiteralElement) =>
  prop.type === AST_NODE_TYPES.Property && prop.key.type === AST_NODE_TYPES.Identifier
    ? O.some(prop.key.name)
    : O.none;

const isForwardedProperty =
  (paramNames: ReadonlySet<string>) => (prop: TSESTree.ObjectLiteralElement) =>
    match(prop)
      .with(
        { type: AST_NODE_TYPES.Property, value: { type: AST_NODE_TYPES.Identifier } },
        (p) => paramNames.has(p.value.name),
      )
      .with(
        { type: AST_NODE_TYPES.SpreadElement, argument: { type: AST_NODE_TYPES.Identifier } },
        (s) => paramNames.has(s.argument.name),
      )
      .otherwise(() => false);

const analyzePackedObject =
  (paramNames: ReadonlySet<string>) => (obj: TSESTree.ObjectExpression) =>
    obj.properties.length >= 2 && RA.some(isForwardedProperty(paramNames))(obj.properties)
      ? O.some<PackedContext>({
          packedKeys: new Set(RA.filterMap(extractObjectPropKey)(obj.properties)),
          hasSpread: RA.some(
            (p: TSESTree.ObjectLiteralElement) => p.type === AST_NODE_TYPES.SpreadElement,
          )(obj.properties),
        })
      : O.none;

const getSingleParamNames = flow(
  (lambda: LambdaNode) => (lambda.params.length === 1 ? O.fromNullable(lambda.params[0]) : O.none),
  O.map(extractParamNames),
  O.filter((names) => names.size > 0),
);

const extractPackedContext = (fn: LambdaNode) =>
  match([getSingleParamNames(fn), resolveLambdaReturnObject(fn)] as const)
    .with([{ _tag: "Some" }, { _tag: "Some" }], ([{ value: paramNames }, { value: obj }]) =>
      analyzePackedObject(paramNames)(obj),
    )
    .otherwise(() => O.none);

const extractObjectPatternKey = (prop: TSESTree.Property | TSESTree.RestElement) =>
  prop.type === AST_NODE_TYPES.Property && prop.key.type === AST_NODE_TYPES.Identifier
    ? O.some(prop.key.name)
    : O.none;

const extractUnpackedKeys = flow(
  (lambda: LambdaNode) => lambda.params[0],
  O.fromNullable,
  O.filter(
    (param): param is TSESTree.ObjectPattern => param.type === AST_NODE_TYPES.ObjectPattern,
  ),
  O.map((pat) => RA.filterMap(extractObjectPatternKey)(pat.properties)),
);

const matchesContextCarryPair =
  (packed: PackedContext) => (unpackedKeys: ReadonlyArray<string>) => {
    const overlapCount = RA.size(RA.filter((k: string) => packed.packedKeys.has(k))(unpackedKeys));
    return overlapCount >= 2 || (packed.hasSpread && overlapCount >= 1 && unpackedKeys.length >= 2);
  };

const isContextCarryPair =
  (first: TSESTree.CallExpressionArgument) => (second: TSESTree.CallExpressionArgument) =>
    match([
      O.flatMap(extractPackedContext)(resolveStepLambda(first)),
      O.flatMap(extractUnpackedKeys)(resolveStepLambda(second)),
    ] as const)
      .with([{ _tag: "Some" }, { _tag: "Some" }], ([{ value: packed }, { value: unpacked }]) =>
        matchesContextCarryPair(packed)(unpacked),
      )
      .otherwise(() => false);

const checkAdjacentSteps = (first: TSESTree.CallExpressionArgument) =>
  flow(
    O.filter(isContextCarryPair(first)),
    O.map(() => first),
  );

const findDoNotationTargets = (steps: ReadonlyArray<TSESTree.CallExpressionArgument>) =>
  RA.filterMapWithIndex((i: number, first: TSESTree.CallExpressionArgument) =>
    checkAdjacentSteps(first)(O.fromNullable(steps[i + 1])),
  )(steps);

const resolvePipelineSteps = (node: TSESTree.CallExpression) =>
  match([isPipeCallExpression(node), isFlowCallExpression(node)] as const)
    .with([true, false], () => O.some(node.arguments.slice(1)))
    .with([false, true], () => O.some(node.arguments))
    .otherwise(() => O.none);

const reportTarget =
  (report: (target: TSESTree.CallExpressionArgument) => void) =>
  (target: TSESTree.CallExpressionArgument) =>
  () => {
    report(target);
  };

const traverseTargets = flow(reportTarget, RA.traverse(IO.Applicative));

const runEffect = <A>(effect: IO.IO<A>) => {
  effect();
};

const handleCallExpression = (report: (target: TSESTree.CallExpressionArgument) => void) =>
  flow(
    resolvePipelineSteps,
    O.map(findDoNotationTargets),
    O.traverse(IO.Applicative)(traverseTargets(report)),
    runEffect,
  );

export const preferDoNotation = createRule<[], MessageIds>({
  name: "prefer-do-notation",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag `flow(...)` steps and chained `map` lambdas that pack arguments into ad-hoc object literals solely to carry context into the next step.",
    },
    messages: {
      preferDoNotation:
        "Avoid packing arguments into an ad-hoc object literal (`{ ... }`) solely to carry context forward to the next step. Use `O.Do` + `O.bind` / `O.let` / `R.Do` instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    CallExpression: handleCallExpression((target) => {
      context.report({ node: target, messageId: "preferDoNotation" });
    }),
  }),
});
