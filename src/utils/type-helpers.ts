import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow, pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";

export const isUnsafeOrMustName = (name: string) =>
  name.endsWith("Unsafe") || name.startsWith("must");

const getNamedParentKey = (gp: TSESTree.Node) =>
  match(gp)
    .with({ type: AST_NODE_TYPES.VariableDeclarator, id: { type: AST_NODE_TYPES.Identifier } }, (d) => O.some(d.id.name))
    .with({ type: AST_NODE_TYPES.Property, key: { type: AST_NODE_TYPES.Identifier } }, (p) => O.some(p.key.name))
    .with({ type: AST_NODE_TYPES.MethodDefinition, key: { type: AST_NODE_TYPES.Identifier } }, (p) => O.some(p.key.name))
    .with(P._, () => O.none)
    .exhaustive();

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const matchEnclosingFunctionParent = (parent: TSESTree.Node): O.Option<string> =>
  match(parent)
    .with({ type: AST_NODE_TYPES.FunctionDeclaration }, (fn) => (fn.id ? O.some(fn.id.name) : O.none))
    .with({ type: AST_NODE_TYPES.FunctionExpression }, (fn) => getNamedParentKey(fn.parent))
    .with({ type: AST_NODE_TYPES.ArrowFunctionExpression }, (fn) => getNamedParentKey(fn.parent))
    .with({ type: AST_NODE_TYPES.MethodDefinition }, (m) => (m.key.type === AST_NODE_TYPES.Identifier ? O.some(m.key.name) : O.none))
    .with(P._, () => getEnclosingFunctionName(parent))
    .exhaustive();

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive callback
const getEnclosingFunctionName = (node: TSESTree.Node): O.Option<string> =>
  pipe(O.fromNullable(node.parent), O.flatMap(matchEnclosingFunctionParent));

export const isInsideUnsafeOrMustFunction = (node: TSESTree.Node) =>
  pipe(getEnclosingFunctionName(node), O.exists(isUnsafeOrMustName));

const isNewtypeReference = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.TSTypeReference &&
  node.typeName.type === AST_NODE_TYPES.Identifier &&
  node.typeName.name === "Newtype";

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const hasNewtypeAncestor = (node: TSESTree.Node): boolean =>
  isNewtypeReference(node) || hasNewtypeInAncestors(O.fromNullable(node.parent));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const hasNewtypeInAncestors = (current: O.Option<TSESTree.Node>): boolean =>
  pipe(current, O.exists(hasNewtypeAncestor));

export const isInsideNewtypeDefinition = flow(
  (node: TSESTree.Node) => O.fromNullable(node.parent),
  hasNewtypeInAncestors,
);

export const isPredicateReturnType = (node: TSESTree.Node) =>
  node.parent?.type === AST_NODE_TYPES.TSTypeAnnotation &&
  (node.parent.parent.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.parent.parent.type === AST_NODE_TYPES.FunctionDeclaration ||
    node.parent.parent.type === AST_NODE_TYPES.FunctionExpression ||
    node.parent.parent.type === AST_NODE_TYPES.TSFunctionType);

const isArraySymbol = (type: ts.Type) => {
  const name = type.getSymbol()?.name;
  return name === "Array" || name === "ReadonlyArray";
};

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive callback
export const isArrayLikeType = (type: ts.Type, checker: ts.TypeChecker): boolean =>
  match({
    isArrayOrTuple: checker.isArrayType(type) || checker.isTupleType(type),
    isUnion: type.isUnion(),
  })
    .with({ isArrayOrTuple: true }, () => true)
    .with({ isUnion: true }, () => type.isUnion() && pipe(type.types, RA.every((t) => isArrayLikeType(t, checker))))
    .otherwise(() => isArraySymbol(type));

const isBooleanOrLiteralOrEnum = (type: ts.Type) =>
  Boolean(
    type.flags &
      (ts.TypeFlags.Boolean |
        ts.TypeFlags.BooleanLiteral |
        ts.TypeFlags.Enum |
        ts.TypeFlags.EnumLiteral |
        ts.TypeFlags.StringLiteral |
        ts.TypeFlags.NumberLiteral),
  );

const isDiscriminatedObject = (type: ts.Type) =>
  pipe(
    type.getProperties(),
    RA.some(
      (prop) =>
        prop.name === "kind" ||
        prop.name === "type" ||
        prop.name === "_tag" ||
        prop.name === "tag",
    ),
  );

