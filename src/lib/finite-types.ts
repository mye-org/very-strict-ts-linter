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
    ? decl.type !== undefined && isFiniteDiscriminantTypeNode(decl.type)
    : true;

const hasFiniteDiscriminantDecl = (prop: ts.Symbol) => {
  const decl = prop.valueDeclaration ?? prop.declarations?.[0];
  return decl ? isFiniteDeclNode(decl) : true;
};

const isDiscriminantProp = (prop: ts.Symbol) =>
  DISCRIMINANT_PROP_NAMES.has(prop.name) && hasFiniteDiscriminantDecl(prop);

const isDiscriminatedObject = flow(
  (type: ts.Type) => type.getProperties(),
  RA.some(isDiscriminantProp),
);

const isFiniteUnionMember = (member: ts.Type) =>
  isBooleanOrLiteralOrEnum(member) || isDiscriminatedObject(member);

export const isFiniteExhaustiveCandidate = (type: ts.Type): boolean =>
  isBooleanOrLiteralOrEnum(type) || (type.isUnion() && RA.every(isFiniteUnionMember)(type.types));
