import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as R from "fp-ts/lib/Record.js";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { getProjectSourceFiles, memoizeByProgram, memoizeByProgramAndKey } from "../utils/program-cache.js";
import { collectTsNodes, getTsNodeLocation, makeLocationKey, TsLocation } from "../utils/ts-ast-helpers.js";

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
  pipe(collectTsNodes(expr, sf), RA.some(isFieldPropertyRead));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const extractRootIdentifier = (expr: ts.Expression): O.Option<string> =>
  ts.isIdentifier(expr) ? O.some(expr.text) : getRootObjectName(expr);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const getRootObjectName = (expr: ts.Expression): O.Option<string> =>
  ts.isPropertyAccessExpression(expr) ? extractRootIdentifier(expr.expression) : O.none;

const collectRootNames = (expr: ts.Expression, sf: ts.SourceFile) =>
  pipe(
    collectTsNodes(expr, sf),
    RA.filter(isFieldPropertyRead),
    RA.filterMap(getRootObjectName),
    RA.reduce([] as ReadonlyArray<string>, (acc, name) =>
      acc.includes(name) ? acc : [...acc, name],
    ),
  );

const formatCallArgList = (
  args: ReadonlyArray<ts.Expression>,
  roots: ReadonlyArray<string>,
  sf: ts.SourceFile,
) => pipe(args, RA.map((a) => normalizeExpr(a, roots, sf))).join(",");

const formatBinaryExpr = (b: ts.BinaryExpression, roots: ReadonlyArray<string>, sf: ts.SourceFile) =>
  `(${normalizeExpr(b.left, roots, sf)} ${b.operatorToken.getText(sf)} ${normalizeExpr(b.right, roots, sf)})`;

const formatPrefixExpr = (u: ts.PrefixUnaryExpression, roots: ReadonlyArray<string>, sf: ts.SourceFile) =>
  `${ts.tokenToString(u.operator) ?? "!"}${normalizeExpr(u.operand, roots, sf)}`;

const formatCallExpr = (c: ts.CallExpression, roots: ReadonlyArray<string>, sf: ts.SourceFile) =>
  `${normalizeExpr(c.expression, roots, sf)}(${formatCallArgList(c.arguments, roots, sf)})`;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive normalization
const normalizeExpr = (node: ts.Node, roots: ReadonlyArray<string>, sf: ts.SourceFile): string =>
  match(node)
    .when(ts.isParenthesizedExpression, (p) => normalizeExpr(p.expression, roots, sf))
    .when(ts.isBinaryExpression, (b) => formatBinaryExpr(b, roots, sf))
    .when(ts.isPrefixUnaryExpression, (u) => formatPrefixExpr(u, roots, sf))
    .when(ts.isPropertyAccessExpression, (m) => `${normalizeExpr(m.expression, roots, sf)}.${m.name.text}`)
    .when(ts.isCallExpression, (c) => formatCallExpr(c, roots, sf))
    .when(
      (n): n is ts.Identifier => ts.isIdentifier(n) && roots.includes(n.text),
      (id) => `$${String(roots.indexOf(id.text))}`,
    )
    .otherwise((n) => n.getText(sf).replace(WHITESPACE_RE, " "));

const toGuardOccurrence = (node: ts.BinaryExpression, sf: ts.SourceFile) => {
  const clauseCount = countAtomicClauses(node);
  return clauseCount >= 2 && hasFieldPropertyRead(node, sf)
    ? O.some<GuardOccurrence>({
        signature: normalizeExpr(node, collectRootNames(node, sf), sf),
        preview: node.getText(sf).replace(WHITESPACE_RE, " ").slice(0, 120),
        clauseCount,
        location: getTsNodeLocation(node, sf),
      })
    : O.none;
};

const extractFileGuards = (sf: ts.SourceFile) =>
  pipe(
    collectTsNodes(sf, sf),
    RA.filter(isTopLevelLogicalExpr),
    RA.filterMap((node) => toGuardOccurrence(node, sf)),
  );

const getProgramGuards = (program: ts.Program) =>
  memoizeByProgram(program, guardCache, (p) =>
    pipe(getProjectSourceFiles(p), RA.flatMap(extractFileGuards)),
  );

const groupBySignature = (
  acc: Readonly<Record<string, ReadonlyArray<GuardOccurrence>>>,
  occ: GuardOccurrence,
) => ({
  ...acc,
  [occ.signature]: [...(acc[occ.signature] ?? []), occ],
});

const extractGuardLocations = (occs: ReadonlyArray<GuardOccurrence>) =>
  pipe(occs, RA.map((o) => o.location));

const toGuardCluster = (
  [signature, occs]: readonly [string, ReadonlyArray<GuardOccurrence>],
  minOccurrences: number,
) =>
  occs.length >= minOccurrences
    ? pipe(
        O.fromNullable(occs[0]),
        O.map((first) => ({
          signature,
          preview: first.preview,
          locations: extractGuardLocations(occs),
        })),
      )
    : (O.none as O.Option<GuardCluster>);

const addClusterByLocation = (
  acc: Readonly<Record<string, ReadonlyArray<GuardCluster>>>,
  cluster: GuardCluster,
) =>
  pipe(
    cluster.locations,
    RA.reduce(acc, (inner, loc) => {
      const key = makeLocationKey(loc);
      return { ...inner, [key]: [...(inner[key] ?? []), cluster] };
    }),
  );

type GuardIndex = Readonly<{
  readonly clusters: ReadonlyArray<GuardCluster>;
  readonly byLocation: Readonly<Record<string, ReadonlyArray<GuardCluster>>>;
}>;

const guardIndexCache = new WeakMap<ts.Program, Readonly<Record<string, GuardIndex>>>();

const indexClustersByLocation = (clusters: ReadonlyArray<GuardCluster>) =>
  pipe(clusters, RA.reduce({}, addClusterByLocation));

const computeGuardIndex = (program: ts.Program, minClauses: number, minOccurrences: number) =>
  pipe(
    getProgramGuards(program),
    RA.filter((occ) => occ.clauseCount >= minClauses),
    RA.reduce({}, groupBySignature),
    R.toEntries,
    RA.filterMap((entry) => toGuardCluster(entry, minOccurrences)),
    (clusters) => ({
      clusters,
      byLocation: indexClustersByLocation(clusters),
    }),
  );

export const analyzeGuardClauses = (
  program: ts.Program,
  minClauses = 2,
  minOccurrences = 2,
) =>
  memoizeByProgramAndKey(
    program,
    `${String(minClauses)}:${String(minOccurrences)}`,
    guardIndexCache,
    (p) => computeGuardIndex(p, minClauses, minOccurrences),
  );
