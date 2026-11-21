import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as R from "fp-ts/lib/Record.js";
import * as S from "fp-ts/lib/string.js";
import { flow, pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { getProjectSourceFiles, memoizeByProgram, memoizeByProgramAndKey } from "../utils/program-cache.js";
import { collectTsNodes, getTsNodeLocation, makeLocationKey, TsLocation } from "../utils/ts-ast-helpers.js";
import { getBarePrimitiveKind, getTsTypeName } from "../utils/type-helpers.js";

export type DiscriminantOccurrence = Readonly<
  Record<"targetKey" | "displayKey" | "literalValue", string> & {
    readonly location: TsLocation;
  }
>;

export type DiscriminantCluster = Readonly<
  Record<"targetKey", string> & {
    readonly literals: ReadonlyArray<string>;
    readonly locations: ReadonlyArray<TsLocation>;
  }
>;

const discriminantCache = new WeakMap<ts.Program, ReadonlyArray<DiscriminantOccurrence>>();

const TRIVIAL_NUMBER_LITERALS = new Set(["0", "1", "-1"]);

const isEqualityToken = (kind: ts.SyntaxKind) =>
  kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
  kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
  kind === ts.SyntaxKind.EqualsEqualsToken ||
  kind === ts.SyntaxKind.ExclamationEqualsToken;

const extractStringLiteral = (expr: ts.Expression) =>
  (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) && expr.text.length > 0
    ? O.some(`"${expr.text}"`)
    : O.none;

const extractNumberLiteral = (expr: ts.Expression) =>
  ts.isNumericLiteral(expr) && !TRIVIAL_NUMBER_LITERALS.has(expr.text)
    ? O.some(expr.text)
    : O.none;

const extractLiteralValue = (expr: ts.Expression) =>
  pipe(
    extractStringLiteral(expr),
    O.alt(() => extractNumberLiteral(expr)),
  );

const getQualifiedPropertyKey = (
  expr: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
) =>
  expr.name.text === "length" || expr.name.text === "size"
    ? O.none
    : O.some({
        targetKey: pipe(
          getTsTypeName(checker.getTypeAtLocation(expr.expression)),
          O.match(
            () => expr.name.text,
            (owner) => `${owner}.${expr.name.text}`,
          ),
        ),
        displayKey: expr.name.text,
      });

const extractIdentifierTargetKey = (expr: ts.Expression, sf: ts.SourceFile) =>
  ts.isIdentifier(expr)
    ? O.some({ targetKey: `${sf.fileName}#${expr.text}`, displayKey: expr.text })
    : O.none;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive unwrap
const unwrapParenExpr = (expr: ts.Expression): ts.Expression => ts.isParenthesizedExpression(expr) ? unwrapParenExpr(expr.expression) : expr;

const resolveNonParenTargetKey = (expr: ts.Expression, sf: ts.SourceFile, checker: ts.TypeChecker) =>
  ts.isPropertyAccessExpression(expr)
    ? getQualifiedPropertyKey(expr, checker)
    : extractIdentifierTargetKey(expr, sf);

const getTargetKeyInfo = (expr: ts.Expression, sf: ts.SourceFile, checker: ts.TypeChecker) =>
  resolveNonParenTargetKey(unwrapParenExpr(expr), sf, checker);

const isBarePrimitiveSubject = flow(
  (expr: ts.Expression, checker: ts.TypeChecker) => checker.getTypeAtLocation(expr),
  getBarePrimitiveKind,
  O.isSome,
);

const extractBinaryPair = (
  subject: ts.Expression,
  literalNode: ts.Expression,
  node: ts.Node,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  isBarePrimitiveSubject(subject, checker)
    ? pipe(
        O.Do,
        O.apS("keyInfo", getTargetKeyInfo(subject, sf, checker)),
        O.apS("literalValue", extractLiteralValue(literalNode)),
        O.map(({ keyInfo, literalValue }) => ({
          targetKey: keyInfo.targetKey,
          displayKey: keyInfo.displayKey,
          literalValue,
          location: getTsNodeLocation(node, sf),
        })),
      )
    : O.none;

const extractBinaryOccurrence = (
  node: ts.BinaryExpression,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  isEqualityToken(node.operatorToken.kind)
    ? pipe(
        extractBinaryPair(node.left, node.right, node, sf, checker),
        O.alt(() => extractBinaryPair(node.right, node.left, node, sf, checker)),
      )
    : O.none;

const extractCaseClauseOcc = (
  clause: ts.CaseOrDefaultClause,
  keyInfo: Readonly<Record<"targetKey" | "displayKey", string>>,
  sf: ts.SourceFile,
) =>
  ts.isCaseClause(clause)
    ? pipe(
        extractLiteralValue(clause.expression),
        O.map((literalValue) => ({
          targetKey: keyInfo.targetKey,
          displayKey: keyInfo.displayKey,
          literalValue,
          location: getTsNodeLocation(clause, sf),
        })),
      )
    : O.none;

const extractSwitchCaseOccurrences = (
  node: ts.SwitchStatement,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  isBarePrimitiveSubject(node.expression, checker)
    ? pipe(
        getTargetKeyInfo(node.expression, sf, checker),
        O.match(
          () => [] as ReadonlyArray<DiscriminantOccurrence>,
          (keyInfo) =>
            pipe(
              node.caseBlock.clauses,
              RA.filterMap((clause) => extractCaseClauseOcc(clause, keyInfo, sf)),
            ),
        ),
      )
    : [];

const isMatchIdentifierCall = (expr: ts.CallExpression) =>
  ts.isIdentifier(expr.expression) &&
  expr.expression.text === "match" &&
  expr.arguments.length === 1;

const unwrapMatchChainExpr = (expr: ts.CallExpression) =>
  ts.isPropertyAccessExpression(expr.expression) ? findRootMatchSubject(expr.expression.expression) : O.none;

const matchCallSubject = (expr: ts.CallExpression) =>
  isMatchIdentifierCall(expr) ? O.fromNullable(expr.arguments[0]) : unwrapMatchChainExpr(expr);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive match chain walk
const findRootMatchSubject = (expr: ts.Expression): O.Option<ts.Expression> =>
  ts.isCallExpression(expr) ? matchCallSubject(expr) : O.none;

const isWithChainCall = (node: ts.CallExpression) =>
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === "with" &&
  node.arguments.length >= 1;

const toMatchWithOccurrence = (
  arg0: ts.Expression,
  subject: ts.Expression,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  pipe(
    O.Do,
    O.filter(() => isBarePrimitiveSubject(subject, checker)),
    O.apS("keyInfo", getTargetKeyInfo(subject, sf, checker)),
    O.apS("literalValue", extractLiteralValue(arg0)),
    O.map(({ keyInfo, literalValue }) => ({
      targetKey: keyInfo.targetKey,
      displayKey: keyInfo.displayKey,
      literalValue,
      location: getTsNodeLocation(arg0, sf),
    })),
  );

const extractMatchWithOccurrence = (
  node: ts.CallExpression,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) =>
  isWithChainCall(node) && ts.isPropertyAccessExpression(node.expression)
    ? pipe(
        O.Do,
        O.apS("arg0", O.fromNullable(node.arguments[0])),
        O.apS("subject", findRootMatchSubject(node.expression.expression)),
        O.flatMap(({ arg0, subject }) => toMatchWithOccurrence(arg0, subject, sf, checker)),
      )
    : O.none;

const extractFileOccurrences = (sf: ts.SourceFile, checker: ts.TypeChecker) => {
  const nodes = collectTsNodes(sf, sf);
  return [
    ...pipe(nodes, RA.filter(ts.isBinaryExpression), RA.filterMap((n) => extractBinaryOccurrence(n, sf, checker))),
    ...pipe(nodes, RA.filter(ts.isSwitchStatement), RA.flatMap((n) => extractSwitchCaseOccurrences(n, sf, checker))),
    ...pipe(nodes, RA.filter(ts.isCallExpression), RA.filterMap((n) => extractMatchWithOccurrence(n, sf, checker))),
  ];
};

const extractWithChecker = (checker: ts.TypeChecker) => (sf: ts.SourceFile) =>
  extractFileOccurrences(sf, checker);

const collectFilesOccurrences = (checker: ts.TypeChecker) => (files: ReadonlyArray<ts.SourceFile>) =>
  pipe(files, RA.flatMap(extractWithChecker(checker)));

const extractOccurrencesForProgram = (program: ts.Program) =>
  pipe(getProjectSourceFiles(program), collectFilesOccurrences(program.getTypeChecker()));

const getProgramOccurrences = (program: ts.Program) =>
  memoizeByProgram(program, discriminantCache, extractOccurrencesForProgram);

const buildCluster = (occs: ReadonlyArray<DiscriminantOccurrence>, literals: ReadonlyArray<string>) =>
  pipe(
    O.fromNullable(occs[0]),
    O.map((first) => ({
      targetKey: first.displayKey,
      literals,
      locations: pipe(occs, RA.map((o) => o.location)),
    })),
  );

const toCluster = (occs: ReadonlyArray<DiscriminantOccurrence>, minBranches: number) => {
  const literals = pipe(occs, RA.map((o) => o.literalValue), RA.uniq(S.Eq), RA.sort(S.Ord));
  return match(literals.length >= minBranches || occs.length >= minBranches)
    .with(true, () => buildCluster(occs, literals))
    .with(false, () => O.none as O.Option<DiscriminantCluster>)
    .exhaustive();
};

const groupByTargetKey = (
  acc: Readonly<Record<string, ReadonlyArray<DiscriminantOccurrence>>>,
  occ: DiscriminantOccurrence,
) => ({
  ...acc,
  [occ.targetKey]: [...(acc[occ.targetKey] ?? []), occ],
});

const indexByLocation = (clusters: ReadonlyArray<DiscriminantCluster>) =>
  pipe(
    clusters,
    RA.reduce({}, (acc: Readonly<Record<string, DiscriminantCluster>>, cluster) =>
      pipe(
        cluster.locations,
        RA.reduce(acc, (inner, loc) => ({ ...inner, [makeLocationKey(loc)]: cluster })),
      ),
    ),
  );

type DiscriminantIndex = Readonly<{
  readonly clusters: ReadonlyArray<DiscriminantCluster>;
  readonly byLocation: Readonly<Record<string, DiscriminantCluster>>;
}>;

const discriminantIndexCache = new WeakMap<ts.Program, Readonly<Record<string, DiscriminantIndex>>>();

export const analyzeStringlyTypedDiscriminants = (
  program: ts.Program,
  minBranches = 2,
) =>
  memoizeByProgramAndKey(
    program,
    String(minBranches),
    discriminantIndexCache,
    (p) =>
      pipe(
        getProgramOccurrences(p),
        RA.reduce({}, groupByTargetKey),
        R.toEntries,
        RA.filterMap(([, occs]) => toCluster(occs, minBranches)),
        (clusters) => ({ clusters, byLocation: indexByLocation(clusters) }),
      ),
  );
