import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import * as S from "fp-ts/lib/string.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { memoizeByProgram, memoizeByProgramAndKey } from "../lib/program-memo.js";
import { collectProjectSourceFiles } from "../lib/source-paths.js";
import { TsLocation, makeLocationKey, resolveTsNodeLocation } from "../lib/ts-node-location.js";
import { collectTsNodes } from "../lib/ts-node-traversal.js";

export type GuardOccurrence = Readonly<
  Record<"signature" | "preview", string> &
    Record<"clauseCount", number> & {
      readonly location: TsLocation;
    }
>;

export type GuardCluster = Readonly<
  Record<"signature" | "preview", string> & {
    readonly locations: ReadonlyArray<TsLocation>;
  }
>;

const guardCache = new WeakMap<ts.Program, ReadonlyArray<GuardOccurrence>>();
const WHITESPACE_RE = /\s+/g;

const isLogicalBinary = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) &&
  (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    node.operatorToken.kind === ts.SyntaxKind.BarBarToken);

const isTopLevelLogicalExpr = (node: ts.Node): node is ts.BinaryExpression =>
  isLogicalBinary(node) && !isLogicalBinary(node.parent);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST count
const countAtomicClauses = (expr: ts.Expression): number =>
  isLogicalBinary(expr)
    ? countAtomicClauses(expr.left) + countAtomicClauses(expr.right)
    : 1;

const isFieldPropertyRead = (node: ts.Node): node is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(node) &&
  !(ts.isCallExpression(node.parent) && node.parent.expression === node);

const hasFieldPropertyRead = (expr: ts.Expression, sf: ts.SourceFile) =>
  RA.some(isFieldPropertyRead)(collectTsNodes(expr, sf));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const extractRootIdentifier = (expr: ts.Expression): O.Option<string> =>
  ts.isIdentifier(expr) ? O.some(expr.text) : resolveRootObjectName(expr);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const resolveRootObjectName = (expr: ts.Expression): O.Option<string> =>
  ts.isPropertyAccessExpression(expr) ? extractRootIdentifier(expr.expression) : O.none;

const extractFieldRootName = (node: ts.Node) =>
  isFieldPropertyRead(node) ? resolveRootObjectName(node) : O.none;

const collectRootNames = flow(
  collectTsNodes,
  RA.filterMap(extractFieldRootName),
  RA.uniq(S.Eq),
);

const joinComma = (items: ReadonlyArray<string>) => items.join(",");

type NormalizationEnv = Readonly<{
  roots: ReadonlyArray<string>;
  sf: ts.SourceFile;
}>;

const formatCallArgList = (args: ReadonlyArray<ts.Expression>, env: NormalizationEnv) =>
  joinComma(RA.map((a: ts.Expression) => normalizeExpr(a, env))(args));

const wrapBinaryText = (op: string) => (lhs: string, rhs: string) => `(${lhs} ${op} ${rhs})`;

const formatBinaryExpr = (b: ts.BinaryExpression, env: NormalizationEnv) =>
  wrapBinaryText(b.operatorToken.getText(env.sf))(
    normalizeExpr(b.left, env),
    normalizeExpr(b.right, env),
  );

const resolveUnaryOp = (op: ts.PrefixUnaryOperator) => ts.tokenToString(op) ?? "!";
const prefixText = (op: string, operand: string) => `${op}${operand}`;

const formatPrefixExpr = (u: ts.PrefixUnaryExpression, env: NormalizationEnv) =>
  prefixText(resolveUnaryOp(u.operator), normalizeExpr(u.operand, env));

const formatCallText = (callee: string, args: string) => `${callee}(${args})`;

const formatCallExpr = (c: ts.CallExpression, env: NormalizationEnv) =>
  formatCallText(normalizeExpr(c.expression, env), formatCallArgList(c.arguments, env));

const formatMemberText = (target: string, prop: string) => `${target}.${prop}`;

const formatMemberExpr = (m: ts.PropertyAccessExpression, env: NormalizationEnv) =>
  formatMemberText(normalizeExpr(m.expression, env), m.name.text);

const hasRootName = (roots: ReadonlyArray<string>, name: string) => roots.includes(name);

const isTrackedRootIdentifier = (
  node: ts.Node,
  roots: ReadonlyArray<string>,
): node is ts.Identifier => ts.isIdentifier(node) && hasRootName(roots, node.text);

const formatRootSlot = (roots: ReadonlyArray<string>, name: string) =>
  `$${String(roots.indexOf(name))}`;

const collapseWhitespace = (text: string) => text.replace(WHITESPACE_RE, " ");
const truncatePreview = (text: string) => text.slice(0, 120);
const readNodeText = (node: ts.Node, sf: ts.SourceFile) => node.getText(sf);

