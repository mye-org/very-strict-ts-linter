import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "preferConstSatisfiesObject" | "preferConstSatisfiesArray";

const WIDENING_KEY_TYPES = new Set<AST_NODE_TYPES>([
  AST_NODE_TYPES.TSStringKeyword,
  AST_NODE_TYPES.TSNumberKeyword,
]);
const PROPERTY_KEY_NAMES: ReadonlySet<string> = new Set(["PropertyKey"]);
const READONLY_TYPE_NAMES: ReadonlySet<string> = new Set(["Readonly"]);
const WIDENING_ARRAY_TYPE_NAMES: ReadonlySet<string> = new Set(["Array", "ReadonlyArray"]);

const isWideningKeyNode = (node: TSESTree.TypeNode) =>
  WIDENING_KEY_TYPES.has(node.type) ||
  (node.type === AST_NODE_TYPES.TSTypeReference &&
    node.typeName.type === AST_NODE_TYPES.Identifier &&
    PROPERTY_KEY_NAMES.has(node.typeName.name));

const resolveSingleTypeArg = flow(
  (ref: TSESTree.TSTypeReference) => O.fromNullable(ref.typeArguments),
  O.flatMap((ta) => (ta.params.length === 1 ? O.fromNullable(ta.params[0]) : O.none)),
);

const resolveFirstTypeArg = flow(
  (ref: TSESTree.TSTypeReference) => O.fromNullable(ref.typeArguments),
  O.flatMap((ta) => O.fromNullable(ta.params[0])),
);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive unwrap
const unwrapReadonlyType = (node: TSESTree.TypeNode): TSESTree.TypeNode => {
  const unwrapInner = flow(
    resolveSingleTypeArg,
    O.map(unwrapReadonlyType),
    O.getOrElseW(() => node),
  );
  return node.type === AST_NODE_TYPES.TSTypeReference &&
    node.typeName.type === AST_NODE_TYPES.Identifier &&
    READONLY_TYPE_NAMES.has(node.typeName.name)
    ? unwrapInner(node)
    : node;
};

const isRecordWithWideningKey = flow(resolveFirstTypeArg, O.exists(isWideningKeyNode));

const isWideningRecordType = (node: TSESTree.TypeNode) =>
  match(unwrapReadonlyType(node))
    .with(
      { type: AST_NODE_TYPES.TSTypeReference, typeName: { type: AST_NODE_TYPES.Identifier, name: "Record" } },
      isRecordWithWideningKey,
    )
    .with({ type: AST_NODE_TYPES.TSTypeLiteral }, (lit) =>
      RA.some((m: TSESTree.TypeElement) => m.type === AST_NODE_TYPES.TSIndexSignature)(lit.members),
    )
    .with(P._, () => false)
    .exhaustive();

const isWideningArrayType = (node: TSESTree.TypeNode) =>
  match(unwrapReadonlyType(node))
    .with({ type: AST_NODE_TYPES.TSArrayType }, () => true)
    .with(
      { type: AST_NODE_TYPES.TSTypeReference, typeName: { type: AST_NODE_TYPES.Identifier } },
      (ref) => WIDENING_ARRAY_TYPE_NAMES.has(ref.typeName.name),
    )
    .with(P._, () => false)
    .exhaustive();

const isStaticObjectProperty = (prop: TSESTree.ObjectLiteralElement) =>
  prop.type === AST_NODE_TYPES.Property && !prop.computed;

const isNonEmptyStaticObject = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.ObjectExpression &&
  expr.properties.length > 0 &&
  RA.every(isStaticObjectProperty)(expr.properties);

const isNonSpreadElement = flow(
  (el: TSESTree.ArrayExpression["elements"][number]) => el,
  O.fromNullable,
  O.exists((node) => node.type !== AST_NODE_TYPES.SpreadElement),
);

const isNonEmptyStaticArray = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.ArrayExpression &&
  expr.elements.length > 0 &&
  RA.every(isNonSpreadElement)(expr.elements);

const classifyAnnotatedInit = (
  init: TSESTree.Expression,
  annotation: TSESTree.TSTypeAnnotation,
) =>
  match({
    isObj: isNonEmptyStaticObject(init),
    isWideningRec: isWideningRecordType(annotation.typeAnnotation),
    isArr: isNonEmptyStaticArray(init),
    isWideningArr: isWideningArrayType(annotation.typeAnnotation),
  })
    .with({ isObj: true, isWideningRec: true }, () => O.some<MessageIds>("preferConstSatisfiesObject"))
    .with({ isArr: true, isWideningArr: true }, () => O.some<MessageIds>("preferConstSatisfiesArray"))
    .otherwise(() => O.none);

const classifyDeclarator = (declarator: TSESTree.VariableDeclarator) =>
  declarator.id.type === AST_NODE_TYPES.Identifier &&
  declarator.id.typeAnnotation &&
  declarator.init
    ? classifyAnnotatedInit(declarator.init, declarator.id.typeAnnotation)
    : O.none;

const reportDeclarator = (
  decl: TSESTree.VariableDeclarator,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  O.map((messageId: MessageIds) => { report({ node: decl, messageId }); })(classifyDeclarator(decl));
};

const reportVarDecl = (
  node: TSESTree.VariableDeclaration,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  match(node.kind === "const")
    .with(true, () => {
      RA.map((decl: TSESTree.VariableDeclarator) => { reportDeclarator(decl, report); })(
        node.declarations,
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
