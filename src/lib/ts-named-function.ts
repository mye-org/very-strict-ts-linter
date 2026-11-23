import * as Apply from "fp-ts/lib/Apply.js";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

export type NamedTsFunction = Readonly<
  Record<"name", string> & {
    readonly locNode: ts.Node;
    readonly paramNodes: ts.NodeArray<ts.ParameterDeclaration>;
    readonly fnBody: ts.Node;
  }
>;

const extractFunctionDeclSignature = flow(
  (fn: ts.FunctionDeclaration) => ({
    fn: O.some(fn),
    id: O.fromNullable(fn.name),
    fnBody: O.fromNullable(fn.body),
  }),
  Apply.sequenceS(O.Apply),
  O.map(({ fn, id, fnBody }) => ({
    name: id.text,
    locNode: fn,
    paramNodes: fn.parameters,
    fnBody,
  })),
);

const isFunctionLikeInit = (
  expr: ts.Expression,
): expr is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(expr) || ts.isFunctionExpression(expr);

const resolveFunctionLikeInit = flow(
  (decl: ts.VariableDeclaration) => decl.initializer,
  O.fromNullable,
  O.filter(isFunctionLikeInit),
);

const extractVarDeclFnSignature = flow(
  (decl: ts.VariableDeclaration) => ({
    decl: O.some(decl),
    id: O.fromPredicate(ts.isIdentifier)(decl.name),
    fn: resolveFunctionLikeInit(decl),
  }),
  Apply.sequenceS(O.Apply),
  O.map(({ decl, id, fn }) => ({
    name: id.text,
    locNode: decl,
    paramNodes: fn.parameters,
    fnBody: fn.body,
  })),
);

const tryExtractFuncDecl = flow(
  O.fromPredicate(ts.isFunctionDeclaration),
  O.flatMap(extractFunctionDeclSignature),
);

const tryExtractVarDeclFn = flow(
  O.fromPredicate(ts.isVariableDeclaration),
  O.flatMap(extractVarDeclFnSignature),
);

const namedFunctionExtractors = [tryExtractFuncDecl, tryExtractVarDeclFn] as const;

export const extractNamedTsFunction = (node: ts.Node): O.Option<NamedTsFunction> =>
  RA.findFirstMap((extract: (n: ts.Node) => O.Option<NamedTsFunction>) => extract(node))(
    namedFunctionExtractors,
  );
