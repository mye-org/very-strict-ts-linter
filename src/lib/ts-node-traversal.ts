import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

const sourceFileNodesCache = new WeakMap<ts.SourceFile, ReadonlyArray<ts.Node>>();

const isVisitableNode = (node: ts.Node) => node.kind !== ts.SyntaxKind.JSDoc;

const walkTsNodes = (
  root: ts.Node,
  isIncluded: (node: ts.Node) => boolean,
) => {
  // eslint-disable-next-line strict-fp/prefer-readonly-collections -- local accumulator for O(n) single-pass AST collection
  const nodes: ts.Node[] = [];
  const recordAndDescend = (node: ts.Node) => {
    // eslint-disable-next-line strict-fp/no-mutation, strict-fp/prefer-fp-ts-array-methods -- O(n) single-pass AST collection
    nodes.push(node);
    ts.forEachChild(node, visit);
    return 0;
  };
  const visit = (node: ts.Node) =>
    isIncluded(node) ? recordAndDescend(node) : 0;
  visit(root);
  return nodes;
};

const computeSourceFileNodes = (sf: ts.SourceFile) => {
  const nodes = walkTsNodes(sf, isVisitableNode);
  sourceFileNodesCache.set(sf, nodes);
  return nodes;
};

const resolveSourceFileNodes = (sf: ts.SourceFile) =>
  flow(
    (file: ts.SourceFile) => sourceFileNodesCache.get(file),
    O.fromNullable,
    O.getOrElse<ReadonlyArray<ts.Node>>(() => computeSourceFileNodes(sf)),
  );

export const collectTsNodesUntil = ((
  root: ts.Node,
  isStopNode: (node: ts.Node) => boolean,
) =>
  walkTsNodes(root, (node) => isVisitableNode(node) && !isStopNode(node))) satisfies (
  root: ts.Node,
  isStopNode: (node: ts.Node) => boolean,
) => ReadonlyArray<ts.Node>;

export const collectTsNodes = ((root: ts.Node, sf: ts.SourceFile) =>
  root === sf ? resolveSourceFileNodes(sf)(sf) : walkTsNodes(root, isVisitableNode)) satisfies (
  root: ts.Node,
  sf: ts.SourceFile,
) => ReadonlyArray<ts.Node>;