const formatFallbackNode = flow(readNodeText, collapseWhitespace);
const buildGuardPreview = flow(readNodeText, collapseWhitespace, truncatePreview);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive normalization
const normalizeExpr = (node: ts.Node, env: NormalizationEnv): string =>
  match(node)
    .when(ts.isParenthesizedExpression, (p) => normalizeExpr(p.expression, env))
    .when(ts.isBinaryExpression, (b) => formatBinaryExpr(b, env))
    .when(ts.isPrefixUnaryExpression, (u) => formatPrefixExpr(u, env))
    .when(ts.isPropertyAccessExpression, (m) => formatMemberExpr(m, env))
    .when(ts.isCallExpression, (c) => formatCallExpr(c, env))
    .when(
      (n): n is ts.Identifier => isTrackedRootIdentifier(n, env.roots),
      (id) => formatRootSlot(env.roots, id.text),
    )
    .otherwise((n) => formatFallbackNode(n, env.sf));

const toGuardOccurrence = (node: ts.BinaryExpression, sf: ts.SourceFile) => {
  const clauseCount = countAtomicClauses(node);
  return clauseCount >= 2 && hasFieldPropertyRead(node, sf)
    ? O.some<GuardOccurrence>({
        signature: normalizeExpr(node, { roots: collectRootNames(node, sf), sf }),
        preview: buildGuardPreview(node, sf),
        clauseCount,
        location: resolveTsNodeLocation(node, sf),
      })
    : O.none;
};

const collectFileNodes = (sf: ts.SourceFile) => collectTsNodes(sf, sf);

const collectTopLevelLogicalNodes = flow(collectFileNodes, RA.filter(isTopLevelLogicalExpr));

const extractFileGuards = flow(
  (sf: ts.SourceFile) => ({ sf, nodes: collectTopLevelLogicalNodes(sf) }),
  ({ sf, nodes }) => RA.filterMap((node: ts.BinaryExpression) => toGuardOccurrence(node, sf))(nodes),
);

const collectAllProgramGuards = flow(collectProjectSourceFiles, RA.flatMap(extractFileGuards));

const collectProgramGuards = memoizeByProgram(guardCache, collectAllProgramGuards);

const groupAllBySignature = RNEA.groupBy((occ: GuardOccurrence) => occ.signature);

const extractGuardLocations = RA.map((o: GuardOccurrence) => o.location);

const toGuardCluster = (
  [signature, occs]: readonly [string, ReadonlyArray<GuardOccurrence>],
  minOccurrences: number,
) =>
  occs.length >= minOccurrences
    ? O.map((first: GuardOccurrence) => ({
        signature,
        preview: first.preview,
        locations: extractGuardLocations(occs),
      }))(O.fromNullable(occs[0]))
    : (O.none satisfies O.Option<GuardCluster>);

type GuardIndex = Readonly<{
  readonly clusters: ReadonlyArray<GuardCluster>;
  readonly byLocation: Readonly<Record<string, ReadonlyArray<GuardCluster>>>;
}>;

export type GuardThresholds = Readonly<Record<"minClauses" | "minOccurrences", number>>;

const DEFAULT_GUARD_THRESHOLDS: GuardThresholds = {
  minClauses: 2,
  minOccurrences: 2,
};

const guardIndexCache = new WeakMap<ts.Program, Readonly<Record<string, GuardIndex>>>();

const expandClusterLocations = (cluster: GuardCluster) =>
  RA.map((loc: TsLocation) => [makeLocationKey(loc), cluster] as const)(cluster.locations);

const extractClusterFromPair = ([, cluster]: readonly [string, GuardCluster]) => cluster;

const indexClustersByLocation = flow(
  RA.flatMap(expandClusterLocations),
  RNEA.groupBy(([locKey]) => locKey),
  RR.map(RA.map(extractClusterFromPair)),
);

const buildGuardIndex = (clusters: ReadonlyArray<GuardCluster>) => ({
  clusters,
  byLocation: indexClustersByLocation(clusters),
});

const computeGuardIndexForThresholds = (thresholds: GuardThresholds) =>
  flow(
    collectProgramGuards,
    RA.filter((occ: GuardOccurrence) => occ.clauseCount >= thresholds.minClauses),
    groupAllBySignature,
    (rec: Readonly<Record<string, ReadonlyArray<GuardOccurrence>>>) => RR.toEntries(rec),
    RA.filterMap((entry) => toGuardCluster(entry, thresholds.minOccurrences)),
    buildGuardIndex,
  );

const makeGuardCacheKey = (thresholds: GuardThresholds) =>
  `${String(thresholds.minClauses)}:${String(thresholds.minOccurrences)}`;

export const analyzeGuardClauses = ((
  program: ts.Program,
  thresholds: Partial<GuardThresholds> = {},
) => {
  const resolved: GuardThresholds = { ...DEFAULT_GUARD_THRESHOLDS, ...thresholds };
  return memoizeByProgramAndKey(
    guardIndexCache,
    computeGuardIndexForThresholds(resolved),
  )(program, makeGuardCacheKey(resolved));
}) satisfies (program: ts.Program, thresholds?: Partial<GuardThresholds>) => GuardIndex;
