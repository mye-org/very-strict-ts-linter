import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import * as S from "fp-ts/lib/string.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { collectProjectSourceFiles } from "../lib/source-paths.js";
import { memoizeByProgram, memoizeByProgramAndKey } from "../lib/program-memo.js";
import { collectTsNodes } from "../lib/ts-node-traversal.js";
import { makeLocationKey, resolveTsNodeLocation, TsLocation } from "../lib/ts-node-location.js";
import { isBrandedOrNewtypeTsType } from "../lib/ts-primitive-types.js";
import { resolveTsTypeName } from "../lib/ts-type-name.js";

const classifyBarePrimitiveKind = (type: ts.Type) =>
  match({
    branded: isBrandedOrNewtypeTsType(type),
    isString: (type.flags & ts.TypeFlags.String) !== 0,
    isNumber: (type.flags & ts.TypeFlags.Number) !== 0,
  })
    .with({ branded: false, isString: true }, () => O.some("string" as const))
    .with({ branded: false, isNumber: true }, () => O.some("number" as const))
    .otherwise(() => O.none satisfies O.Option<"string" | "number">);

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

type TargetDescriptor = Readonly<Record<"targetKey" | "displayKey", string>>;

type SubjectLiteralSite = Readonly<{
  readonly subject: ts.Expression;
  readonly literalNode: ts.Expression;
  readonly locNode: ts.Node;
  readonly sf: ts.SourceFile;
  readonly checker: ts.TypeChecker;
}>;

const discriminantCache = new WeakMap<ts.Program, ReadonlyArray<DiscriminantOccurrence>>();

const TRIVIAL_NUMBER_LITERALS: ReadonlySet<string> = new Set(["0", "1", "-1"]);
const IGNORED_PROP_NAMES: ReadonlySet<string> = new Set(["length", "size"]);
const MATCH_CALL_NAMES: ReadonlySet<string> = new Set(["match"]);
const WITH_METHOD_NAMES: ReadonlySet<string> = new Set(["with"]);

const isEqualityToken = (kind: ts.SyntaxKind) =>
  kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
  kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
  kind === ts.SyntaxKind.EqualsEqualsToken ||
  kind === ts.SyntaxKind.ExclamationEqualsToken;

const quoteStringLiteral = (text: string) => `"${text}"`;

const extractStringLiteral = (expr: ts.Expression) =>
  (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) && expr.text.length > 0
    ? O.some(quoteStringLiteral(expr.text))
    : O.none;

const extractNumberLiteral = (expr: ts.Expression) =>
  ts.isNumericLiteral(expr) && !TRIVIAL_NUMBER_LITERALS.has(expr.text)
    ? O.some(expr.text)
    : O.none;

const extractLiteralValue = (expr: ts.Expression) =>
  O.alt(() => extractNumberLiteral(expr))(extractStringLiteral(expr));

const formatQualifiedPropertyKey = (propName: string) =>
  O.match(
    () => propName,
    (owner: string) => `${owner}.${propName}`,
  );

const resolveExprTypeName = (checker: ts.TypeChecker) =>
  flow((expr: ts.Expression) => checker.getTypeAtLocation(expr), resolveTsTypeName);

const resolveQualifiedPropertyKey =
  (checker: ts.TypeChecker) => (expr: ts.PropertyAccessExpression) =>
    IGNORED_PROP_NAMES.has(expr.name.text)
      ? O.none
      : O.some<TargetDescriptor>({
          targetKey: formatQualifiedPropertyKey(expr.name.text)(
            resolveExprTypeName(checker)(expr.expression),
          ),
          displayKey: expr.name.text,
        });

const formatIdentifierKey = (fileName: string) => (text: string) => `${fileName}#${text}`;

const extractIdentifierTargetKey = (sf: ts.SourceFile) => (expr: ts.Expression) =>
  ts.isIdentifier(expr)
    ? O.some<TargetDescriptor>({
        targetKey: formatIdentifierKey(sf.fileName)(expr.text),
        displayKey: expr.text,
      })
    : O.none;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive unwrap
const unwrapParenExpr = (expr: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expr) ? unwrapParenExpr(expr.expression) : expr;

type StringlyFileCtx = Readonly<{
  sf: ts.SourceFile;
  checker: ts.TypeChecker;
}>;

const resolveNonParenTargetKey =
  ({ sf, checker }: StringlyFileCtx) =>
  (expr: ts.Expression) =>
    ts.isPropertyAccessExpression(expr)
      ? resolveQualifiedPropertyKey(checker)(expr)
      : extractIdentifierTargetKey(sf)(expr);

const resolveTargetDescriptor = (ctx: StringlyFileCtx) => (expr: ts.Expression) =>
  resolveNonParenTargetKey(ctx)(unwrapParenExpr(expr));

