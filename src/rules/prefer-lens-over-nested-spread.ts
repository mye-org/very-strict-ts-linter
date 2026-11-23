import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { isSameEsTreeAccessExpr } from "../lib/estree-access-equality.js";
import { createRule } from "../lib/rule-factory.js";

type Options = [Readonly<Record<"minDepth", number>>];
type MessageIds = "preferLens";

const resolveStaticPropertyKey = (prop: TSESTree.Property) =>
  match({ computed: prop.computed, key: prop.key })
    .with({ computed: false, key: { type: AST_NODE_TYPES.Identifier } }, ({ key }) => O.some(key.name))
    .with({ key: { type: AST_NODE_TYPES.Literal } }, ({ key }) =>
      typeof key.value === "string" ? O.some(key.value) : O.none,
    )
    .otherwise(() => O.none);

const isSpreadElement = (p: TSESTree.ObjectLiteralElement): p is TSESTree.SpreadElement =>
  p.type === AST_NODE_TYPES.SpreadElement;

const resolveSpreadTarget = (node: TSESTree.ObjectExpression) =>
  flow(
    RA.findFirst(isSpreadElement),
    O.map((spread) => spread.argument),
  )(node.properties);

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

const isMatchingNestedSpreadObj = (
  prop: TSESTree.Property,
  obj: TSESTree.ObjectExpression,
  outerTarget: TSESTree.Expression,
) =>
  obj.properties.length >= 2 &&
  match([resolveStaticPropertyKey(prop), resolveSpreadTarget(obj)] as const)
    .with([{ _tag: "Some" }, { _tag: "Some" }], ([{ value: key }, { value: innerTarget }]) =>
      isChildPropertyAccess(innerTarget, outerTarget, key),
    )
    .otherwise(() => false);

const isMatchingNestedSpreadProp = (
  prop: TSESTree.ObjectLiteralElement,
  outerTarget: TSESTree.Expression,
) =>
  prop.type === AST_NODE_TYPES.Property &&
  prop.value.type === AST_NODE_TYPES.ObjectExpression &&
  isMatchingNestedSpreadObj(prop, prop.value, outerTarget);

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
) => RA.filterMap((p: TSESTree.ObjectLiteralElement) => extractNestedSpreadObject(p, outerTarget))(properties);

const resolveNestedSpreadChildren = (node: TSESTree.ObjectExpression) =>
  flow(
    resolveSpreadTarget,
    O.match(
      () => [] as ReadonlyArray<TSESTree.ObjectExpression>,
      (outerTarget) => collectMatchingChildren(node.properties, outerTarget),
    ),
  )(node);

const pickGreater = (a: number, b: number) => Math.max(a, b);

const accumulateSpreadDepth = (maxD: number, child: TSESTree.ObjectExpression) =>
  pickGreater(maxD, 1 + computeSpreadDepth(child));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive spread depth
const computeSpreadDepth = (node: TSESTree.ObjectExpression): number =>
  flow(resolveNestedSpreadChildren, RA.reduce(1, accumulateSpreadDepth))(node);

const isChildOfMatchingSpreadObj = (prop: TSESTree.Property) =>
  prop.parent.type === AST_NODE_TYPES.ObjectExpression &&
  O.exists((outerTarget: TSESTree.Expression) => isMatchingNestedSpreadProp(prop, outerTarget))(
    resolveSpreadTarget(prop.parent),
  );

const isInsideMatchingParentSpread = (node: TSESTree.ObjectExpression) =>
  node.parent.type === AST_NODE_TYPES.Property &&
  node.parent.value === node &&
  isChildOfMatchingSpreadObj(node.parent);

const reportIfDeepSpread = (
  depth: number,
  minDepth: number,
  report: (depth: number) => void,
) => {
  match(depth >= minDepth)
    .with(true, () => { report(depth); })
    .with(false, () => {})
    .exhaustive();
};

const checkObjectExpression = (
  node: TSESTree.ObjectExpression,
  minDepth: number,
  report: (depth: number) => void,
) => {
  match(isInsideMatchingParentSpread(node))
    .with(false, () => { reportIfDeepSpread(computeSpreadDepth(node), minDepth, report); })
    .with(true, () => {})
    .exhaustive();
};

const formatSpreadDepthFields = (depth: number, minDepth: number) => ({
  depth: String(depth),
  minDepth: String(minDepth),
});

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
          data: formatSpreadDepthFields(depth, options.minDepth),
        });
      });
    },
  }),
});
