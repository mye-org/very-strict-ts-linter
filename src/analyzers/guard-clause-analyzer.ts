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

const hasFieldPropertyRead = (sf: ts.SourceFile) =>
  flow(collectTsNodes(sf), RA.some(isFieldPropertyRead));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const extractRootIdentifier = (expr: ts.Expression): O.Option<string> =>
  ts.isIdentifier(expr) ? O.some(expr.text) : resolveRootObjectName(expr);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const resolveRootObjectName = (expr: ts.Expression): O.Option<string> =>
  ts.isPropertyAccessExpression(expr) ? extractRootIdentifier(expr.expression) : O.none;

const extractFieldRootName = (node: ts.Node) =>
  isFieldPropertyRead(node) ? resolveRootObjectName(node) : O.none;

const collectRootNames = (sf: ts.SourceFile) =>
  flow(
    collectTsNodes(sf),
    RA.filterMap(extractFieldRootName),
    RA.uniq(S.Eq),
  );

const joinComma = (items: ReadonlyArray<string>) => items.join(",");

type NormalizationEnv = Readonly<{
  roots: ReadonlyArray<string>;
  sf: ts.SourceFile;
}>;

const formatCallArgList = (env: NormalizationEnv) =>
  flow(RA.map((a: ts.Expression) => normalizeExpr(env)(a)), joinComma);

const wrapBinaryText = (op: string) => (lhs: string) => (rhs: string) => `(${lhs} ${op} ${rhs})`;

const formatBinaryExpr = (env: NormalizationEnv) => (b: ts.BinaryExpression) =>
  wrapBinaryText(b.operatorToken.getText(env.sf))(normalizeExpr(env)(b.left))(
    normalizeExpr(env)(b.right),
  );

const resolveUnaryOp = flow(
  ts.tokenToString,
  O.fromNullable,
  O.getOrElse(() => "!"),
);
const prefixText = (op: string) => (operand: string) => `${op}${operand}`;

const formatPrefixExpr = (env: NormalizationEnv) => (u: ts.PrefixUnaryExpression) =>
  prefixText(resolveUnaryOp(u.operator))(normalizeExpr(env)(u.operand));

const formatCallText = (callee: string) => (args: string) => `${callee}(${args})`;

const formatCallExpr = (env: NormalizationEnv) => (c: ts.CallExpression) =>
  formatCallText(normalizeExpr(env)(c.expression))(formatCallArgList(env)(c.arguments));

const formatMemberText = (target: string) => (prop: string) => `${target}.${prop}`;

const formatMemberExpr = (env: NormalizationEnv) => (m: ts.PropertyAccessExpression) =>
  formatMemberText(normalizeExpr(env)(m.expression))(m.name.text);

const hasRootName = (roots: ReadonlyArray<string>) => (name: string) => roots.includes(name);

const isTrackedRootIdentifier =
  (roots: ReadonlyArray<string>) =>
  (node: ts.Node): node is ts.Identifier =>
    ts.isIdentifier(node) && hasRootName(roots)(node.text);

const formatRootSlot = (roots: ReadonlyArray<string>) => (name: string) =>
  `$${String(roots.indexOf(name))}`;

const collapseWhitespace = (text: string) => text.replace(WHITESPACE_RE, " ");
const truncatePreview = (text: string) => text.slice(0, 120);
const readNodeText = (sf: ts.SourceFile) => (node: ts.Node) => node.getText(sf);

const formatFallbackNode = (sf: ts.SourceFile) => flow(readNodeText(sf), collapseWhitespace);
const buildGuardPreview = (sf: ts.SourceFile) =>
  flow(readNodeText(sf), collapseWhitespace, truncatePreview);

const normalizeExpr =
  (env: NormalizationEnv) =>
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive normalization
  (node: ts.Node): string =>
    match(node)
      .when(ts.isParenthesizedExpression, (p) => normalizeExpr(env)(p.expression))
      .when(ts.isBinaryExpression, formatBinaryExpr(env))
      .when(ts.isPrefixUnaryExpression, formatPrefixExpr(env))
      .when(ts.isPropertyAccessExpression, formatMemberExpr(env))
      .when(ts.isCallExpression, formatCallExpr(env))
      .when(isTrackedRootIdentifier(env.roots), (id) => formatRootSlot(env.roots)(id.text))
      .otherwise(formatFallbackNode(env.sf));

const toGuardOccurrence = (sf: ts.SourceFile) => (node: ts.BinaryExpression) => {
  const clauseCount = countAtomicClauses(node);
  return clauseCount >= 2 && hasFieldPropertyRead(sf)(node)
    ? O.some<GuardOccurrence>({
        signature: normalizeExpr({ roots: collectRootNames(sf)(node), sf })(node),
        preview: buildGuardPreview(sf)(node),
        clauseCount,
        location: resolveTsNodeLocation(sf)(node),
      })
    : O.none;
};

const collectFileNodes = (sf: ts.SourceFile) => collectTsNodes(sf)(sf);

const collectTopLevelLogicalNodes = flow(collectFileNodes, RA.filter(isTopLevelLogicalExpr));

const extractFileGuards = (sf: ts.SourceFile) =>
  RA.filterMap(toGuardOccurrence(sf))(collectTopLevelLogicalNodes(sf));

const collectAllProgramGuards = flow(collectProjectSourceFiles, RA.flatMap(extractFileGuards));

const collectProgramGuards = memoizeByProgram(guardCache)(collectAllProgramGuards);

const groupAllBySignature = RNEA.groupBy((occ: GuardOccurrence) => occ.signature);

const extractGuardLocations = RA.map((o: GuardOccurrence) => o.location);

const toGuardCluster =
  (minOccurrences: number) =>
  ([signature, occs]: readonly [string, ReadonlyArray<GuardOccurrence>]) =>
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
    RA.filterMap(toGuardCluster(thresholds.minOccurrences)),
    buildGuardIndex,
  );

const makeGuardCacheKey = (thresholds: GuardThresholds) =>
  `${String(thresholds.minClauses)}:${String(thresholds.minOccurrences)}`;

export const analyzeGuardClauses = ((program: ts.Program) =>
  (thresholds: Partial<GuardThresholds> = {}) => {
    const resolved: GuardThresholds = { ...DEFAULT_GUARD_THRESHOLDS, ...thresholds };
    return memoizeByProgramAndKey(guardIndexCache)(
      computeGuardIndexForThresholds(resolved),
    )(program)(makeGuardCacheKey(resolved));
  }) satisfies (
  program: ts.Program,
) => (thresholds?: Partial<GuardThresholds>) => GuardIndex;