const isBarePrimitiveSubject = (checker: ts.TypeChecker) =>
  flow(
    (expr: ts.Expression) => checker.getTypeAtLocation(expr),
    classifyBarePrimitiveKind,
    O.isSome,
  );

const combineTargetAndLiteral =
  (sf: ts.SourceFile) =>
  (locNode: ts.Node) =>
  (targetOpt: O.Option<TargetDescriptor>) =>
  (literalOpt: O.Option<string>) =>
    O.isSome(targetOpt) && O.isSome(literalOpt)
      ? O.some<DiscriminantOccurrence>({
          targetKey: targetOpt.value.targetKey,
          displayKey: targetOpt.value.displayKey,
          literalValue: literalOpt.value,
          location: resolveTsNodeLocation(sf)(locNode),
        })
      : O.none;

const extractSubjectLiteralOccurrence = ({
  subject,
  literalNode,
  locNode,
  sf,
  checker,
}: SubjectLiteralSite) =>
  isBarePrimitiveSubject(checker)(subject)
    ? combineTargetAndLiteral(sf)(locNode)(resolveTargetDescriptor({ sf, checker })(subject))(
        extractLiteralValue(literalNode),
      )
    : O.none;

const extractBinaryDirection =
  ({ sf, checker }: StringlyFileCtx) =>
  (node: ts.BinaryExpression) =>
  (pair: readonly [ts.Expression, ts.Expression]) =>
    extractSubjectLiteralOccurrence({
      subject: pair[0],
      literalNode: pair[1],
      locNode: node,
      sf,
      checker,
    });

const extractBinaryPair = (ctx: StringlyFileCtx) => (node: ts.BinaryExpression) =>
  O.alt(() => extractBinaryDirection(ctx)(node)([node.right, node.left]))(
    extractBinaryDirection(ctx)(node)([node.left, node.right]),
  );

const extractBinaryOccurrence = (ctx: StringlyFileCtx) => (node: ts.BinaryExpression) =>
  isEqualityToken(node.operatorToken.kind) ? extractBinaryPair(ctx)(node) : O.none;

const extractCaseClauseOcc =
  (sf: ts.SourceFile) => (target: TargetDescriptor) => (clause: ts.CaseOrDefaultClause) =>
    ts.isCaseClause(clause)
      ? O.map((literalValue: string) => ({
          targetKey: target.targetKey,
          displayKey: target.displayKey,
          literalValue,
          location: resolveTsNodeLocation(sf)(clause),
        }))(extractLiteralValue(clause.expression))
      : O.none;

const collectSwitchCaseClauses =
  (sf: ts.SourceFile) =>
  (target: TargetDescriptor) =>
  (clauses: ts.NodeArray<ts.CaseOrDefaultClause>) =>
    RA.filterMap(extractCaseClauseOcc(sf)(target))(clauses);

const extractSwitchCaseOccurrences = (ctx: StringlyFileCtx) => (node: ts.SwitchStatement) =>
  isBarePrimitiveSubject(ctx.checker)(node.expression)
    ? O.match(
        () => [] satisfies ReadonlyArray<DiscriminantOccurrence>,
        (target: TargetDescriptor) =>
          collectSwitchCaseClauses(ctx.sf)(target)(node.caseBlock.clauses),
      )(resolveTargetDescriptor(ctx)(node.expression))
    : [];

const isMatchIdentifierCall = (expr: ts.CallExpression) =>
  ts.isIdentifier(expr.expression) &&
  MATCH_CALL_NAMES.has(expr.expression.text) &&
  expr.arguments.length === 1;

const unwrapMatchChainExpr = (expr: ts.CallExpression) =>
  ts.isPropertyAccessExpression(expr.expression)
    ? findRootMatchSubject(expr.expression.expression)
    : O.none;

const matchCallSubject = (expr: ts.CallExpression) =>
  isMatchIdentifierCall(expr) ? O.fromNullable(expr.arguments[0]) : unwrapMatchChainExpr(expr);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive match chain walk
const findRootMatchSubject = (expr: ts.Expression): O.Option<ts.Expression> =>
  ts.isCallExpression(expr) ? matchCallSubject(expr) : O.none;

const isWithPropAccess = (expr: ts.Expression): expr is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(expr) && WITH_METHOD_NAMES.has(expr.name.text);

const extractMatchArgOccurrence =
  (sf: ts.SourceFile) =>
  (checker: ts.TypeChecker) =>
  (arg0: ts.Expression) =>
  (subject: ts.Expression) =>
    extractSubjectLiteralOccurrence({ subject, literalNode: arg0, locNode: arg0, sf, checker });

const extractMatchPairOccurrence =
  ({ sf, checker }: StringlyFileCtx) =>
  (arg0: O.Option<ts.Expression>) =>
  (subject: O.Option<ts.Expression>) =>
    O.isSome(arg0) && O.isSome(subject)
      ? extractMatchArgOccurrence(sf)(checker)(arg0.value)(subject.value)
      : O.none;

