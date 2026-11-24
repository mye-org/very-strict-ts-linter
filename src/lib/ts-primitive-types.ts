import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { match } from "ts-pattern";
import * as ts from "typescript";

const BRAND_PROP_RE = /^(__?brand|URI|_URI|_A)$/;
const EXPLICIT_BRAND_PROPS: ReadonlySet<string> = new Set(["__brand", "_brand"]);
const NEWTYPE_URI_PROPS: ReadonlySet<string> = new Set(["_URI"]);
const NEWTYPE_A_PROPS: ReadonlySet<string> = new Set(["_A"]);

const hasPropMatching = (predicate: (name: string) => boolean) =>
  RA.some((prop: ts.Symbol) => predicate(prop.name));

const hasNewtypeMarkerProps = Pred.and(
  hasPropMatching((n) => NEWTYPE_URI_PROPS.has(n)),
)(hasPropMatching((n) => NEWTYPE_A_PROPS.has(n)));

const hasDirectBrandProp = hasPropMatching((n) => EXPLICIT_BRAND_PROPS.has(n));

export const isBrandedOrNewtypeTsType = ((type: ts.Type) => {
  const props = type.getProperties();
  return type.isIntersection()
    ? hasPropMatching((n) => BRAND_PROP_RE.test(n))(props)
    : hasNewtypeMarkerProps(props) || hasDirectBrandProp(props);
}) satisfies (type: ts.Type) => boolean;

const hasTypeFlag = (flag: ts.TypeFlags) => {
  const isFlagSet = (type: ts.Type) => (type.flags & flag) !== 0;
  return isFlagSet;
};

export const resolveBarePrimitiveOrLiteralKind = ((type: ts.Type) =>
  match({
    branded: isBrandedOrNewtypeTsType(type),
    isString: hasTypeFlag(ts.TypeFlags.String | ts.TypeFlags.StringLiteral)(type),
    isNumber: hasTypeFlag(ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)(type),
  })
    .with({ branded: false, isString: true }, () => O.some("string" as const))
    .with({ branded: false, isNumber: true }, () => O.some("number" as const))
    .otherwise(() => O.none satisfies O.Option<"string" | "number">)) satisfies (
  type: ts.Type,
) => O.Option<"string" | "number">;

const PRIMITIVE_TYPE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.VoidLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Never;

const isPrimitiveTsTypeImpl: (type: ts.Type) => boolean = (type) =>
  (type.flags & PRIMITIVE_TYPE_FLAGS) !== 0 ||
  (type.isUnion() && type.types.length > 0 && RA.every(isPrimitiveTsTypeImpl)(type.types)) ||
  (type.isIntersection() &&
    isBrandedOrNewtypeTsType(type) &&
    RA.some(isPrimitiveTsTypeImpl)(type.types));

export const isPrimitiveTsType = isPrimitiveTsTypeImpl satisfies (type: ts.Type) => boolean;
