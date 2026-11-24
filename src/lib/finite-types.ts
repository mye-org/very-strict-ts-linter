import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

const DISCRIMINANT_PROP_NAMES: ReadonlySet<string> = new Set(["kind", "type", "_tag", "tag"]);

const FINITE_PRIMITIVE_FLAGS =
  ts.TypeFlags.Boolean |
  ts.TypeFlags.BooleanLiteral |
  ts.TypeFlags.Enum |
  ts.TypeFlags.EnumLiteral |
  ts.TypeFlags.StringLiteral |
  ts.TypeFlags.NumberLiteral;

const isBooleanOrLiteralOrEnum = (type: ts.Type) => (type.flags & FINITE_PRIMITIVE_FLAGS) !== 0;

const isLiteralOrRefTypeNode = (m: ts.TypeNode) =>
  ts.isLiteralTypeNode(m) || ts.isTypeReferenceNode(m);

const isFiniteDiscriminantTypeNode = (typeNode: ts.TypeNode) =>
  isLiteralOrRefTypeNode(typeNode) ||
  (ts.isUnionTypeNode(typeNode) && RA.every(isLiteralOrRefTypeNode)(typeNode.types));

const isFiniteDeclNode = (decl: ts.Declaration) =>
  ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)
    ? O.exists(isFiniteDiscriminantTypeNode)(O.fromNullable(decl.type))
    : true;

const resolveFirstPropDeclaration = flow(
  (prop: ts.Symbol) => prop.declarations,
  O.fromNullable,
  O.flatMap(RA.head),
);

const resolveValuePropDeclaration = flow(
  (prop: ts.Symbol) => prop.valueDeclaration,
  O.fromNullable,
);

const resolvePropDeclarationFor = (prop: ts.Symbol) =>
  flow(
    resolveValuePropDeclaration,
    O.alt(() => resolveFirstPropDeclaration(prop)),
  );

const resolvePropDeclaration = (prop: ts.Symbol) =>
  resolvePropDeclarationFor(prop)(prop);

const isNonFiniteDeclNode = (decl: ts.Declaration) => !isFiniteDeclNode(decl);

const isNonFiniteDiscriminantDecl = flow(
  resolvePropDeclaration,
  O.exists(isNonFiniteDeclNode),
);

const isFiniteDiscriminantDecl = (prop: ts.Symbol) =>
  !isNonFiniteDiscriminantDecl(prop);

const isDiscriminantProp = (prop: ts.Symbol) =>
  DISCRIMINANT_PROP_NAMES.has(prop.name) && isFiniteDiscriminantDecl(prop);

const isDiscriminatedObject = flow(
  (type: ts.Type) => type.getProperties(),
  RA.some(isDiscriminantProp),
);

const isFiniteUnionMember = (member: ts.Type) =>
  isBooleanOrLiteralOrEnum(member) || isDiscriminatedObject(member);

export const isFiniteExhaustiveCandidate = ((type: ts.Type) =>
  isBooleanOrLiteralOrEnum(type) ||
  (type.isUnion() && RA.every(isFiniteUnionMember)(type.types))) satisfies (
  type: ts.Type,
) => boolean;
