import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "preferConstSatisfiesObject" | "preferConstSatisfiesArray";

const WIDENING_KEY_TYPES = new Set<AST_NODE_TYPES>([
  AST_NODE_TYPES.TSStringKeyword,
  AST_NODE_TYPES.TSNumberKeyword,
]);

const isWideningKeyNode = (node: TSESTree.TypeNode) =>
  WIDENING_KEY_TYPES.has(node.type) ||
  (node.type === AST_NODE_TYPES.TSTypeReference &&
    node.typeName.type === AST_NODE_TYPES.Identifier &&
    node.typeName.name === "PropertyKey");

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive unwrap
const unwrapReadonlyType = (node: TSESTree.TypeNode): TSESTree.TypeNode =>
  node.type === AST_NODE_TYPES.TSTypeReference &&
  node.typeName.type === AST_NODE_TYPES.Identifier &&
  node.typeName.name === "Readonly" &&
  node.typeArguments?.params.length === 1 &&
  node.typeArguments.params[0]
    ? unwrapReadonlyType(node.typeArguments.params[0])
    : node;

const isRecordWithWideningKey = (ref: TSESTree.TSTypeReference) =>
  Boolean(ref.typeArguments?.params[0] && isWideningKeyNode(ref.typeArguments.params[0]));

const isWideningRecordType = (node: TSESTree.TypeNode) =>
  match(unwrapReadonlyType(node))
    .with(
      { type: AST_NODE_TYPES.TSTypeReference, typeName: { type: AST_NODE_TYPES.Identifier, name: "Record" } },
      isRecordWithWideningKey,
    )
    .with({ type: AST_NODE_TYPES.TSTypeLiteral }, (lit) =>
      pipe(lit.members, RA.some((m) => m.type === AST_NODE_TYPES.TSIndexSignature)),
    )
    .with(P._, () => false)
    .exhaustive();

const isWideningArrayType = (node: TSESTree.TypeNode) =>
  match(unwrapReadonlyType(node))
    .with({ type: AST_NODE_TYPES.TSArrayType }, () => true)
    .with(
      { type: AST_NODE_TYPES.TSTypeReference, typeName: { type: AST_NODE_TYPES.Identifier } },
      (ref) => ref.typeName.name === "Array" || ref.typeName.name === "ReadonlyArray",
    )
    .with(P._, () => false)
    .exhaustive();

const isStaticObjectProperty = (prop: TSESTree.ObjectLiteralElement) =>
  prop.type === AST_NODE_TYPES.Property && !prop.computed;

const isNonEmptyStaticObject = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.ObjectExpression &&
  expr.properties.length > 0 &&
  pipe(expr.properties, RA.every(isStaticObjectProperty));

const isNonEmptyStaticArray = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.ArrayExpression &&
  expr.elements.length > 0 &&
  pipe(
    expr.elements,
    RA.every((el) => Boolean(el) && el?.type !== AST_NODE_TYPES.SpreadElement),
  );

const classifyDeclarator = (declarator: TSESTree.VariableDeclarator) =>
  declarator.id.type === AST_NODE_TYPES.Identifier &&
  declarator.id.typeAnnotation &&
  declarator.init
    ? match({
        isObj: isNonEmptyStaticObject(declarator.init),
        isWideningRec: isWideningRecordType(declarator.id.typeAnnotation.typeAnnotation),
        isArr: isNonEmptyStaticArray(declarator.init),
        isWideningArr: isWideningArrayType(declarator.id.typeAnnotation.typeAnnotation),
      })
        .with({ isObj: true, isWideningRec: true }, () => O.some<MessageIds>("preferConstSatisfiesObject"))
        .with({ isArr: true, isWideningArr: true }, () => O.some<MessageIds>("preferConstSatisfiesArray"))
        .otherwise(() => O.none)
    : O.none;

const reportVarDecl = (
  node: TSESTree.VariableDeclaration,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  match(node.kind === "const")
    .with(true, () => {
      pipe(
        node.declarations as ReadonlyArray<TSESTree.VariableDeclarator>,
        RA.map((decl) => {
          pipe(classifyDeclarator(decl), O.map((messageId) => { report({ node: decl, messageId }); }));
        }),
      );
    })
    .with(false, () => {})
    .exhaustive();
};

export const preferConstSatisfies = createRule<[], MessageIds>({
  name: "prefer-const-satisfies",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Encourage `as const satisfies ...` over widening type annotations on constant object and array literals so literal keys and tuple shapes remain available at compile time.",
    },
    messages: {
      preferConstSatisfiesObject:
        "Avoid widening object literal keys with a `Record`/index annotation. Use `as const satisfies ...` to preserve literal keys for compile-time checks.",
      preferConstSatisfiesArray:
        "Avoid widening an array literal with an array annotation. Use `as const satisfies ...` to preserve tuple and literal types at compile time.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    VariableDeclaration: (node) => { reportVarDecl(node, (d) => { context.report(d); }); },
  }),
});
