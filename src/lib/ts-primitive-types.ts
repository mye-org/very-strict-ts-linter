import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { match } from "ts-pattern";
import * as ts from "typescript";

const BRAND_PROP_RE = /^(__?brand|URI|_URI|_A)$/;
const EXPLICIT_BRAND_PROPS: ReadonlySet<string> = new Set(["__brand", "_brand"]);
const NEWTYPE_URI_PROPS: ReadonlySet<string> = new Set(["_URI"]);
const NEWTYPE_A_PROPS: ReadonlySet<string> = new Set(["_A"]);

const hasPropMatching = (props: ReadonlyArray<ts.Symbol>, predicate: (name: string) => boolean) =>
  RA.some((prop: ts.Symbol) => predicate(prop.name))(props);

const hasNewtypeMarkerProps = (props: ReadonlyArray<ts.Symbol>) =>
  hasPropMatching(props, (n) => NEWTYPE_URI_PROPS.has(n)) &&
  hasPropMatching(props, (n) => NEWTYPE_A_PROPS.has(n));

const hasDirectBrandProp = (props: ReadonlyArray<ts.Symbol>) =>
  hasPropMatching(props, (n) => EXPLICIT_BRAND_PROPS.has(n));

export const isBrandedOrNewtypeTsType = (type: ts.Type) => {
  const props = type.getProperties();
  return type.isIntersection()
    ? hasPropMatching(props, (n) => BRAND_PROP_RE.test(n))
    : hasNewtypeMarkerProps(props) || hasDirectBrandProp(props);
};

const hasTypeFlag = (type: ts.Type, flag: ts.TypeFlags) => (type.flags & flag) !== 0;

export const resolveBarePrimitiveOrLiteralKind = (type: ts.Type) =>
  match({
    branded: isBrandedOrNewtypeTsType(type),
    isString: hasTypeFlag(type, ts.TypeFlags.String | ts.TypeFlags.StringLiteral),
    isNumber: hasTypeFlag(type, ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral),
  })
    .with({ branded: false, isString: true }, () => O.some("string" as const))
    .with({ branded: false, isNumber: true }, () => O.some("number" as const))
    .otherwise(() => O.none as O.Option<"string" | "number">);

const PRIMITIVE_TYPE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.VoidLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Never;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive type predicate
export const isPrimitiveTsType = (type: ts.Type): boolean =>
  (type.flags & PRIMITIVE_TYPE_FLAGS) !== 0 ||
  (type.isUnion() && type.types.length > 0 && RA.every(isPrimitiveTsType)(type.types)) ||
  (type.isIntersection() &&
    isBrandedOrNewtypeTsType(type) &&
    RA.some(isPrimitiveTsType)(type.types));
