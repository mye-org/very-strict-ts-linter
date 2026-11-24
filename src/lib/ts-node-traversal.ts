import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

const sourceFileNodesCache = new WeakMap<ts.SourceFile, ReadonlyArray<ts.Node>>();

const isVisitableNode = (node: ts.Node) => node.kind !== ts.SyntaxKind.JSDoc;

const walkTsNodes =
  (isIncluded: (node: ts.Node) => boolean) =>
  (root: ts.Node) => {
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
  const nodes = walkTsNodes(isVisitableNode)(sf);
  sourceFileNodesCache.set(sf, nodes);
  return nodes;
};

const resolveSourceFileNodes = (sf: ts.SourceFile) =>
  flow(
    (file: ts.SourceFile) => sourceFileNodesCache.get(file),
    O.fromNullable,
    O.getOrElse<ReadonlyArray<ts.Node>>(() => computeSourceFileNodes(sf)),
  );

export const collectTsNodesUntil = flow(
  Pred.not<ts.Node>,
  Pred.and(isVisitableNode),
  walkTsNodes,
) satisfies (
  isStopNode: (node: ts.Node) => boolean,
) => (root: ts.Node) => ReadonlyArray<ts.Node>;

export const collectTsNodes = ((sf: ts.SourceFile) => (root: ts.Node) =>
  root === sf ? resolveSourceFileNodes(sf)(sf) : walkTsNodes(isVisitableNode)(root)) satisfies (
  sf: ts.SourceFile,
) => (root: ts.Node) => ReadonlyArray<ts.Node>;
