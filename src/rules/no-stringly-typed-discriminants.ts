import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";
import { analyzeStringlyTypedDiscriminants, DiscriminantCluster } from "../analyzers/stringly-typed-analyzer.js";
import { createRule } from "../lib/rule-factory.js";
import { makeLocationKey, resolveTsNodeOwnLocation } from "../lib/ts-node-location.js";

type Options = [Readonly<Record<"minBranches", number>>];
type MessageIds = "stringlyTypedDiscriminant";

const WITH_METHOD_NAMES: ReadonlySet<string> = new Set(["with"]);

const resolveTsLocationKey = flow(resolveTsNodeOwnLocation, makeLocationKey);

const resolveNodeLocationKey = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => resolveTsLocationKey(services.esTreeNodeToTSNodeMap.get(node));

const formatDiscriminantFields = (cluster: DiscriminantCluster) => ({
  target: cluster.targetKey,
  literals: cluster.literals.join(", "),
});

type DiscriminantEnv = Readonly<{
  readonly services: ParserServicesWithTypeInformation;
  readonly report: (d: TSESLint.ReportDescriptor<MessageIds>) => void;
}>;

const reportDiscriminant = (
  env: DiscriminantEnv,
) => (
  node: TSESTree.Node,
  byLocation: Readonly<Record<string, DiscriminantCluster>>,
) => {
  O.map((cluster: DiscriminantCluster) => {
    env.report({
      node,
      messageId: "stringlyTypedDiscriminant",
      data: formatDiscriminantFields(cluster),
    });
  })(O.fromNullable(byLocation[resolveNodeLocationKey(node, env.services)]));
};

const isWithProperty = (member: TSESTree.MemberExpression) =>
  member.property.type === AST_NODE_TYPES.Identifier &&
  WITH_METHOD_NAMES.has(member.property.name);

const isWithMemberCall = (c: TSESTree.CallExpression) =>
  c.callee.type === AST_NODE_TYPES.MemberExpression && isWithProperty(c.callee);

const extractFirstArgOfWithCall = flow(
  O.fromPredicate(isWithMemberCall),
  O.flatMap((c) => O.fromNullable(c.arguments[0])),
);

const checkWithCall = (
  env: DiscriminantEnv,
) => (
  node: TSESTree.CallExpression,
  byLocation: Readonly<Record<string, DiscriminantCluster>>,
) => {
  O.map((arg0: TSESTree.CallExpressionArgument) => {
    reportDiscriminant(env)(arg0, byLocation);
  })(extractFirstArgOfWithCall(node));
};

export const noStringlyTypedDiscriminants = createRule<Options, MessageIds>({
  name: "no-stringly-typed-discriminants",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag bare string or magic-number comparisons in conditionals, switch cases, and pattern matches; prefer explicit discriminated unions or policy objects.",
    },
    messages: {
      stringlyTypedDiscriminant:
        "Stringly-typed discriminant `{{target}}` compared against literals [{{literals}}]. Model this with a discriminated union or policy object.",
    },
    schema: [
      {
        type: "object",
        properties: {
          minBranches: { type: "number", minimum: 1 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ minBranches: 2 }],
  },
  create: (context, [options]) => {
    const services = ESLintUtils.getParserServices(context);
    const env: DiscriminantEnv = {
      services,
      report: (d) => { context.report(d); },
    };
    const resolveByLoc = () => analyzeStringlyTypedDiscriminants(services.program, options.minBranches).byLocation;
    const check = (node: TSESTree.Node) => { reportDiscriminant(env)(node, resolveByLoc()); };
    return {
      BinaryExpression: check,
      SwitchCase: check,
      CallExpression: (node) => { checkWithCall(env)(node, resolveByLoc()); },
    };
  },
});
