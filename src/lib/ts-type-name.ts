import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

const ANONYMOUS_TYPE_NAMES: ReadonlySet<string> = new Set(["__type", "__object"]);

const extractRawTypeName = (type: ts.Type) =>
  type.aliasSymbol?.name ?? type.getSymbol()?.name;

export const resolveTsTypeName = flow(
  extractRawTypeName,
  O.fromNullable,
  O.filter((name) => !ANONYMOUS_TYPE_NAMES.has(name)),
);
