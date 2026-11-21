import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { pipe } from "fp-ts/lib/function.js";
import { analyzeStringlyTypedDiscriminants, DiscriminantCluster } from "../analyzers/stringly-typed-analyzer.js";
import { createRule } from "../utils/create-rule.js";
import { getTsNodeOwnLocation, makeLocationKey } from "../utils/ts-ast-helpers.js";

type Options = [Readonly<Record<"minBranches", number>>];
type MessageIds = "stringlyTypedDiscriminant";

const getNodeLocationKey = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => pipe(services.esTreeNodeToTSNodeMap.get(node), getTsNodeOwnLocation, makeLocationKey);

const reportDiscriminant = (
  node: TSESTree.Node,
  byLocation: Readonly<Record<string, DiscriminantCluster>>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  pipe(
    O.fromNullable(byLocation[getNodeLocationKey(node, services)]),
    O.map((cluster) => {
      report({
        node,
        messageId: "stringlyTypedDiscriminant",
        data: { target: cluster.targetKey, literals: cluster.literals.join(", ") },
      });
    }),
  );
};

const isWithMemberCall = (c: TSESTree.CallExpression) =>
  c.callee.type === AST_NODE_TYPES.MemberExpression &&
  c.callee.property.type === AST_NODE_TYPES.Identifier &&
  c.callee.property.name === "with";

const checkWithCall = (
  node: TSESTree.CallExpression,
  byLocation: Readonly<Record<string, DiscriminantCluster>>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  pipe(
    O.some(node),
    O.filter(isWithMemberCall),
    O.flatMap((c) => O.fromNullable(c.arguments[0])),
    O.map((arg0) => { reportDiscriminant(arg0, byLocation, services, report); }),
  );
};

export const noStringlyTypedDiscriminants = createRule<Options, MessageIds>({
  name: "no-stringly-typed-discriminants",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag bare string or magic-number comparisons in conditionals, switch cases, and pattern matches; prefer explicit discriminated unions, enums, or policy objects.",
    },
    messages: {
      stringlyTypedDiscriminant:
        "Stringly-typed discriminant `{{target}}` compared against literals [{{literals}}]. Model this with a discriminated union, enum, or policy object.",
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
    const report = (d: TSESLint.ReportDescriptor<MessageIds>) => { context.report(d); };
    const getByLoc = () => analyzeStringlyTypedDiscriminants(services.program, options.minBranches).byLocation;
    const check = (node: TSESTree.Node) => { reportDiscriminant(node, getByLoc(), services, report); };
    return {
      BinaryExpression: check,
      SwitchCase: check,
      CallExpression: (node) => { checkWithCall(node, getByLoc(), services, report); },
    };
  },
});
