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
