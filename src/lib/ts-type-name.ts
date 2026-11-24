import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

const ANONYMOUS_TYPE_NAMES: ReadonlySet<string> = new Set(["__type", "__object"]);

const resolveAliasSymbol = flow((t: ts.Type) => t.aliasSymbol, O.fromNullable);
const resolveDirectSymbol = flow((t: ts.Type) => t.getSymbol(), O.fromNullable);

const resolveTypeSymbolFor = (type: ts.Type) =>
  flow(resolveAliasSymbol, O.alt(() => resolveDirectSymbol(type)));

const resolveTypeSymbol = (type: ts.Type) => resolveTypeSymbolFor(type)(type);

export const resolveTsTypeName = flow(
  resolveTypeSymbol,
  O.map((sym) => sym.name),
  O.filter((name) => !ANONYMOUS_TYPE_NAMES.has(name)),
) satisfies (type: ts.Type) => O.Option<string>;
