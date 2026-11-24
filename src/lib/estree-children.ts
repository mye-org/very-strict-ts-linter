import { TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { flow } from "fp-ts/lib/function.js";

const isEstreeNodeObj = (val: object): val is TSESTree.Node =>
  Boolean(val) && "type" in val;

const isNodeRecord = (
  node: TSESTree.Node,
): node is TSESTree.Node & Readonly<Record<string, object>> =>
  typeof node === "object";

const isArrayVal = (val: object): val is ReadonlyArray<object> => Array.isArray(val);

const extractArrayVal = RA.filter(isEstreeNodeObj);

const extractSingleVal = (val: object) =>
  isEstreeNodeObj(val) ? [val] : ([] satisfies ReadonlyArray<TSESTree.Node>);

const extractValNodes = (val: object) =>
  isArrayVal(val) ? extractArrayVal(val) : extractSingleVal(val);

const extractKeyNodes = (node: TSESTree.Node & Readonly<Record<string, object>>) =>
  flow(
    (k: string) => RR.lookup(k, node),
    O.flatMap(O.fromNullable),
    O.match(() => [] satisfies ReadonlyArray<TSESTree.Node>, extractValNodes),
  );

export const collectEstreeChildNodes = ((
  node: TSESTree.Node,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) => {
  const keys = visitorKeys[node.type];
  return !keys || !isNodeRecord(node)
    ? []
    : RA.flatMap(extractKeyNodes(node))(keys);
}) satisfies (
  node: TSESTree.Node,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) => ReadonlyArray<TSESTree.Node>;
