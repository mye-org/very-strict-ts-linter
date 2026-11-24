import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

const ANONYMOUS_TYPE_NAMES: ReadonlySet<string> = new Set(["__type", "__object"]);

const resolveDirectSymbol = flow((t: ts.Type) => t.getSymbol(), O.fromNullable);

const resolveTypeSymbolFor = (type: ts.Type) =>
  flow(
    (t: ts.Type) => t.aliasSymbol,
    O.fromNullable,
    O.alt(() => resolveDirectSymbol(type)),
  );

const resolveTypeSymbol = (type: ts.Type) => resolveTypeSymbolFor(type)(type);

const isAnonymousTypeName = (name: string) => ANONYMOUS_TYPE_NAMES.has(name);

export const resolveTsTypeName = flow(
  resolveTypeSymbol,
  O.map((sym) => sym.name),
  O.filter(Pred.not(isAnonymousTypeName)),
) satisfies (type: ts.Type) => O.Option<string>;
