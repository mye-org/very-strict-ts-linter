import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { match, P } from "ts-pattern";
import { hasFunctionInit } from "../lib/estree-function-nodes.js";
import { isInsideNewtypeDefinition } from "../lib/newtype-scope.js";
import { createRule } from "../lib/rule-factory.js";
import { hasStrictSuffix } from "../lib/string-suffix.js";
import { resolveBarePrimitiveOrLiteralKind } from "../lib/ts-primitive-types.js";

type Options = [Readonly<{ readonly suffixes: ReadonlyArray<string> }>];
type MessageIds = "unitSuffixedPrimitive";

const NONE_IDENTIFIER: O.Option<TSESTree.Identifier> = O.none;

const DEFAULT_SUFFIX_SUGGESTIONS = [
  ["InCents", "Money"],
  ["Cents", "Money"],
  ["Millis", "Duration"],
  ["Milliseconds", "Duration"],
  ["Seconds", "Duration"],
  ["Minutes", "Duration"],
  ["Hours", "Duration"],
  ["Days", "Duration"],
  ["Ms", "Duration"],
  ["Kg", "Weight"],
  ["Grams", "Weight"],
  ["Meters", "Distance"],
  ["Km", "Distance"],
  ["Percent", "Percentage"],
  ["Pct", "Percentage"],
  ["Email", "EmailAddress"],
  ["Iban", "Iban"],
  ["Sku", "Sku"],
  ["Uuid", "Uuid"],
  ["Url", "Url"],
  ["Phone", "PhoneNumber"],
] as const satisfies ReadonlyArray<readonly [string, string]>;

const hasUnitSuffix = hasStrictSuffix;

const matchCustomSuffix = (name: string, customSuffixes: ReadonlyArray<string>) =>
  O.map((suffix: string) => ({ suffix, vo: "ValueObject" }))(
    RA.findFirst((suffix: string) => hasUnitSuffix(name, suffix))(customSuffixes),
  );

const matchDefaultSuffix = (name: string) =>
  RA.findFirstMap(([suffix, vo]: readonly [string, string]) =>
    hasUnitSuffix(name, suffix) ? O.some({ suffix, vo }) : O.none,
  )(DEFAULT_SUFFIX_SUGGESTIONS);

const matchSuffixSuggestion = (name: string, customSuffixes: ReadonlyArray<string>) =>
  O.altW(() => matchCustomSuffix(name, customSuffixes))(matchDefaultSuffix(name));

const resolveNodeTsType = (
  reportNode: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) =>
  services.program
    .getTypeChecker()
    .getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(reportNode));

