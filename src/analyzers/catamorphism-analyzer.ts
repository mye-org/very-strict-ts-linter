import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { memoizeByProgram, memoizeByProgramAndKey } from "../lib/program-memo.js";
import { collectProjectSourceFiles } from "../lib/source-paths.js";
import { NamedTsFunction, extractNamedTsFunction } from "../lib/ts-named-function.js";
import { TsLocation, makeLocationKey, resolveTsNodeLocation } from "../lib/ts-node-location.js";
import { collectTsNodes } from "../lib/ts-node-traversal.js";

export type RecursiveWalker = Readonly<
  Record<"functionName", string> & {
    readonly location: TsLocation;
  }
>;

export type CatamorphismFinding = Readonly<
  Record<"adtName" | "discriminant", string> & {
    readonly adtLocation: TsLocation;
    readonly walkers: ReadonlyArray<RecursiveWalker>;
  }
>;

export type CatamorphismAnalysis = Readonly<{
  readonly candidates: ReadonlyArray<CatamorphismFinding>;
  readonly locationIndex: Readonly<Record<string, ReadonlyArray<CatamorphismFinding>>>;
}>;

type RecursiveAdt = Readonly<
  Record<"name" | "discriminant", string> & {
    readonly location: TsLocation;
  }
>;

type WalkerMatch = Readonly<
  Record<"adtName" | "functionName", string> & {
    readonly location: TsLocation;
  }
>;

type ProgramAdtInventory = Readonly<{
  readonly adts: Readonly<Record<string, RecursiveAdt>>;
  readonly walkers: ReadonlyArray<WalkerMatch>;
}>;

const walkCache = new WeakMap<ts.Program, ProgramAdtInventory>();
const analysisCache = new WeakMap<ts.Program, Readonly<Record<string, CatamorphismAnalysis>>>();

const DISCRIMINANT_CANDIDATES = ["_tag", "kind", "type", "tag"] as const;
const FOLD_FUNCTION_RE = /^(fold|cata|reduce|traverse)(?=$|[A-Z0-9_])/;
const MATCH_CALL_NAMES: ReadonlySet<string> = new Set(["match"]);

const isLiteralDiscriminantType = (t: ts.Type) =>
  Boolean(t.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral));

const lookupMemberProp = (member: ts.Type, key: string) =>
  O.fromNullable(member.getProperty(key));

const hasLiteralDiscriminant = (member: ts.Type, key: string, checker: ts.TypeChecker) =>
  flow(
    lookupMemberProp,
    O.map((prop) => checker.getTypeOfSymbol(prop)),
    O.exists(isLiteralDiscriminantType),
  )(member, key);

const hasDiscriminantOnAllMembers = (
  members: ReadonlyArray<ts.Type>,
  key: string,
  checker: ts.TypeChecker,
) => RA.every((m: ts.Type) => hasLiteralDiscriminant(m, key, checker))(members);

const findSharedDiscriminant = (members: ReadonlyArray<ts.Type>, checker: ts.TypeChecker) =>
  RA.findFirst((key: string) => hasDiscriminantOnAllMembers(members, key, checker))(
    DISCRIMINANT_CANDIDATES,
  );

const isSelfTypeRefNode = (n: ts.Node, aliasName: string) =>
  ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) && n.typeName.text === aliasName;

const hasSelfTypeReference = (alias: ts.TypeAliasDeclaration, sf: ts.SourceFile) =>
  RA.some((n: ts.Node) => isSelfTypeRefNode(n, alias.name.text))(collectTsNodes(alias.type, sf));

const toRecursiveAdt = (
  alias: ts.TypeAliasDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) => {
  const type = checker.getTypeAtLocation(alias);
  return type.isUnion() && type.types.length >= 2
    ? O.map((discriminant: string) => ({
        name: alias.name.text,
        discriminant,
        location: resolveTsNodeLocation(alias, sf),
      }))(findSharedDiscriminant(type.types, checker))
    : O.none;
};

const extractRecursiveAdt = (node: ts.Node, sf: ts.SourceFile, checker: ts.TypeChecker) =>
  ts.isTypeAliasDeclaration(node) && hasSelfTypeReference(node, sf)
    ? toRecursiveAdt(node, sf, checker)
    : O.none;

