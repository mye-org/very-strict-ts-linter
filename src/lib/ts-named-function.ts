import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

export type NamedTsFunction = Readonly<
  Record<"name", string> & {
    readonly locNode: ts.Node;
    readonly paramNodes: ts.NodeArray<ts.ParameterDeclaration>;
    readonly fnBody: ts.Node;
  }
>;

const extractFunctionDeclSignature = (fn: ts.FunctionDeclaration) =>
  flow(
    () => O.Do,
    O.apS("id", O.fromNullable(fn.name)),
    O.apS("fnBody", O.fromNullable(fn.body)),
    O.map(({ id, fnBody }) => ({
      name: id.text,
      locNode: fn,
      paramNodes: fn.parameters,
      fnBody,
    })),
  )();

const isFunctionLikeInit = (
  expr: ts.Expression,
): expr is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(expr) || ts.isFunctionExpression(expr);

const resolveFunctionLikeInit = flow(
  (decl: ts.VariableDeclaration) => decl.initializer,
  O.fromNullable,
  O.filter(isFunctionLikeInit),
);

const extractVarDeclFnSignature = (decl: ts.VariableDeclaration) =>
  flow(
    () => O.Do,
    O.apS("id", O.fromPredicate(ts.isIdentifier)(decl.name)),
    O.apS("fn", resolveFunctionLikeInit(decl)),
    O.map(({ id, fn }) => ({
      name: id.text,
      locNode: decl,
      paramNodes: fn.parameters,
      fnBody: fn.body,
    })),
  )();

const tryExtractVarDeclFn = flow(
  O.fromPredicate(ts.isVariableDeclaration),
  O.flatMap(extractVarDeclFnSignature),
);

export const extractNamedTsFunction = (node: ts.Node) =>
  flow(
    O.fromPredicate(ts.isFunctionDeclaration),
    O.flatMap(extractFunctionDeclSignature),
    O.altW(() => tryExtractVarDeclFn(node)),
  )(node);
