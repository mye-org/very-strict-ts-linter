import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { collectEstreeChildNodes } from "../lib/estree-children.js";
import { isFlowCallExpression } from "../lib/flow-call.js";
import { isPipeCallExpression } from "../lib/pipe-call.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "independentBind" | "independentFlatMap";
type MemberTarget = Readonly<Record<"namespace" | "method", string>>;

const APPLICATIVE_NAMESPACES = new Set(["O", "E", "TE", "T", "IO", "IOE", "R", "RE", "RTE", "RT"]);
const PURE_MONAD_NAMESPACES = new Set(["O", "E"]);
const BIND_METHODS = new Set(["bind", "bindW"]);
const FLATMAP_METHODS = new Set(["flatMap", "flatMapW"]);

const resolveMemberCallTarget = (node: TSESTree.CallExpression) =>
  match(node.callee)
    .with(
      {
        type: AST_NODE_TYPES.MemberExpression,
        object: { type: AST_NODE_TYPES.Identifier },
        property: { type: AST_NODE_TYPES.Identifier },
      },
      (m) => O.some<MemberTarget>({ namespace: m.object.name, method: m.property.name }),
    )
    .with(P._, () => O.none)
    .exhaustive();

const collectObjectPatternNames = (obj: TSESTree.ObjectPattern) =>
  RA.flatMap((prop: TSESTree.Property | TSESTree.RestElement) =>
    prop.type === AST_NODE_TYPES.RestElement
      ? collectPatternNames(prop)
      : collectPatternNames(prop.value),
  )(obj.properties);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive pattern extraction
const collectPatternNames = (param: TSESTree.Node): ReadonlyArray<string> =>
  match(param)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => [id.name])
    .with({ type: AST_NODE_TYPES.AssignmentPattern }, (a) => collectPatternNames(a.left))
    .with({ type: AST_NODE_TYPES.RestElement }, (r) =>
      r.argument.type === AST_NODE_TYPES.Identifier ? [r.argument.name] : [],
    )
    .with({ type: AST_NODE_TYPES.ObjectPattern }, collectObjectPatternNames)
    .with({ type: AST_NODE_TYPES.ArrayPattern }, (arr) => collectArrayPatternNames(arr))
    .with(P._, () => [] satisfies ReadonlyArray<string>)
    .exhaustive();

const collectArrayPatternNames = flow(
  (arr: TSESTree.ArrayPattern) => arr.elements,
  RA.filterMap((el: TSESTree.ArrayPattern["elements"][number]) => O.fromNullable(el)),
  RA.flatMap(collectPatternNames),
);

const isNonReferenceIdentifier = (id: TSESTree.Identifier) =>
  (id.parent.type === AST_NODE_TYPES.MemberExpression &&
    !id.parent.computed &&
    id.parent.property === id) ||
  (id.parent.type === AST_NODE_TYPES.Property &&
    !id.parent.computed &&
    id.parent.key === id &&
    !id.parent.shorthand) ||
  id.parent.type === AST_NODE_TYPES.TSTypeReference;

const hasReferenceToAny = ({
  node,
  names,
  visitorKeys,
}: Readonly<{
  node: TSESTree.Node;
  names: ReadonlySet<string>;
  visitorKeys: TSESLint.SourceCode["visitorKeys"];
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST reference scan
}>): boolean =>
  node.type === AST_NODE_TYPES.Identifier
    ? names.has(node.name) && !isNonReferenceIdentifier(node)
    : RA.some((child: TSESTree.Node) => hasReferenceToAny({ node: child, names, visitorKeys }))(
        collectEstreeChildNodes(node, visitorKeys),
      );

const isParamUsedInFn = ({
  firstParam,
  fnBody,
  keys,
}: Readonly<{
  firstParam: TSESTree.Parameter;
  fnBody: TSESTree.Node;
  keys: TSESLint.SourceCode["visitorKeys"];
}>) => {
  const names = new Set(collectPatternNames(firstParam));
  return names.size > 0 && hasReferenceToAny({ node: fnBody, names, visitorKeys: keys });
};