const extractMatchWithOccurrence = (ctx: StringlyFileCtx) => (node: ts.CallExpression) =>
  isWithPropAccess(node.expression) && node.arguments.length >= 1
    ? extractMatchPairOccurrence(ctx)(O.fromNullable(node.arguments[0]))(
        findRootMatchSubject(node.expression.expression),
      )
    : O.none;

const collectBinaryOccurrences = (ctx: StringlyFileCtx) => (nodes: ReadonlyArray<ts.Node>) =>
  RA.filterMap(extractBinaryOccurrence(ctx))(RA.filter(ts.isBinaryExpression)(nodes));

const collectSwitchOccurrences = (ctx: StringlyFileCtx) => (nodes: ReadonlyArray<ts.Node>) =>
  RA.flatMap(extractSwitchCaseOccurrences(ctx))(RA.filter(ts.isSwitchStatement)(nodes));

const collectMatchOccurrences = (ctx: StringlyFileCtx) => (nodes: ReadonlyArray<ts.Node>) =>
  RA.filterMap(extractMatchWithOccurrence(ctx))(RA.filter(ts.isCallExpression)(nodes));

const extractFileOccurrences = (checker: ts.TypeChecker) => (sf: ts.SourceFile) => {
  const nodes = collectTsNodes(sf)(sf);
  const ctx: StringlyFileCtx = { sf, checker };
  return [
    ...collectBinaryOccurrences(ctx)(nodes),
    ...collectSwitchOccurrences(ctx)(nodes),
    ...collectMatchOccurrences(ctx)(nodes),
  ];
};

const extractProgramFiles = (checker: ts.TypeChecker) =>
  RA.flatMap(extractFileOccurrences(checker));

const extractOccurrencesForProgram = (program: ts.Program) =>
  extractProgramFiles(program.getTypeChecker())(collectProjectSourceFiles(program));

const collectProgramOccurrences = memoizeByProgram(discriminantCache)(
  extractOccurrencesForProgram,
);

const extractOccLocations = RA.map((o: DiscriminantOccurrence) => o.location);

const buildCluster =
  (literals: ReadonlyArray<string>) => (occs: ReadonlyArray<DiscriminantOccurrence>) =>
    O.map((first: DiscriminantOccurrence) => ({
      targetKey: first.displayKey,
      literals,
      locations: extractOccLocations(occs),
    }))(O.fromNullable(occs[0]));

const extractSortedLiterals = flow(
  RA.map((o: DiscriminantOccurrence) => o.literalValue),
  RA.uniq(S.Eq),
  RA.sort(S.Ord),
);

const toCluster = (minBranches: number) => (occs: ReadonlyArray<DiscriminantOccurrence>) => {
  const literals = extractSortedLiterals(occs);
  return match(literals.length >= minBranches)
    .with(true, () => buildCluster(literals)(occs))
    .with(false, () => O.none satisfies O.Option<DiscriminantCluster>)
    .exhaustive();
};

const groupAllByTargetKey = RNEA.groupBy((occ: DiscriminantOccurrence) => occ.targetKey);

const expandClusterLocations = (cluster: DiscriminantCluster) =>
  RA.map((loc: TsLocation) => [makeLocationKey(loc), cluster] as const)(cluster.locations);

const indexByLocation = flow(RA.flatMap(expandClusterLocations), RR.fromEntries);

type DiscriminantIndex = Readonly<{
  readonly clusters: ReadonlyArray<DiscriminantCluster>;
  readonly byLocation: Readonly<Record<string, DiscriminantCluster>>;
}>;

const discriminantIndexCache = new WeakMap<
  ts.Program,
  Readonly<Record<string, DiscriminantIndex>>
>();

const buildDiscriminantIndex = (clusters: ReadonlyArray<DiscriminantCluster>) => ({
  clusters,
  byLocation: indexByLocation(clusters),
});

const computeDiscriminantIndexForMinBranches = (minBranches: number) =>
  flow(
    collectProgramOccurrences,
    groupAllByTargetKey,
    RR.toEntries,
    RA.filterMap(([, occs]: readonly [string, ReadonlyArray<DiscriminantOccurrence>]) =>
      toCluster(minBranches)(occs),
    ),
    buildDiscriminantIndex,
  );

const makeDiscriminantCacheKey = (minBranches: number) => String(minBranches);

export const analyzeStringlyTypedDiscriminants = ((program: ts.Program) =>
  (minBranches = 2) =>
    memoizeByProgramAndKey(discriminantIndexCache)(
      computeDiscriminantIndexForMinBranches(minBranches),
    )(program)(makeDiscriminantCacheKey(minBranches))) satisfies (
  program: ts.Program,
) => (minBranches?: number) => DiscriminantIndex;