const resolveTypeRefName = (typeNode: ts.TypeNode) =>
  ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)
    ? O.some(typeNode.typeName.text)
    : O.none;

const lookupAdtName = (adts: Readonly<Record<string, RecursiveAdt>>) =>
  flow(
    (name: string) => RR.lookup(name, adts),
    O.map((a) => a.name),
  );

const resolveAnnotatedAdtName = (
  param: ts.ParameterDeclaration,
  adts: Readonly<Record<string, RecursiveAdt>>,
) =>
  flow(
    O.flatMap(resolveTypeRefName),
    O.flatMap(lookupAdtName(adts)),
  )(O.fromNullable(param.type));

const readParamAliasName = (param: ts.ParameterDeclaration, checker: ts.TypeChecker) =>
  O.fromNullable(checker.getTypeAtLocation(param).aliasSymbol?.name);

const resolveCheckedAdtName = (
  param: ts.ParameterDeclaration,
  adts: Readonly<Record<string, RecursiveAdt>>,
  checker: ts.TypeChecker,
) => flow(readParamAliasName, O.flatMap(lookupAdtName(adts)))(param, checker);

const resolveParamAdtName = (
  param: ts.ParameterDeclaration,
  adts: Readonly<Record<string, RecursiveAdt>>,
  checker: ts.TypeChecker,
) =>
  O.alt(() => resolveCheckedAdtName(param, adts, checker))(resolveAnnotatedAdtName(param, adts));

const hasCallArgument = (call: ts.CallExpression, id: ts.Identifier) => call.arguments.includes(id);

const isCallCalleeOrArg = (call: ts.CallExpression, id: ts.Identifier) =>
  call.expression === id || hasCallArgument(call, id);

const isSelfCallOrArg = (n: ts.Node, fnName: string) =>
  ts.isIdentifier(n) &&
  n.text === fnName &&
  ts.isCallExpression(n.parent) &&
  isCallCalleeOrArg(n.parent, n);

const hasSelfRecursiveReference = (fnBody: ts.Node, fnName: string, sf: ts.SourceFile) =>
  RA.some((n: ts.Node) => isSelfCallOrArg(n, fnName))(collectTsNodes(fnBody, sf));

const isMatchCallExpr = (n: ts.Node) =>
  ts.isCallExpression(n) && ts.isIdentifier(n.expression) && MATCH_CALL_NAMES.has(n.expression.text);

const isDiscriminantAccess = (n: ts.Node, discriminant: string) =>
  ts.isPropertyAccessExpression(n) && n.name.text === discriminant;

const isAdtDispatchNode = (n: ts.Node, discriminant: string) =>
  isMatchCallExpr(n) || ts.isSwitchStatement(n) || isDiscriminantAccess(n, discriminant);

const hasAdtDispatch = (fnBody: ts.Node, discriminant: string, sf: ts.SourceFile) =>
  RA.some((n: ts.Node) => isAdtDispatchNode(n, discriminant))(collectTsNodes(fnBody, sf));

const hasDispatchForAdt = (
  adtName: string,
  fnBody: ts.Node,
  sf: ts.SourceFile,
  adts: Readonly<Record<string, RecursiveAdt>>,
) => O.exists((adt: RecursiveAdt) => hasAdtDispatch(fnBody, adt.discriminant, sf))(RR.lookup(adtName, adts));

const isFoldFunctionName = (name: string) => FOLD_FUNCTION_RE.test(name);
const toParamArray = (params: ts.NodeArray<ts.ParameterDeclaration>) => Array.from(params);

const matchWalkerAdt = (
  decl: NamedTsFunction,
  sf: ts.SourceFile,
  adts: Readonly<Record<string, RecursiveAdt>>,
  checker: ts.TypeChecker,
) =>
  flow(
    toParamArray,
    RA.filterMap((p) => resolveParamAdtName(p, adts, checker)),
    RA.findFirst((adtName) => hasDispatchForAdt(adtName, decl.fnBody, sf, adts)),
    O.map((adtName) => ({
      adtName,
      functionName: decl.name,
      location: resolveTsNodeLocation(decl.locNode, sf),
    })),
  )(decl.paramNodes);

