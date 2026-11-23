import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { normalizeFilePath } from "./program-cache.js";

export type TsLocation = Readonly<Record<"file", string> & Record<"line", number>>;

const sfNodesCache = new WeakMap<ts.SourceFile, ReadonlyArray<ts.Node>>();

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const walkTsNodes = (root: ts.Node, sf: ts.SourceFile): ReadonlyArray<ts.Node> => [
  root,
  ...pipe(
    root.getChildren(sf),
    RA.flatMap((child) => walkTsNodes(child, sf)),
  ),
];

const computeAndCacheSfNodes = (sf: ts.SourceFile) => {
  const nodes = walkTsNodes(sf, sf);
  sfNodesCache.set(sf, nodes);
  return nodes;
};

export const collectTsNodes = (root: ts.Node, sf: ts.SourceFile) =>
  root === sf
    ? pipe(
        O.fromNullable(sfNodesCache.get(sf)),
        O.getOrElse(() => computeAndCacheSfNodes(sf)),
      )
    : walkTsNodes(root, sf);

export const getTsNodeLocation = (node: ts.Node, sf: ts.SourceFile) => ({
  file: normalizeFilePath(sf.fileName),
  line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
});

export const getTsNodeOwnLocation = (node: ts.Node) =>
  pipe(node.getSourceFile(), (sf) => getTsNodeLocation(node, sf));

export const getTsPropertyNameText = (name: ts.PropertyName) =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? O.some(name.text)
    : O.none;

export const getTsParameterNameText = (param: ts.ParameterDeclaration) =>
  ts.isIdentifier(param.name) ? O.some(param.name.text) : O.none;

export const getTsTypeMemberName = (member: ts.TypeElement | ts.ClassElement) =>
  ts.isPropertySignature(member) ||
  ts.isPropertyDeclaration(member) ||
  ts.isMethodSignature(member) ||
  ts.isMethodDeclaration(member)
    ? getTsPropertyNameText(member.name)
    : O.none;

export const isTsEntityProperty = (member: ts.TypeElement | ts.ClassElement) =>
  ts.isPropertySignature(member) || ts.isPropertyDeclaration(member);

export const makeLocationKey = (loc: TsLocation) => `${loc.file}:${String(loc.line)}`;

export type NamedTsFunction = Readonly<
  Record<"name", string> & {
    readonly locNode: ts.Node;
    readonly paramNodes: ts.NodeArray<ts.ParameterDeclaration>;
    readonly fnBody: ts.Node;
  }
>;

const extractFunctionDeclInfo = (fn: ts.FunctionDeclaration) =>
  pipe(
    O.Do,
    O.apS("id", O.fromNullable(fn.name)),
    O.apS("fnBody", O.fromNullable(fn.body)),
    O.map(({ id, fnBody }) => ({
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

const getFunctionLikeInit = (decl: ts.VariableDeclaration) =>
  pipe(O.fromNullable(decl.initializer), O.filter(isFunctionLikeInit));

const extractVarDeclFnInfo = (decl: ts.VariableDeclaration) =>
  pipe(
    O.Do,
    O.apS("id", O.fromPredicate(ts.isIdentifier)(decl.name)),
    O.apS("fn", getFunctionLikeInit(decl)),
    O.map(({ id, fn }) => ({
      name: id.text,
      locNode: decl,
      paramNodes: fn.parameters,
      fnBody: fn.body,
    })),
  );

const tryExtractVarDeclFn = (node: ts.Node) =>
  pipe(O.fromPredicate(ts.isVariableDeclaration)(node), O.flatMap(extractVarDeclFnInfo));

export const extractNamedTsFunction = (node: ts.Node) =>
  pipe(
    O.fromPredicate(ts.isFunctionDeclaration)(node),
    O.flatMap(extractFunctionDeclInfo),
    O.altW(() => tryExtractVarDeclFn(node)),
  );
