import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import {
  getBarePrimitiveOrLiteralKind,
  hasStrictSuffix,
  isInsideNewtypeDefinition,
} from "../utils/type-helpers.js";

type Options = [Readonly<{ readonly suffixes: ReadonlyArray<string> }>];
type MessageIds = "unitSuffixedPrimitive";

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
  pipe(
    customSuffixes,
    RA.findFirst((suffix) => hasUnitSuffix(name, suffix)),
    O.map((suffix) => ({ suffix, vo: "ValueObject" })),
  );

const matchSuffixSuggestion = (name: string, customSuffixes: ReadonlyArray<string>) =>
  pipe(
    DEFAULT_SUFFIX_SUGGESTIONS,
    RA.findFirst(([suffix]) => hasUnitSuffix(name, suffix)),
    O.map(([suffix, vo]) => ({ suffix, vo })),
    O.altW(() => matchCustomSuffix(name, customSuffixes)),
  );

const getNodePrimitiveKind = (
  reportNode: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) =>
  pipe(
    services.esTreeNodeToTSNodeMap.get(reportNode),
    (tsNode) => services.program.getTypeChecker().getTypeAtLocation(tsNode),
    getBarePrimitiveOrLiteralKind,
  );

const checkNamedTypedNode = (
  reportNode: TSESTree.Node,
  name: string,
  customSuffixes: ReadonlyArray<string>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  pipe(
    O.Do,
    O.filter(() => !isInsideNewtypeDefinition(reportNode)),
    O.apS("match", matchSuffixSuggestion(name, customSuffixes)),
    O.apS("primitiveKind", getNodePrimitiveKind(reportNode, services)),
    O.map(({ match: { suffix, vo }, primitiveKind }) => {
      report({
        node: reportNode,
        messageId: "unitSuffixedPrimitive",
        data: { name, suffix, primitiveKind, suggestedVo: vo },
      });
    }),
  );
};

const getPropertyKeyName = (key: TSESTree.PropertyName) =>
  key.type === AST_NODE_TYPES.Identifier ? O.some(key.name) : O.none;

const extractParamId = (param: TSESTree.Parameter) =>
  match(param)
    .with({ type: AST_NODE_TYPES.Identifier }, O.some)
    .with({ type: AST_NODE_TYPES.AssignmentPattern, left: { type: AST_NODE_TYPES.Identifier } }, (p) => O.some(p.left))
    .with({ type: AST_NODE_TYPES.TSParameterProperty, parameter: { type: AST_NODE_TYPES.Identifier } }, (p) => O.some(p.parameter))
    .with(P._, () => O.none as O.Option<TSESTree.Identifier>)
    .exhaustive();

const checkParam = (
  param: TSESTree.Parameter,
  customSuffixes: ReadonlyArray<string>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  pipe(
    extractParamId(param),
    O.map((node) => { checkNamedTypedNode(node, node.name, customSuffixes, services, report); }),
  );
};

const isNonFunctionDeclarator = (node: TSESTree.VariableDeclarator) =>
  node.id.type === AST_NODE_TYPES.Identifier &&
  node.init?.type !== AST_NODE_TYPES.ArrowFunctionExpression &&
  node.init?.type !== AST_NODE_TYPES.FunctionExpression;

const checkVariableDeclarator = (
  node: TSESTree.VariableDeclarator,
  suffixes: ReadonlyArray<string>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  pipe(
    O.some(node),
    O.filter(isNonFunctionDeclarator),
    O.map((d) => d.id),
    O.filter((id): id is TSESTree.Identifier => id.type === AST_NODE_TYPES.Identifier),
    O.map((id) => { checkNamedTypedNode(id, id.name, suffixes, services, report); }),
  );
};

const makePropChecker =
  (
    suffixes: ReadonlyArray<string>,
    services: ParserServicesWithTypeInformation,
    report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
  ) =>
  (node: TSESTree.TSPropertySignature | TSESTree.PropertyDefinition) => {
    pipe(getPropertyKeyName(node.key), O.map((name) => { checkNamedTypedNode(node, name, suffixes, services, report); }));
  };

const makeFnParamChecker =
  (
    suffixes: ReadonlyArray<string>,
    services: ParserServicesWithTypeInformation,
    report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
  ) =>
  (node: { readonly params: ReadonlyArray<TSESTree.Parameter> }) => {
    pipe(node.params, RA.map((p) => { checkParam(p, suffixes, services, report); }));
  };

const makeListeners = (
  suffixes: ReadonlyArray<string>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => ({
  TSPropertySignature: makePropChecker(suffixes, services, report),
  PropertyDefinition: makePropChecker(suffixes, services, report),
  VariableDeclarator: (node: TSESTree.VariableDeclarator) => { checkVariableDeclarator(node, suffixes, services, report); },
  FunctionDeclaration: makeFnParamChecker(suffixes, services, report),
  FunctionExpression: makeFnParamChecker(suffixes, services, report),
  ArrowFunctionExpression: makeFnParamChecker(suffixes, services, report),
  TSFunctionType: makeFnParamChecker(suffixes, services, report),
  TSMethodSignature: makeFnParamChecker(suffixes, services, report),
});

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
    makeListeners(options.suffixes, ESLintUtils.getParserServices(context), (d) => { context.report(d); }),
});
