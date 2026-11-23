import { TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";

const isEstreeNodeObj = (val: object): val is TSESTree.Node =>
  Boolean(val) && "type" in val;

const extractSingleNode = flow(
  O.fromPredicate(isEstreeNodeObj),
  O.match(
    () => [] as ReadonlyArray<TSESTree.Node>,
    (childNode) => [childNode],
  ),
);

const isObjectArray = (val: object): val is ReadonlyArray<object> => Array.isArray(val);

const extractNodeArray = RA.filter(isEstreeNodeObj);

const extractChildValue = (val: object) =>
  isObjectArray(val) ? extractNodeArray(val) : extractSingleNode(val);

const readNodeProperty = (node: TSESTree.Node, key: string) =>
  (node as object as Readonly<Record<string, object>>)[key];

const extractKeyChildren = (node: TSESTree.Node, key: string) =>
  flow(
    (k: string) => readNodeProperty(node, k),
    O.fromNullable,
    O.match(() => [] as ReadonlyArray<TSESTree.Node>, extractChildValue),
  )(key);

export const collectEstreeChildNodes = (
  node: TSESTree.Node,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) =>
  RA.flatMap((key: string) => extractKeyChildren(node, key))(
    visitorKeys[node.type] ?? [],
  );
