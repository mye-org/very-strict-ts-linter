import { TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { flow } from "fp-ts/lib/function.js";

const isEstreeNodeObj = (val: object): val is TSESTree.Node =>
  Boolean(val) && "type" in val;

const extractSingleNode = flow(
  O.fromPredicate(isEstreeNodeObj),
  O.match(
    () => [] satisfies ReadonlyArray<TSESTree.Node>,
    (childNode) => [childNode],
  ),
);

const isObjectArray = (val: object): val is ReadonlyArray<object> => Array.isArray(val);

const extractNodeArray = RA.filter(isEstreeNodeObj);

const extractChildValue = (val: object) =>
  isObjectArray(val) ? extractNodeArray(val) : extractSingleNode(val);

const isNodeRecord = (node: TSESTree.Node): node is TSESTree.Node & Readonly<Record<string, object>> =>
  typeof node === "object";

const lookupKeyChildren = (key: string) =>
  flow(
    (record: Readonly<Record<string, object>>) => RR.lookup(key, record),
    O.flatMap(O.fromNullable),
    O.match(() => [] satisfies ReadonlyArray<TSESTree.Node>, extractChildValue),
  );

const extractKeyChildren = (node: TSESTree.Node, key: string) =>
  isNodeRecord(node)
    ? lookupKeyChildren(key)(node)
    : ([] satisfies ReadonlyArray<TSESTree.Node>);

export const collectEstreeChildNodes = ((
  node: TSESTree.Node,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) =>
  RA.flatMap((key: string) => extractKeyChildren(node, key))(
    visitorKeys[node.type] ?? [],
  )) satisfies (
  node: TSESTree.Node,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) => ReadonlyArray<TSESTree.Node>;
