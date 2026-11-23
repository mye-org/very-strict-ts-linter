import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

const extractFirstDeclaration = (sym: ts.Symbol) => sym.declarations?.[0];

const resolveTypeSymbol = (type: ts.Type) =>
  O.fromNullable(type.aliasSymbol ?? type.getSymbol());

const resolveFirstDeclaration = flow(extractFirstDeclaration, O.fromNullable);

export const resolveTsTypeDeclarationFile = flow(
  resolveTypeSymbol,
  O.flatMap(resolveFirstDeclaration),
  O.map((decl) => decl.getSourceFile().fileName),
);
