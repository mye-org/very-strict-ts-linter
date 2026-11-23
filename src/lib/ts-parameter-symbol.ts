import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

export const isTsParameterSymbol = flow(
  (sym: ts.Symbol) => sym.valueDeclaration,
  O.fromNullable,
  O.exists(ts.isParameter),
);