export const isFiniteExhaustiveCandidate = (type: ts.Type) =>
  isBooleanOrLiteralOrEnum(type) ||
  (type.isUnion() &&
    pipe(
      type.types,
      RA.every(
        flow(
          (member) =>
            isBooleanOrLiteralOrEnum(member) || isDiscriminatedObject(member),
        ),
      ),
    ));

const BRAND_PROP_RE = /^(__?brand|URI|_URI|_A)$/;

export const isBrandedOrNewtypeTsType = (type: ts.Type) =>
  type.isIntersection() &&
  pipe(
    type.getProperties(),
    RA.some((prop) => BRAND_PROP_RE.test(prop.name)),
  );

export const getBarePrimitiveKind = (type: ts.Type) =>
  match({
    branded: isBrandedOrNewtypeTsType(type),
    isString: Boolean(type.flags & ts.TypeFlags.String),
    isNumber: Boolean(type.flags & ts.TypeFlags.Number),
  })
    .with({ branded: false, isString: true }, () => O.some("string" as const))
    .with({ branded: false, isNumber: true }, () => O.some("number" as const))
    .otherwise(() => O.none as O.Option<"string" | "number">);

export const getBarePrimitiveOrLiteralKind = (type: ts.Type) =>
  match({
    branded: isBrandedOrNewtypeTsType(type),
    isString: Boolean(type.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)),
    isNumber: Boolean(type.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)),
  })
    .with({ branded: false, isString: true }, () => O.some("string" as const))
    .with({ branded: false, isNumber: true }, () => O.some("number" as const))
    .otherwise(() => O.none as O.Option<"string" | "number">);

export const isBooleanTsType = (type: ts.Type) =>
  Boolean(type.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) ||
  (type.isUnion() &&
    type.types.length > 0 &&
    pipe(type.types, RA.every((m) => Boolean(m.flags & ts.TypeFlags.BooleanLiteral))));

const isOptionTypeRefName = (typeName: TSESTree.EntityName) =>
  match(typeName)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => id.name === "Option")
    .with({ type: AST_NODE_TYPES.TSQualifiedName }, (q) => q.right.name === "Option")
    .with(P._, () => false)
    .exhaustive();

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST helper
export const isNullableOrOptionTypeNode = (typeNode: TSESTree.TypeNode): boolean =>
  match(typeNode)
    .with({ type: AST_NODE_TYPES.TSNullKeyword }, { type: AST_NODE_TYPES.TSUndefinedKeyword }, () => true)
    .with({ type: AST_NODE_TYPES.TSTypeReference }, (ref) => isOptionTypeRefName(ref.typeName))
    .with({ type: AST_NODE_TYPES.TSUnionType }, (u) => pipe(u.types, RA.some(isNullableOrOptionTypeNode)))
    .with(P._, () => false)
    .exhaustive();

const isOptionTaggedMember = (t: ts.Type) =>
  pipe(
    O.fromNullable(t.getProperty("_tag")),
    O.exists((prop) => prop.valueDeclaration !== undefined),
  );

export const isOptionTsType = (type: ts.Type) =>
  type.aliasSymbol?.name === "Option" ||
  type.getSymbol()?.name === "Option" ||
  (type.isUnion() &&
    type.types.length === 2 &&
    pipe(type.types, RA.every(isOptionTaggedMember)));

export const isNullableOrOptionTsType = (type: ts.Type) =>
  isOptionTsType(type) ||
  (type.isUnion() &&
    pipe(
      type.types,
      RA.some((m) => Boolean(m.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))),
    ));

export const getTsTypeName = (type: ts.Type) =>
  pipe(
    O.fromNullable(type.aliasSymbol?.name ?? type.getSymbol()?.name),
    O.filter((name) => name !== "__type" && name !== "__object"),
  );

export const getTsTypeDeclarationFile = (type: ts.Type) =>
  pipe(
    O.fromNullable(type.aliasSymbol?.declarations?.[0] ?? type.getSymbol()?.declarations?.[0]),
    O.map((decl) => decl.getSourceFile().fileName),
  );

const WRAPPER_CONTAINER_NAMES = new Set([
  "Array",
  "ReadonlyArray",
  "Set",
  "ReadonlySet",
  "Option",
  "Promise",
  "Task",
  "IO",
  "Either",
  "TaskEither",
  "ReaderTaskEither",
]);

