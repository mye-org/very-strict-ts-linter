import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { isInsideNewtypeDefinition } from "../lib/newtype-scope.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "rawStringOrNumber" | "rawBoolean";

type PrimitiveReportDescriptor = Readonly<{
  readonly node: TSESTree.Node;
  readonly messageId: MessageIds;
  readonly payload: O.Option<Readonly<Record<string, string>>>;
}>;

const reportPrimitiveType = (
  reportStringOrNumber: (node: TSESTree.Node, kind: string) => void,
  reportBoolean: (node: TSESTree.Node) => void,
) => (typeNode: TSESTree.TypeNode) => {
  match(typeNode)
    .with({ type: AST_NODE_TYPES.TSStringKeyword }, (matched) => { reportStringOrNumber(matched, "string"); })
    .with({ type: AST_NODE_TYPES.TSNumberKeyword }, (matched) => { reportStringOrNumber(matched, "number"); })
    .with({ type: AST_NODE_TYPES.TSBooleanKeyword }, reportBoolean)
    .with(P._, () => {})
    .exhaustive();
};

const extractDomainTypeNode = flow(
  O.map((ann: TSESTree.TSTypeAnnotation) => ann.typeAnnotation),
  O.filter((typeNode) => !isInsideNewtypeDefinition(typeNode)),
);

const checkTypeNode = (
  typeAnnotation: O.Option<TSESTree.TSTypeAnnotation>,
  report: (d: PrimitiveReportDescriptor) => void,
) => {
  O.map(
    reportPrimitiveType(
      (n, kind) => { report({ node: n, messageId: "rawStringOrNumber", payload: O.some({ kind }) }); },
      (n) => { report({ node: n, messageId: "rawBoolean", payload: O.none }); },
    ),
  )(extractDomainTypeNode(typeAnnotation));
};

const reportWithPayload = (
  reportPlain: (node: TSESTree.Node, messageId: MessageIds) => void,
  reportPayload: (descriptor: PrimitiveReportDescriptor, payload: Readonly<Record<string, string>>) => void,
) => (descriptor: PrimitiveReportDescriptor) => {
  O.match(
    () => { reportPlain(descriptor.node, descriptor.messageId); },
    (d: Readonly<Record<string, string>>) => { reportPayload(descriptor, d); },
  )(descriptor.payload);
};

const makeReporter = (reportFn: (d: TSESLint.ReportDescriptor<MessageIds>) => void) =>
  reportWithPayload(
    (n, id) => { reportFn({ node: n, messageId: id }); },
    (descriptor, d) => { reportFn({ node: descriptor.node, messageId: descriptor.messageId, data: d }); },
  );

export const noDomainRawPrimitives = createRule<[], MessageIds>({
  name: "no-domain-raw-primitives",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw string, number, and boolean in domain object properties (types, interfaces, and class fields); require branded newtypes and discriminated unions.",
    },
    messages: {
      rawStringOrNumber:
        "Avoid raw `{{kind}}` in domain properties. Use a branded Newtype from `newtype-ts` instead.",
      rawBoolean:
        "Avoid `boolean` in domain properties. Model states as a discriminated union (e.g. `{ kind: \"a\" } | { kind: \"b\" }`).",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const report = makeReporter((d) => { context.report(d); });
    return {
      TSPropertySignature: (node) => { checkTypeNode(O.fromNullable(node.typeAnnotation), report); },
      PropertyDefinition: (node) => { checkTypeNode(O.fromNullable(node.typeAnnotation), report); },
      TSParameterProperty: (node) => {
        checkTypeNode(
          node.parameter.type === AST_NODE_TYPES.Identifier
            ? O.fromNullable(node.parameter.typeAnnotation)
            : O.none,
          report,
        );
      },
    };
  },
});