const inspectFunctionForWalker = (
  decl: NamedTsFunction,
  sf: ts.SourceFile,
  adts: Readonly<Record<string, RecursiveAdt>>,
  checker: ts.TypeChecker,
) =>
  isFoldFunctionName(decl.name) || !hasSelfRecursiveReference(decl.fnBody, decl.name, sf)
    ? O.none
    : matchWalkerAdt(decl, sf, adts, checker);

const collectFileNodes = (sf: ts.SourceFile) => collectTsNodes(sf, sf);

const extractFileWalkers = (
  sf: ts.SourceFile,
  adts: Readonly<Record<string, RecursiveAdt>>,
  checker: ts.TypeChecker,
) =>
  flow(
    collectFileNodes,
    RA.filterMap(extractNamedTsFunction),
    RA.filterMap((decl) => inspectFunctionForWalker(decl, sf, adts, checker)),
  )(sf);

const collectFileAdts = (sf: ts.SourceFile, checker: ts.TypeChecker) =>
  flow(
    collectFileNodes,
    RA.filterMap((n) => extractRecursiveAdt(n, sf, checker)),
  )(sf);

const indexAdts = flow(
  RA.map((adt: RecursiveAdt) => [adt.name, adt] as const),
  RR.fromEntries,
);

const collectAllAdts = (sourceFiles: ReadonlyArray<ts.SourceFile>, checker: ts.TypeChecker) =>
  flow(
    RA.flatMap((sf: ts.SourceFile) => collectFileAdts(sf, checker)),
    indexAdts,
  )(sourceFiles);

const collectProgramAdtInventory = (program: ts.Program) => {
  const checker = program.getTypeChecker();
  const sourceFiles = collectProjectSourceFiles(program);
  const adts = collectAllAdts(sourceFiles, checker);
  return {
    adts,
    walkers: RA.flatMap((sf: ts.SourceFile) => extractFileWalkers(sf, adts, checker))(sourceFiles),
  };
};

const expandFindingWalkers = (finding: CatamorphismFinding) =>
  RA.map((w: RecursiveWalker) => [makeLocationKey(w.location), finding] as const)(finding.walkers);

const extractFindingFromPair = ([, finding]: readonly [string, CatamorphismFinding]) => finding;

const indexFindingsByLocation = flow(
  RA.flatMap(expandFindingWalkers),
  RNEA.groupBy(([locKey]) => locKey),
  RR.map(RA.map(extractFindingFromPair)),
);

const toRecursiveWalker = (w: WalkerMatch) => ({
  functionName: w.functionName,
  location: w.location,
});

const groupWalkersByAdt = flow(
  RNEA.groupBy((w: WalkerMatch) => w.adtName),
  RR.map(RA.map(toRecursiveWalker)),
);

const buildCatamorphismFinding = (
  adtName: string,
  list: ReadonlyArray<RecursiveWalker>,
  adts: Readonly<Record<string, RecursiveAdt>>,
) =>
  O.map((adt: RecursiveAdt) => ({
    adtName,
    discriminant: adt.discriminant,
    adtLocation: adt.location,
    walkers: list,
  }))(RR.lookup(adtName, adts));

const buildCatamorphismAnalysis = (candidates: ReadonlyArray<CatamorphismFinding>) => ({
  candidates,
  locationIndex: indexFindingsByLocation(candidates),
});

const computeCatamorphisms = (program: ts.Program, minWalkers: number) => {
  const { adts, walkers } = memoizeByProgram(program, walkCache, collectProgramAdtInventory);
  return flow(
    groupWalkersByAdt,
    RR.toEntries,
    RA.filter(([, list]) => list.length >= minWalkers),
    RA.filterMap(([adtName, list]) => buildCatamorphismFinding(adtName, list, adts)),
    buildCatamorphismAnalysis,
  )(walkers);
};

const makeCatamorphismCacheKey = (minWalkers: number) => String(minWalkers);

export const analyzeCatamorphisms = (program: ts.Program, minWalkers = 2) =>
  memoizeByProgramAndKey(
    program,
    makeCatamorphismCacheKey(minWalkers),
    analysisCache,
    (p) => computeCatamorphisms(p, minWalkers),
  );
