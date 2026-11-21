import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "discriminatedOptionalBag" | "multipleOptionalBag";

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
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => id.name === "Option")
    .with({ type: AST_NODE_TYPES.TSQualifiedName }, (q) => q.right.name === "Option")
    .with(P._, () => false)
    .exhaustive();

const isOptionalOrOptionProp = (member: TSESTree.TypeElement) =>
  member.type === AST_NODE_TYPES.TSPropertySignature &&
  (member.optional ||
    pipe(
      O.fromNullable(member.typeAnnotation?.typeAnnotation),
      O.exists(isOptionReference),
    ));

const isDiscriminantProperty = (member: TSESTree.TypeElement) =>
  member.type === AST_NODE_TYPES.TSPropertySignature &&
  member.key.type === AST_NODE_TYPES.Identifier &&
  DISCRIMINANT_NAMES.has(member.key.name);

const classifyTypeLiteral = (node: TSESTree.TSTypeLiteral) =>
  match({
    hasDiscriminant: pipe(node.members, RA.some(isDiscriminantProperty)),
    optionalCount: pipe(node.members, RA.filter(isOptionalOrOptionProp)).length,
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
      pipe(
        classifyTypeLiteral(node),
        O.map((messageId) => {
          context.report({ node, messageId });
        }),
      );
    },
  }),
});
