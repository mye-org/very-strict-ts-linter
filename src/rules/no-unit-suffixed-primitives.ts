import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { isInsideNewtypeDefinition } from "../lib/newtype-scope.js";
import { createRule } from "../lib/rule-factory.js";
import { hasStrictSuffix } from "../lib/string-suffix.js";
import { resolveBarePrimitiveOrLiteralKind } from "../lib/ts-primitive-types.js";

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
  flow(
    RA.findFirst((suffix: string) => hasUnitSuffix(name, suffix)),
    O.map((suffix) => ({ suffix, vo: "ValueObject" })),
  )(customSuffixes);

const matchSuffixSuggestion = (name: string, customSuffixes: ReadonlyArray<string>) =>
  flow(
    RA.findFirst(([suffix]: readonly [string, string]) => hasUnitSuffix(name, suffix)),
    O.map(([suffix, vo]) => ({ suffix, vo })),
    O.altW(() => matchCustomSuffix(name, customSuffixes)),
  )(DEFAULT_SUFFIX_SUGGESTIONS);

const resolveNodePrimitiveKind = (
  reportNode: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) =>
  flow(
    (tsNode: ts.Node) => services.program.getTypeChecker().getTypeAtLocation(tsNode),
    resolveBarePrimitiveOrLiteralKind,
  )(services.esTreeNodeToTSNodeMap.get(reportNode));

const reportIfBarePrimitive = (
  reportNode: TSESTree.Node,
  name: string,
  suffix: string,
  vo: string,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  O.map((primitiveKind: string) => {
    report({
      node: reportNode,
      messageId: "unitSuffixedPrimitive",
      data: { name, suffix, primitiveKind, suggestedVo: vo },
    });
  })(resolveNodePrimitiveKind(reportNode, services));
};

const checkSuffixAndPrimitive = (
  reportNode: TSESTree.Node,
  name: string,
  customSuffixes: ReadonlyArray<string>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  O.map(({ suffix, vo }: Readonly<Record<"suffix" | "vo", string>>) => {
    reportIfBarePrimitive(reportNode, name, suffix, vo, services, report);
  })(matchSuffixSuggestion(name, customSuffixes));
};

const checkNamedTypedNode = (
  reportNode: TSESTree.Node,
  name: string,
  customSuffixes: ReadonlyArray<string>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(isInsideNewtypeDefinition(reportNode))
    .with(true, () => {})
    .with(false, () => {
      checkSuffixAndPrimitive(reportNode, name, customSuffixes, services, report);
    })
    .exhaustive();
};

const resolvePropertyKeyName = (key: TSESTree.PropertyName) =>
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
  O.map((node: TSESTree.Identifier) => {
    checkNamedTypedNode(node, node.name, customSuffixes, services, report);
  })(extractParamId(param));
};

const extractNonFnDeclaratorId = (node: TSESTree.VariableDeclarator) =>
  node.id.type === AST_NODE_TYPES.Identifier &&
  node.init?.type !== AST_NODE_TYPES.ArrowFunctionExpression &&
  node.init?.type !== AST_NODE_TYPES.FunctionExpression
    ? O.some(node.id)
    : O.none;

const checkVariableDeclarator = (
  node: TSESTree.VariableDeclarator,
  suffixes: ReadonlyArray<string>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  O.map((id: TSESTree.Identifier) => {
    checkNamedTypedNode(id, id.name, suffixes, services, report);
  })(extractNonFnDeclaratorId(node));
};

const makePropChecker =
  (
    suffixes: ReadonlyArray<string>,
    services: ParserServicesWithTypeInformation,
    report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
  ) =>
  (node: TSESTree.TSPropertySignature | TSESTree.PropertyDefinition) => {
    O.map((name: string) => {
      checkNamedTypedNode(node, name, suffixes, services, report);
    })(resolvePropertyKeyName(node.key));
  };

const makeFnParamChecker =
  (
    suffixes: ReadonlyArray<string>,
    services: ParserServicesWithTypeInformation,
    report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
  ) =>
  (node: { readonly params: ReadonlyArray<TSESTree.Parameter> }) => {
    RA.map((p: TSESTree.Parameter) => {
      checkParam(p, suffixes, services, report);
    })(node.params);
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