const getContainerTypeArgs = (type: ts.Type, checker: ts.TypeChecker) => {
  const name = type.aliasSymbol?.name ?? type.getSymbol()?.name;
  return name && WRAPPER_CONTAINER_NAMES.has(name)
    ? type.aliasTypeArguments ?? checker.getTypeArguments(type as ts.TypeReference)
    : ([] as ReadonlyArray<ts.Type>);
};

const unwrapArgList = (args: ReadonlyArray<ts.Type>, fallback: ts.Type, checker: ts.TypeChecker) =>
  args.length > 0 ? pipe(args, RA.flatMap((arg) => unwrapContainerTsTypes(arg, checker))) : [fallback];

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive type unwrap
export const unwrapContainerTsTypes = (type: ts.Type, checker: ts.TypeChecker): ReadonlyArray<ts.Type> =>
  type.isUnion()
    ? pipe(
        type.types,
        RA.filter((m) => !(m.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never))),
        RA.flatMap((m) => unwrapContainerTsTypes(m, checker)),
      )
    : unwrapArgList(getContainerTypeArgs(type, checker), type, checker);

const isEstreeNodeObj = (val: object): val is TSESTree.Node =>
  Boolean(val) && "type" in val;

const extractChildValue = (val: object) =>
  Array.isArray(val)
    ? pipe(val as ReadonlyArray<object>, RA.filter(isEstreeNodeObj))
    : pipe(
        O.fromPredicate(isEstreeNodeObj)(val),
        O.match(
          () => [] as ReadonlyArray<TSESTree.Node>,
          (childNode) => [childNode],
        ),
      );

const extractKeyChildren = (node: TSESTree.Node, key: string) =>
  pipe(
    O.fromNullable((node as object as Readonly<Record<string, object>>)[key]),
    O.match(() => [] as ReadonlyArray<TSESTree.Node>, extractChildValue),
  );

export const getEstreeChildNodes = (
  node: TSESTree.Node,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) =>
  pipe(
    visitorKeys[node.type] ?? [],
    RA.flatMap((key) => extractKeyChildren(node, key)),
  );

export const isSetterMethodName = (name: string) =>
  name.startsWith("set") && name.length > 3 && name.charAt(3) >= "A" && name.charAt(3) <= "Z";

export const isEsTreeAnonymousFunctionNode = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
  node.type === AST_NODE_TYPES.FunctionExpression;

export const isEsTreeFunctionNode = (
  node: TSESTree.Node,
): node is
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression =>
  node.type === AST_NODE_TYPES.FunctionDeclaration || isEsTreeAnonymousFunctionNode(node);

export const hasFunctionInit = (declarator: TSESTree.VariableDeclarator) =>
  pipe(O.fromNullable(declarator.init), O.exists(isEsTreeAnonymousFunctionNode));

export const isPipeCallExpression = (node: TSESTree.CallExpression) =>
  node.callee.type === AST_NODE_TYPES.Identifier && node.callee.name === "pipe";

export const hasStrictSuffix = (name: string, suffix: string) =>
  name.length > suffix.length && name.endsWith(suffix);

export const isMemberAssignment = (
  node: TSESTree.Node,
): node is TSESTree.AssignmentExpression & { readonly left: TSESTree.MemberExpression } =>
  node.type === AST_NODE_TYPES.AssignmentExpression &&
  node.left.type === AST_NODE_TYPES.MemberExpression;

export const PREDICATE_NAME_RE = /^(is|has|can|should)(?=$|[A-Z0-9_])/;

export const isTsParameterSymbol = (sym: ts.Symbol) =>
  Boolean(sym.valueDeclaration && ts.isParameter(sym.valueDeclaration));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
export const getEnclosingEsTreeFunction = (node: TSESTree.Node): O.Option<TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression> =>
  pipe(
    O.fromNullable(node.parent),
    O.flatMap((parent) =>
      isEsTreeFunctionNode(parent) ? O.some(parent) : getEnclosingEsTreeFunction(parent),
    ),
  );

export const isCalleeOfCallExpression = (node: TSESTree.Node) =>
  node.parent?.type === AST_NODE_TYPES.CallExpression && node.parent.callee === node;
