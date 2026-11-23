import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

const isVisitableChild = (node: ts.Node) => node.kind !== ts.SyntaxKind.JSDoc;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for mutually recursive AST walk
const collectExpandedChildNodes = (node: ts.Node, sf: ts.SourceFile): ReadonlyArray<ts.Node> =>
  node.kind === ts.SyntaxKind.SyntaxList
    ? collectChildDescendants(node, sf)
    : [node, ...collectChildDescendants(node, sf)];

const filterAndExpandChildren = (sf: ts.SourceFile) =>
  flow(
    RA.filter(isVisitableChild),
    RA.flatMap((child: ts.Node) => collectExpandedChildNodes(child, sf)),
  );

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for mutually recursive AST walk
const collectChildDescendants = (node: ts.Node, sf: ts.SourceFile): ReadonlyArray<ts.Node> =>
  filterAndExpandChildren(sf)(node.getChildren(sf));

export const collectTsNodes = (root: ts.Node, sf: ts.SourceFile): ReadonlyArray<ts.Node> => [
  root,
  ...collectChildDescendants(root, sf),
];
