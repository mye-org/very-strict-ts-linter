import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "preferReadonlyArray" | "preferReadonlyMap" | "preferReadonlySet";

const TYPE_TO_MESSAGE = {
  Array: "preferReadonlyArray",
  Map: "preferReadonlyMap",
  Set: "preferReadonlySet",
} as const satisfies Readonly<Record<string, MessageIds>>;

const lookupCollectionMessage = (typeName: TSESTree.EntityName) =>
  match(typeName)
    .with({ type: AST_NODE_TYPES.Identifier }, ({ name }) => RR.lookup(name, TYPE_TO_MESSAGE))
    .with(P._, () => O.none)
    .exhaustive();

const reportTypeReference = (
  node: TSESTree.TSTypeReference,
  report: (n: TSESTree.Node, messageId: MessageIds) => void,
) => {
  flow(
    lookupCollectionMessage,
    O.map((messageId) => {
      report(node, messageId);
    }),
  )(node.typeName);
};

const isReadonlyOperatorNode = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.TSTypeOperator && node.operator === "readonly";

const isReadonlyTupleRest = (rest: TSESTree.TSRestType) =>
  rest.parent.type === AST_NODE_TYPES.TSTupleType && isReadonlyOperatorNode(rest.parent.parent);

const isReadonlyArrayType = ({ parent }: TSESTree.TSArrayType) =>
  isReadonlyOperatorNode(parent) ||
  (parent.type === AST_NODE_TYPES.TSRestType && isReadonlyTupleRest(parent));

export const preferReadonlyCollections = createRule<[], MessageIds>({
  name: "prefer-readonly-collections",
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce ReadonlyArray, ReadonlyMap, and ReadonlySet over mutable Array, Map, and Set in type annotations.",
    },
    messages: {
      preferReadonlyArray:
        "Use `ReadonlyArray<T>` instead of mutable `Array<T>` or `T[]`.",
      preferReadonlyMap:
        "Use `ReadonlyMap<K, V>` instead of mutable `Map<K, V>`.",
      preferReadonlySet:
        "Use `ReadonlySet<T>` instead of mutable `Set<T>`.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    TSArrayType: (node) => {
      match(isReadonlyArrayType(node))
        .with(true, () => {})
        .with(false, () => {
          context.report({ node, messageId: "preferReadonlyArray" });
        })
        .exhaustive();
    },
    TSTypeReference: (node) => {
      reportTypeReference(node, (n, messageId) => {
        context.report({ node: n, messageId });
      });
    },
  }),
});
