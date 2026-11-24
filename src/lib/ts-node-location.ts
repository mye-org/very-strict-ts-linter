import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { normalizeFilePath } from "./source-paths.js";

export type TsLocation = Readonly<Record<"file", string> & Record<"line", number>>;

const asTsLocation = (loc: TsLocation) => loc;

export const resolveTsNodeLocation = ((node: ts.Node, sf: ts.SourceFile) =>
  asTsLocation({
    file: normalizeFilePath(sf.fileName),
    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
  })) satisfies (node: ts.Node, sf: ts.SourceFile) => TsLocation;

export const resolveTsNodeOwnLocation: (node: ts.Node) => TsLocation = flow(
  (node: ts.Node) => [node, node.getSourceFile()] as const,
  ([node, sf]) => resolveTsNodeLocation(node, sf),
);

const formatLocation = (loc: TsLocation) => `${loc.file}:${String(loc.line)}`;

export const makeLocationKey = flow(asTsLocation, formatLocation);
