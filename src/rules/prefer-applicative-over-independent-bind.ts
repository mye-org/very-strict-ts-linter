import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import {
  getEstreeChildNodes,
  isEsTreeAnonymousFunctionNode,
  isFlowCallExpression,
  isPipeCallExpression,
} from "../utils/type-helpers.js";

type MessageIds = "independentBind" | "independentFlatMap";
type MemberTarget = Readonly<Record<"namespace" | "method", string>>;

const APPLICATIVE_NAMESPACES = new Set(["O", "E", "TE", "T", "IO", "IOE", "R", "RE", "RTE", "RT"]);
const PURE_MONAD_NAMESPACES = new Set(["O", "E"]);
const BIND_METHODS = new Set(["bind", "bindW"]);
const FLATMAP_METHODS = new Set(["flatMap", "flatMapW"]);

const getMemberCallTarget = (node: TSESTree.CallExpression) =>
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
  pipe(
    obj.properties,
    RA.flatMap((prop) =>
      prop.type === AST_NODE_TYPES.RestElement
        ? collectPatternNames(prop)
        : collectPatternNames(prop.value as TSESTree.BindingName),
    ),
  );

const collectArrayPatternNames = (arr: TSESTree.ArrayPattern) =>
  pipe(
    arr.elements,
    RA.filterMap(O.fromNullable),
    RA.flatMap((el) => collectPatternNames(el as TSESTree.BindingName)),
  );

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive pattern extraction
const collectPatternNames = (param: TSESTree.Parameter | TSESTree.BindingName): ReadonlyArray<string> =>
  match(param)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => [id.name])
    .with({ type: AST_NODE_TYPES.AssignmentPattern }, (a) => collectPatternNames(a.left))
    .with({ type: AST_NODE_TYPES.RestElement }, (r) =>
      r.argument.type === AST_NODE_TYPES.Identifier ? [r.argument.name] : [],
    )
    .with({ type: AST_NODE_TYPES.ObjectPattern }, collectObjectPatternNames)
    .with({ type: AST_NODE_TYPES.ArrayPattern }, collectArrayPatternNames)
    .with(P._, () => [] as ReadonlyArray<string>)
    .exhaustive();

const isNonReferenceIdentifier = (id: TSESTree.Identifier) =>
  (id.parent.type === AST_NODE_TYPES.MemberExpression &&
    !id.parent.computed &&
    id.parent.property === id) ||
  (id.parent.type === AST_NODE_TYPES.Property &&
    !id.parent.computed &&
    id.parent.key === id &&
    !id.parent.shorthand) ||
  id.parent.type === AST_NODE_TYPES.TSTypeReference;

const hasReferenceToAny = (
  node: TSESTree.Node,
  names: ReadonlySet<string>,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST reference scan
): boolean =>
  node.type === AST_NODE_TYPES.Identifier
    ? names.has(node.name) && !isNonReferenceIdentifier(node)
    : pipe(
        getEstreeChildNodes(node, visitorKeys),
        RA.some((child) => hasReferenceToAny(child, names, visitorKeys)),
      );

const isParamUsedInFn = (
  firstParam: TSESTree.Parameter,
  fnBody: TSESTree.Node,
  keys: TSESLint.SourceCode["visitorKeys"],
) => {
  const names = new Set(collectPatternNames(firstParam));
  return names.size > 0 && hasReferenceToAny(fnBody, names, keys);
};

const isIndependentCallback = (
  arg: TSESTree.CallExpressionArgument,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) =>
  isEsTreeAnonymousFunctionNode(arg) &&
  !pipe(
    O.fromNullable(arg.params[0]),
    O.exists((firstParam) => isParamUsedInFn(firstParam, arg.body, visitorKeys)),
  );

const checkIndependentCallbackArg = (
  arg: O.Option<TSESTree.CallExpressionArgument>,
  messageId: MessageIds,
  target: MemberTarget,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) =>
  pipe(
    arg,
    O.filter((cb) => isIndependentCallback(cb, visitorKeys)),
    O.as({ messageId, ...target }),
  );

const classifyBindStep = (
  step: TSESTree.CallExpression,
  target: MemberTarget,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) =>
  match({
    isBind: APPLICATIVE_NAMESPACES.has(target.namespace) && BIND_METHODS.has(target.method),
    isPureFlatMap:
      PURE_MONAD_NAMESPACES.has(target.namespace) && FLATMAP_METHODS.has(target.method),
  })
    .with({ isBind: true }, () =>
      checkIndependentCallbackArg(O.fromNullable(step.arguments[1]), "independentBind", target, visitorKeys),
    )
    .with({ isPureFlatMap: true }, () =>
      checkIndependentCallbackArg(O.fromNullable(step.arguments[0]), "independentFlatMap", target, visitorKeys),
    )
    .otherwise(() => O.none);

const inspectCallStep = (
  call: TSESTree.CallExpression,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) =>
  pipe(
    getMemberCallTarget(call),
    O.flatMap((target) => classifyBindStep(call, target, visitorKeys)),
    O.map((finding) => ({ call, finding })),
  );

const checkStepArg = (
  arg: TSESTree.CallExpressionArgument,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
  report: (node: TSESTree.Node, messageId: MessageIds, data: Readonly<Record<string, string>>) => void,
) => {
  pipe(
    O.fromPredicate((a: TSESTree.CallExpressionArgument): a is TSESTree.CallExpression => a.type === AST_NODE_TYPES.CallExpression)(arg),
    O.flatMap((call) => inspectCallStep(call, visitorKeys)),
    O.map(({ call, finding }) => {
      report(call, finding.messageId, { namespace: finding.namespace, method: finding.method });
    }),
  );
};

const getPipelineSteps = (node: TSESTree.CallExpression) =>
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
      pipe(
        getPipelineSteps(node),
        O.map(
          RA.map((step) => {
            checkStepArg(step, context.sourceCode.visitorKeys, (n, messageId, data) => {
              context.report({ node: n, messageId, data });
            });
          }),
        ),
      );
    },
  }),
});
