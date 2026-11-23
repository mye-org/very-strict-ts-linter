import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import {
  getEstreeChildNodes,
  isEsTreeFunctionNode,
  isMemberAssignment,
  isSetterMethodName,
} from "../utils/type-helpers.js";

type Options = [Readonly<{ readonly infraTargets: ReadonlyArray<string> }>];
type MessageIds = "inlineInfraSideEffect";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

const DEFAULT_INFRA_TARGETS = [
  "mailer",
  "email",
  "mail",
  "webhook",
  "analytics",
  "tracker",
  "queue",
  "sqs",
  "kafka",
  "sns",
  "pubsub",
  "slack",
  "axios",
  "fetch",
  "sendEmail",
  "sendWebhook",
  "trackEvent",
];

const STATE_MUTATION_METHODS = new Set(["save", "update", "insert", "upsert", "persist", "delete"]);

const collectNodesInFunction = (
  node: TSESTree.Node,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
): ReadonlyArray<TSESTree.Node> =>
  isEsTreeFunctionNode(node)
    ? []
    : [
        node,
        ...pipe(
          getEstreeChildNodes(node, visitorKeys),
          RA.flatMap((child) => collectNodesInFunction(child, visitorKeys)),
        ),
      ];

const isDomainMutationCall = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.CallExpression &&
  node.callee.type === AST_NODE_TYPES.MemberExpression &&
  !node.callee.computed &&
  node.callee.property.type === AST_NODE_TYPES.Identifier &&
  (STATE_MUTATION_METHODS.has(node.callee.property.name) || isSetterMethodName(node.callee.property.name));

const hasDomainStateMutation = (nodes: ReadonlyArray<TSESTree.Node>) =>
  pipe(
    nodes,
    RA.some(
      (n) =>
        isMemberAssignment(n) ||
        n.type === AST_NODE_TYPES.UpdateExpression ||
        isDomainMutationCall(n),
    ),
  );

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive target unwrap
const getCallTargetName = (expr: TSESTree.Expression): O.Option<string> =>
  match(expr)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => O.some(id.name))
    .with(
      {
        type: AST_NODE_TYPES.MemberExpression,
        computed: false,
        object: { type: AST_NODE_TYPES.ThisExpression },
        property: { type: AST_NODE_TYPES.Identifier },
      },
      (m) => O.some(m.property.name),
    )
    .with({ type: AST_NODE_TYPES.MemberExpression }, (m) => getCallTargetName(m.object))
    .with(P._, () => O.none as O.Option<string>)
    .exhaustive();

const isInfraCallName = (name: string, infraSet: ReadonlySet<string>) =>
  infraSet.has(name.toLowerCase());

const findInfraCallTarget = (
  node: TSESTree.Node,
  infraSet: ReadonlySet<string>,
) =>
  node.type === AST_NODE_TYPES.CallExpression
    ? pipe(
        getCallTargetName(node.callee),
        O.filter((name) => isInfraCallName(name, infraSet)),
        O.map((target) => ({ node, target })),
      )
    : O.none;

const reportInfraTargets = (
  nodes: ReadonlyArray<TSESTree.Node>,
  infraSet: ReadonlySet<string>,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  pipe(
    nodes,
    RA.filterMap((n) => findInfraCallTarget(n, infraSet)),
    RA.map(({ node, target }) => {
      report({ node, messageId: "inlineInfraSideEffect", data: { target } });
    }),
  );
};

const collectBodyNodes = (
  fn: FunctionNode,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) =>
  fn.body.type === AST_NODE_TYPES.BlockStatement
    ? pipe(fn.body.body, RA.flatMap((s) => collectNodesInFunction(s, visitorKeys)))
    : ([] as ReadonlyArray<TSESTree.Node>);

const checkFunctionSideEffects = (
  fn: FunctionNode,
  infraSet: ReadonlySet<string>,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  const nodes = collectBodyNodes(fn, visitorKeys);
  match(hasDomainStateMutation(nodes))
    .with(true, () => { reportInfraTargets(nodes, infraSet, report); })
    .with(false, () => {})
    .exhaustive();
};

const buildSideEffectListeners = (
  infraSet: ReadonlySet<string>,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  const check = (fn: FunctionNode) => {
    checkFunctionSideEffects(fn, infraSet, visitorKeys, report);
  };
  return {
    FunctionDeclaration: check,
    FunctionExpression: check,
    ArrowFunctionExpression: check,
  };
};

export const noInlineInfraSideEffects = createRule<Options, MessageIds>({
  name: "no-inline-infra-side-effects",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag inline infrastructure side effects (mailers, webhooks, analytics, queues, HTTP calls) inside functions that mutate domain state; emit Domain Events instead.",
    },
    messages: {
      inlineInfraSideEffect:
        "Inline infrastructure side effect `{{target}}` mixed with domain state mutation. Emit a Domain Event and handle side effects asynchronously.",
    },
    schema: [
      {
        type: "object",
        properties: {
          infraTargets: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ infraTargets: DEFAULT_INFRA_TARGETS }],
  },
  create: (context, [options]) =>
    buildSideEffectListeners(
      new Set(pipe(options.infraTargets, RA.map((t) => t.toLowerCase()))),
      context.sourceCode.visitorKeys,
      (d) => { context.report(d); },
    ),
});
