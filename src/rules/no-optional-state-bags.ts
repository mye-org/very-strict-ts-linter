import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { match, P } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "discriminatedOptionalBag" | "multipleOptionalBag";

const OPTION_TYPE_NAMES: ReadonlySet<string> = new Set(["Option"]);
const DISCRIMINANT_NAMES = new Set([
  "kind",
  "type",
  "_tag",
  "tag",
  "status",
  "state",
  "phase",
  "step",
  "mode",
]);

const isOptionReference = (typeNode: TSESTree.TypeNode) =>
  typeNode.type === AST_NODE_TYPES.TSTypeReference &&
  match(typeNode.typeName)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => OPTION_TYPE_NAMES.has(id.name))
    .with({ type: AST_NODE_TYPES.TSQualifiedName }, (q) => OPTION_TYPE_NAMES.has(q.right.name))
    .with(P._, () => false)
    .exhaustive();

const hasOptionTypeAnnotation = (member: TSESTree.TSPropertySignature) =>
  match(member.typeAnnotation)
    .with({ type: AST_NODE_TYPES.TSTypeAnnotation }, (ann) => isOptionReference(ann.typeAnnotation))
    .otherwise(() => false);

const isOptionalOrOptionProp = (member: TSESTree.TypeElement) =>
  member.type === AST_NODE_TYPES.TSPropertySignature &&
  (member.optional || hasOptionTypeAnnotation(member));

const isDiscriminantProperty = (member: TSESTree.TypeElement) =>
  member.type === AST_NODE_TYPES.TSPropertySignature &&
  member.key.type === AST_NODE_TYPES.Identifier &&
  DISCRIMINANT_NAMES.has(member.key.name);

const classifyTypeLiteral = (node: TSESTree.TSTypeLiteral) =>
  match({
    hasDiscriminant: RA.some(isDiscriminantProperty)(node.members),
    optionalCount: RA.filter(isOptionalOrOptionProp)(node.members).length,
  })
    .with({ hasDiscriminant: true, optionalCount: P.when((n) => n >= 1) }, () =>
      O.some<MessageIds>("discriminatedOptionalBag"),
    )
    .with({ optionalCount: P.when((n) => n >= 2) }, () =>
      O.some<MessageIds>("multipleOptionalBag"),
    )
    .otherwise(() => O.none);

export const noOptionalStateBags = createRule<[], MessageIds>({
  name: "no-optional-state-bags",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow flat object types combining state tags with optional/`Option` properties or multiple optional fields; model mutually exclusive states with discriminated unions or phantom types.",
    },
    messages: {
      discriminatedOptionalBag:
        "Avoid combining a state/kind discriminant with optional or `Option` properties. Split into a discriminated union or phantom-typed states so invalid combinations cannot compile.",
      multipleOptionalBag:
        "Avoid bags of multiple optional or `Option` properties in one object type. Group coupled fields into explicit discriminated union variants.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    TSTypeLiteral: (node) => {
      O.map((messageId: MessageIds) => {
        context.report({ node, messageId });
      })(classifyTypeLiteral(node));
    },
  }),
});