const resolveNodePrimitiveKind = (
  reportNode: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => resolveBarePrimitiveOrLiteralKind(resolveNodeTsType(reportNode, services));

type UnitSuffixEnv = Readonly<{
  readonly suffixes: ReadonlyArray<string>;
  readonly services: ParserServicesWithTypeInformation;
  readonly report: (d: TSESLint.ReportDescriptor<MessageIds>) => void;
}>;

const reportIfBarePrimitive = (
  env: UnitSuffixEnv,
  suggestion: Readonly<Record<"suffix" | "vo", string>>,
) => (reportNode: TSESTree.Node, name: string) => {
  O.map((primitiveKind: string) => {
    env.report({
      node: reportNode,
      messageId: "unitSuffixedPrimitive",
      data: {
        name,
        suffix: suggestion.suffix,
        primitiveKind,
        suggestedVo: suggestion.vo,
      },
    });
  })(resolveNodePrimitiveKind(reportNode, env.services));
};

const checkSuffixAndPrimitive = (env: UnitSuffixEnv) => (reportNode: TSESTree.Node, name: string) => {
  O.map((suggestion: Readonly<Record<"suffix" | "vo", string>>) => {
    reportIfBarePrimitive(env, suggestion)(reportNode, name);
  })(matchSuffixSuggestion(name, env.suffixes));
};

const checkNamedTypedNode = (env: UnitSuffixEnv) => (reportNode: TSESTree.Node, name: string) => {
  match(isInsideNewtypeDefinition(reportNode))
    .with(true, () => {})
    .with(false, () => {
      checkSuffixAndPrimitive(env)(reportNode, name);
    })
    .exhaustive();
};

type NodeChecker = (reportNode: TSESTree.Node, name: string) => void;

const resolvePropertyKeyName = (key: TSESTree.PropertyName) =>
  key.type === AST_NODE_TYPES.Identifier ? O.some(key.name) : O.none;

const extractParamId = (param: TSESTree.Parameter) =>
  match(param)
    .with({ type: AST_NODE_TYPES.Identifier }, O.some)
    .with({ type: AST_NODE_TYPES.AssignmentPattern, left: { type: AST_NODE_TYPES.Identifier } }, (p) => O.some(p.left))
    .with({ type: AST_NODE_TYPES.TSParameterProperty, parameter: { type: AST_NODE_TYPES.Identifier } }, (p) => O.some(p.parameter))
    .with(P._, () => NONE_IDENTIFIER)
    .exhaustive();

const checkParam = (checkNode: NodeChecker) => (param: TSESTree.Parameter) => {
  O.map((node: TSESTree.Identifier) => {
    checkNode(node, node.name);
  })(extractParamId(param));
};

const extractNonFnDeclaratorId = (node: TSESTree.VariableDeclarator) =>
  node.id.type === AST_NODE_TYPES.Identifier && !hasFunctionInit(node)
    ? O.some(node.id)
    : O.none;

const checkVariableDeclarator = (checkNode: NodeChecker) => (node: TSESTree.VariableDeclarator) => {
  O.map((id: TSESTree.Identifier) => {
    checkNode(id, id.name);
  })(extractNonFnDeclaratorId(node));
};

const makePropChecker =
  (checkNode: NodeChecker) =>
  (node: TSESTree.TSPropertySignature | TSESTree.PropertyDefinition) => {
    O.map((name: string) => {
      checkNode(node, name);
    })(resolvePropertyKeyName(node.key));
  };

const makeFnParamChecker =
  (checkNode: NodeChecker) =>
  (node: { readonly params: ReadonlyArray<TSESTree.Parameter> }) => {
    RA.map(checkParam(checkNode))(node.params);
  };

const makeListeners = (env: UnitSuffixEnv) => {
  const checkNode = checkNamedTypedNode(env);
  const propChecker = makePropChecker(checkNode);
  const fnParamChecker = makeFnParamChecker(checkNode);
  return {
    TSPropertySignature: propChecker,
    PropertyDefinition: propChecker,
    VariableDeclarator: checkVariableDeclarator(checkNode),
    FunctionDeclaration: fnParamChecker,
    FunctionExpression: fnParamChecker,
    ArrowFunctionExpression: fnParamChecker,
    TSFunctionType: fnParamChecker,
    TSMethodSignature: fnParamChecker,
  };
};

export const noUnitSuffixedPrimitives = createRule<Options, MessageIds>({
  name: "no-unit-suffixed-primitives",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag identifiers ending in unit or format suffixes (e.g., *InCents, *Ms, *Kg, *Email, *Iban, *Sku) typed as bare string or number; prefer strongly typed Value Objects or Newtypes.",
    },
    messages: {
      unitSuffixedPrimitive:
        "`{{name}}` uses unit/format suffix `{{suffix}}` with bare `{{primitiveKind}}`. Wrap it in a `{{suggestedVo}}` Value Object or Newtype.",
    },
    schema: [
      {
        type: "object",
        properties: {
          suffixes: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ suffixes: [] }],
  },
  create: (context, [options]) =>
    makeListeners({
      suffixes: options.suffixes,
      services: ESLintUtils.getParserServices(context),
      report: (d) => { context.report(d); },
    }),
});
