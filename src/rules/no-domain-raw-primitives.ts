import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { isInsideNewtypeDefinition } from "../lib/newtype-scope.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "rawStringOrNumber" | "rawBoolean";

const reportPrimitiveType = (
  typeNode: TSESTree.TypeNode,
  reportStringOrNumber: (node: TSESTree.Node, kind: string) => void,
  reportBoolean: (node: TSESTree.Node) => void,
) => {
  match(typeNode.type)
    .with(AST_NODE_TYPES.TSStringKeyword, () => { reportStringOrNumber(typeNode, "string"); })
    .with(AST_NODE_TYPES.TSNumberKeyword, () => { reportStringOrNumber(typeNode, "number"); })
    .with(AST_NODE_TYPES.TSBooleanKeyword, () => { reportBoolean(typeNode); })
    .with(P._, () => {})
    .exhaustive();
};

const checkTypeNode = (
  typeAnnotation: O.Option<TSESTree.TSTypeAnnotation>,
  report: (node: TSESTree.Node, messageId: MessageIds, payload: O.Option<Readonly<Record<string, string>>>) => void,
) => {
  flow(
    O.map((ann: TSESTree.TSTypeAnnotation) => ann.typeAnnotation),
    O.filter((typeNode) => !isInsideNewtypeDefinition(typeNode)),
    O.map((typeNode) => {
      reportPrimitiveType(
        typeNode,
        (n, kind) => { report(n, "rawStringOrNumber", O.some({ kind })); },
        (n) => { report(n, "rawBoolean", O.none); },
      );
    }),
  )(typeAnnotation);
};

const reportWithPayload = (
  reportPlain: (node: TSESTree.Node, messageId: MessageIds) => void,
  reportPayload: (node: TSESTree.Node, messageId: MessageIds, payload: Readonly<Record<string, string>>) => void,
  node: TSESTree.Node,
  messageId: MessageIds,
  payload: O.Option<Readonly<Record<string, string>>>,
) => {
  O.match(
    () => { reportPlain(node, messageId); },
    (d: Readonly<Record<string, string>>) => { reportPayload(node, messageId, d); },
  )(payload);
};

const makeReporter =
  (reportFn: (d: TSESLint.ReportDescriptor<MessageIds>) => void) =>
  (node: TSESTree.Node, messageId: MessageIds, payload: O.Option<Readonly<Record<string, string>>>) => {
    reportWithPayload(
      (n, id) => { reportFn({ node: n, messageId: id }); },
      (n, id, d) => { reportFn({ node: n, messageId: id, data: d }); },
      node,
      messageId,
      payload,
    );
  };

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
