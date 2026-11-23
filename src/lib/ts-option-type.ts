import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

const OPTION_TYPE_NAMES: ReadonlySet<string> = new Set(["Option"]);
const OPTION_MEMBER_TAGS: ReadonlySet<string> = new Set(["None", "Some"]);

const extractOptionTagFromTypeNode = (typeNode: ts.TypeNode) =>
  ts.isLiteralTypeNode(typeNode) &&
  ts.isStringLiteral(typeNode.literal) &&
  OPTION_MEMBER_TAGS.has(typeNode.literal.text)
    ? O.some(typeNode.literal.text)
    : O.none;

const extractOptionTagFromDecl = (decl: ts.Declaration) =>
  ts.isPropertySignature(decl) && decl.type
    ? extractOptionTagFromTypeNode(decl.type)
    : O.none;

const extractOptionTagFromProperty = flow(
  (t: ts.Type) => t.getProperty("_tag"),
  O.fromNullable,
  O.flatMap((prop) => O.fromNullable(prop.valueDeclaration)),
  O.flatMap(extractOptionTagFromDecl),
);

const resolveSymbolOptionTag = flow(
  (t: ts.Type) => t.getSymbol()?.name,
  O.fromNullable,
  O.filter((name) => OPTION_MEMBER_TAGS.has(name)),
);

const optionTagResolvers = [resolveSymbolOptionTag, extractOptionTagFromProperty] as const;

const resolveOptionMemberTag = (t: ts.Type) =>
  RA.findFirstMap((resolve: (type: ts.Type) => O.Option<string>) => resolve(t))(
    optionTagResolvers,
  );

const hasOptionTypeName = (type: ts.Type) =>
  OPTION_TYPE_NAMES.has(type.aliasSymbol?.name ?? "") ||
  OPTION_TYPE_NAMES.has(type.getSymbol()?.name ?? "");

const hasBothOptionTags = (types: ReadonlyArray<ts.Type>) => {
  const tags = RA.filterMap(resolveOptionMemberTag)(types);
  return tags.length === 2 && new Set(tags).size === 2;
};

export const isOptionTsType = (type: ts.Type): boolean =>
  hasOptionTypeName(type) ||
  (type.isUnion() && type.types.length === 2 && hasBothOptionTags(type.types));