const isIndependentCallback = (
  arg: TSESTree.CallExpressionArgument,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) =>
  match(arg)
    .with(
      { type: AST_NODE_TYPES.ArrowFunctionExpression },
      { type: AST_NODE_TYPES.FunctionExpression },
      (fn) =>
        !O.exists((firstParam: TSESTree.Parameter) =>
          isParamUsedInFn({ firstParam, fnBody: fn.body, keys: visitorKeys }),
        )(O.fromNullable(fn.params[0])),
    )
    .with(P._, () => false)
    .exhaustive();

const checkIndependentCallbackArg =
  (target: MemberTarget, visitorKeys: TSESLint.SourceCode["visitorKeys"]) =>
  (arg: O.Option<TSESTree.CallExpressionArgument>, messageId: MessageIds) =>
    O.as({ messageId, ...target })(
      O.filter((cb: TSESTree.CallExpressionArgument) => isIndependentCallback(cb, visitorKeys))(arg),
    );

const classifyBindStep =
  (visitorKeys: TSESLint.SourceCode["visitorKeys"]) =>
  (step: TSESTree.CallExpression, target: MemberTarget) =>
    match({
      isBind: APPLICATIVE_NAMESPACES.has(target.namespace) && BIND_METHODS.has(target.method),
      isPureFlatMap:
        PURE_MONAD_NAMESPACES.has(target.namespace) && FLATMAP_METHODS.has(target.method),
    })
      .with({ isBind: true }, () =>
        checkIndependentCallbackArg(target, visitorKeys)(
          O.fromNullable(step.arguments[1]),
          "independentBind",
        ),
      )
      .with({ isPureFlatMap: true }, () =>
        checkIndependentCallbackArg(target, visitorKeys)(
          O.fromNullable(step.arguments[0]),
          "independentFlatMap",
        ),
      )
      .otherwise(() => O.none);

const inspectCallStep = (
  call: TSESTree.CallExpression,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) => {
  const inspect = flow(
    resolveMemberCallTarget,
    O.flatMap((target) => classifyBindStep(visitorKeys)(call, target)),
    O.map((finding) => ({ call, finding })),
  );
  return inspect(call);
};

const isCallExpressionArg = (
  arg: TSESTree.CallExpressionArgument,
): arg is TSESTree.CallExpression => arg.type === AST_NODE_TYPES.CallExpression;

type BindReportDescriptor = Readonly<{
  node: TSESTree.Node;
  messageId: MessageIds;
  data: Readonly<Record<string, string>>;
}>;

const checkStepArg =
  (
    visitorKeys: TSESLint.SourceCode["visitorKeys"],
    report: (d: BindReportDescriptor) => void,
  ) =>
  (arg: TSESTree.CallExpressionArgument) => {
    const check = flow(
      O.fromPredicate(isCallExpressionArg),
      O.flatMap((call) => inspectCallStep(call, visitorKeys)),
      O.map(({ call, finding }) => {
        report({
          node: call,
          messageId: finding.messageId,
          data: { namespace: finding.namespace, method: finding.method },
        });
      }),
    );
    check(arg);
  };

const resolvePipelineSteps = (node: TSESTree.CallExpression) =>
  match([isPipeCallExpression(node), isFlowCallExpression(node)] as const)
    .with([true, false], () => O.some(node.arguments.slice(1)))
    .with([false, true], () => O.some(node.arguments))
    .otherwise(() => O.none);

export const preferApplicativeOverIndependentBind = createRule<[], MessageIds>({
  name: "prefer-applicative-over-independent-bind",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer Applicative combinators (`apS`, `Apply.sequenceS`, `apSecond`, or `Validation`) when `bind` or `flatMap` does not depend on previous monadic values.",
    },
    messages: {
      independentBind:
        "`{{namespace}}.{{method}}` ignores previously bound scope variables. Use Applicative `{{namespace}}.apS` (or `Apply.sequenceS` / `ApplicativeValidation`) to express independence.",
      independentFlatMap:
        "`{{namespace}}.{{method}}` ignores the previous value. Use Applicative composition (`apS`, `apSecond`, or `sequenceT`) instead of a sequential monadic bind.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    CallExpression: (node) => {
      O.map(
        RA.map(
          checkStepArg(context.sourceCode.visitorKeys, (d) => {
            context.report(d);
          }),
        ),
      )(resolvePipelineSteps(node));
    },
  }),
});
