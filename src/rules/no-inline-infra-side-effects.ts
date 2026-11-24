import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { match, P } from "ts-pattern";
import { collectEstreeChildNodes } from "../lib/estree-children.js";
import { isEsTreeFunctionNode } from "../lib/estree-function-nodes.js";
import { isMemberAssignment } from "../lib/member-assignment.js";
import { createRule } from "../lib/rule-factory.js";
import { isSetterMethodName } from "../lib/setter-method.js";

type Options = [Readonly<{ readonly infraTargets: ReadonlyArray<string> }>];
type MessageIds = "inlineInfraSideEffect";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

const NONE_STRING: O.Option<string> = O.none;
const EMPTY_NODES: ReadonlyArray<TSESTree.Node> = [];

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
        ...RA.flatMap((child: TSESTree.Node) => collectNodesInFunction(child, visitorKeys))(
          collectEstreeChildNodes(node, visitorKeys),
        ),
      ];

const isMutationMemberCallee = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.MemberExpression &&
  !callee.computed &&
  callee.property.type === AST_NODE_TYPES.Identifier &&
  (STATE_MUTATION_METHODS.has(callee.property.name) || isSetterMethodName(callee.property.name));

const isDomainMutationCall = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.CallExpression && isMutationMemberCallee(node.callee);

const hasDomainStateMutation = RA.some(
  (n: TSESTree.Node) =>
    isMemberAssignment(n) ||
    n.type === AST_NODE_TYPES.UpdateExpression ||
    isDomainMutationCall(n),
);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive target unwrap
const resolveCallTargetName = (expr: TSESTree.Expression): O.Option<string> =>
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
    .with({ type: AST_NODE_TYPES.MemberExpression }, (m) => resolveCallTargetName(m.object))
    .with(P._, () => NONE_STRING)
    .exhaustive();

const normalizeTargetName = (name: string) => name.toLowerCase();

const isInfraCallName = (name: string, infraSet: ReadonlySet<string>) =>
  infraSet.has(normalizeTargetName(name));

const findMatchingInfraName = (
  callee: TSESTree.Expression,
  infraSet: ReadonlySet<string>,
) => O.filter((name: string) => isInfraCallName(name, infraSet))(resolveCallTargetName(callee));

const matchInfraTarget = (
  node: TSESTree.CallExpression,
  infraSet: ReadonlySet<string>,
) => O.map((target: string) => ({ node, target }))(findMatchingInfraName(node.callee, infraSet));

const findInfraCallTarget = (
  node: TSESTree.Node,
  infraSet: ReadonlySet<string>,
) => (node.type === AST_NODE_TYPES.CallExpression ? matchInfraTarget(node, infraSet) : O.none);

type SideEffectEnv = Readonly<{
  readonly infraSet: ReadonlySet<string>;
  readonly visitorKeys: TSESLint.SourceCode["visitorKeys"];
  readonly report: (d: TSESLint.ReportDescriptor<MessageIds>) => void;
}>;

const reportInfraTargets = (env: SideEffectEnv) => (
  nodes: ReadonlyArray<TSESTree.Node>,
) => {
  const targets = RA.filterMap((n: TSESTree.Node) => findInfraCallTarget(n, env.infraSet))(nodes);
  RA.map(({ node, target }: (typeof targets)[number]) => {
    env.report({ node, messageId: "inlineInfraSideEffect", data: { target } });
  })(targets);
};

const collectBodyNodes = (
  fn: FunctionNode,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) =>
  fn.body.type === AST_NODE_TYPES.BlockStatement
    ? RA.flatMap((s: TSESTree.Statement) => collectNodesInFunction(s, visitorKeys))(fn.body.body)
    : EMPTY_NODES;

const checkFunctionSideEffects = (env: SideEffectEnv) => (fn: FunctionNode) => {
  const nodes = collectBodyNodes(fn, env.visitorKeys);
  match(hasDomainStateMutation(nodes))
    .with(true, () => { reportInfraTargets(env)(nodes); })
    .with(false, () => {})
    .exhaustive();
};

const buildSideEffectListeners = (env: SideEffectEnv) => {
  const check = checkFunctionSideEffects(env);
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
    buildSideEffectListeners({
      infraSet: new Set(RA.map(normalizeTargetName)(options.infraTargets)),
      visitorKeys: context.sourceCode.visitorKeys,
      report: (d) => { context.report(d); },
    }),
});
