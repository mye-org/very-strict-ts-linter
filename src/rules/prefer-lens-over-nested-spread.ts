import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import { isSameEsTreeAccessExpr } from "../utils/type-helpers.js";

type Options = [Readonly<Record<"minDepth", number>>];
type MessageIds = "preferLens";

const getStaticPropertyKey = (prop: TSESTree.Property) =>
  match({ computed: prop.computed, key: prop.key })
    .with({ computed: false, key: { type: AST_NODE_TYPES.Identifier } }, ({ key }) => O.some(key.name))
    .with({ key: { type: AST_NODE_TYPES.Literal } }, ({ key }) =>
      typeof key.value === "string" ? O.some(key.value) : O.none,
    )
    .otherwise(() => O.none);

const getSpreadTarget = (node: TSESTree.ObjectExpression) =>
  pipe(
    node.properties,
    RA.findFirst(
      (p): p is TSESTree.SpreadElement => p.type === AST_NODE_TYPES.SpreadElement,
    ),
    O.map((spread) => spread.argument),
  );

const isChildPropertyAccess = (
  innerTarget: TSESTree.Expression,
  outerTarget: TSESTree.Expression,
  propKey: string,
) =>
  innerTarget.type === AST_NODE_TYPES.MemberExpression &&
  !innerTarget.computed &&
  innerTarget.property.type === AST_NODE_TYPES.Identifier &&
  innerTarget.property.name === propKey &&
  isSameEsTreeAccessExpr(innerTarget.object, outerTarget);

const isMatchingNestedSpreadProp = (
  prop: TSESTree.ObjectLiteralElement,
  outerTarget: TSESTree.Expression,
) =>
  prop.type === AST_NODE_TYPES.Property &&
  prop.value.type === AST_NODE_TYPES.ObjectExpression &&
  prop.value.properties.length >= 2 &&
  pipe(
    O.Do,
    O.apS("key", getStaticPropertyKey(prop)),
    O.apS("innerTarget", getSpreadTarget(prop.value)),
    O.exists(({ key, innerTarget }) => isChildPropertyAccess(innerTarget, outerTarget, key)),
  );

const extractNestedSpreadObject = (
  prop: TSESTree.ObjectLiteralElement,
  outerTarget: TSESTree.Expression,
) =>
  prop.type === AST_NODE_TYPES.Property &&
  prop.value.type === AST_NODE_TYPES.ObjectExpression &&
  isMatchingNestedSpreadProp(prop, outerTarget)
    ? O.some(prop.value)
    : O.none;

const collectMatchingChildren = (
  properties: ReadonlyArray<TSESTree.ObjectLiteralElement>,
  outerTarget: TSESTree.Expression,
) => pipe(properties, RA.filterMap((p) => extractNestedSpreadObject(p, outerTarget)));

const getNestedSpreadChildren = (node: TSESTree.ObjectExpression) =>
  pipe(
    getSpreadTarget(node),
    O.match(
      () => [] as ReadonlyArray<TSESTree.ObjectExpression>,
      (outerTarget) => collectMatchingChildren(node.properties, outerTarget),
    ),
  );

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive spread depth
const computeSpreadDepth = (node: TSESTree.ObjectExpression): number =>
  pipe(
    getNestedSpreadChildren(node),
    RA.reduce(1, (maxD, child) => Math.max(maxD, 1 + computeSpreadDepth(child))),
  );

const isInsideMatchingParentSpread = (node: TSESTree.ObjectExpression) =>
  node.parent.type === AST_NODE_TYPES.Property &&
  node.parent.value === node &&
  node.parent.parent.type === AST_NODE_TYPES.ObjectExpression &&
  pipe(
    getSpreadTarget(node.parent.parent),
    O.exists(
      (outerTarget) =>
        node.parent.type === AST_NODE_TYPES.Property &&
        isMatchingNestedSpreadProp(node.parent, outerTarget),
    ),
  );

const checkObjectExpression = (
  node: TSESTree.ObjectExpression,
  minDepth: number,
  report: (depth: number) => void,
) => {
  pipe(
    O.fromPredicate((n: TSESTree.ObjectExpression) => !isInsideMatchingParentSpread(n))(node),
    O.map(computeSpreadDepth),
    O.filter((depth) => depth >= minDepth),
    O.map(report),
  );
};

export const preferLensOverNestedSpread = createRule<Options, MessageIds>({
  name: "prefer-lens-over-nested-spread",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer `monocle-ts` `Lens` composition (`flow(L.id<S>(), L.prop(...), L.modify(...))`) over nested immutable object spreads.",
    },
    messages: {
      preferLens:
        "Nested immutable object spread of depth {{depth}} (min {{minDepth}}). Use a `monocle-ts` `Lens` (`flow(L.id<S>(), L.prop(...), L.modify(...))`) to update nested fields declaratively.",
    },
    schema: [
      {
        type: "object",
        properties: {
          minDepth: { type: "number", minimum: 2 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ minDepth: 2 }],
  },
  create: (context, [options]) => ({
    ObjectExpression: (node) => {
      checkObjectExpression(node, options.minDepth, (depth) => {
        context.report({
          node,
          messageId: "preferLens",
          data: { depth: String(depth), minDepth: String(options.minDepth) },
        });
      });
    },
  }),
});
