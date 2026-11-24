import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

const resolveFirstDeclaration = flow(
  (sym: ts.Symbol) => O.fromNullable(sym.declarations),
  O.flatMap(RA.head),
);

const resolveDirectSymbol = flow((t: ts.Type) => t.getSymbol(), O.fromNullable);

const resolveTypeSymbolFor = (type: ts.Type) =>
  flow(
    (t: ts.Type) => t.aliasSymbol,
    O.fromNullable,
    O.alt(() => resolveDirectSymbol(type)),
  );

const resolveTypeSymbol = (type: ts.Type) => resolveTypeSymbolFor(type)(type);

export const resolveTsTypeDeclarationFile = flow(
  resolveTypeSymbol,
  O.flatMap(resolveFirstDeclaration),
  O.map((decl) => decl.getSourceFile().fileName),
) satisfies (type: ts.Type) => O.Option<string>;
