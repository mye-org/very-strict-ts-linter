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

const lookupMemberProp = (key: string) => (member: ts.Type) =>
  O.fromNullable(member.getProperty(key));

const checkLiteralProp = (checker: ts.TypeChecker) =>
  flow((prop: ts.Symbol) => checker.getTypeOfSymbol(prop), isLiteralDiscriminantType);

type DiscriminantCheckEnv = Readonly<
  Record<"key", string> & {
    readonly checker: ts.TypeChecker;
  }
>;

const hasLiteralDiscriminant = ({ key, checker }: DiscriminantCheckEnv) => (member: ts.Type) =>
  O.exists(checkLiteralProp(checker))(lookupMemberProp(key)(member));

const hasDiscriminantOnAllMembers =
  (env: DiscriminantCheckEnv) => (members: ReadonlyArray<ts.Type>) =>
    RA.every(hasLiteralDiscriminant(env))(members);

const findSharedDiscriminant = (checker: ts.TypeChecker) => (members: ReadonlyArray<ts.Type>) =>
  RA.findFirst((key: string) => hasDiscriminantOnAllMembers({ key, checker })(members))(
    DISCRIMINANT_CANDIDATES,
  );

const isSelfTypeRefNode = (aliasName: string) => (n: ts.Node) =>
  ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) && n.typeName.text === aliasName;

const hasSelfTypeReference = (sf: ts.SourceFile) => (alias: ts.TypeAliasDeclaration) =>
  RA.some(isSelfTypeRefNode(alias.name.text))(collectTsNodes(sf)(alias.type));

const toRecursiveAdt =
  (checker: ts.TypeChecker) => (sf: ts.SourceFile) => (alias: ts.TypeAliasDeclaration) => {
    const type = checker.getTypeAtLocation(alias);
    return type.isUnion() && type.types.length >= 2
      ? O.map((discriminant: string) => ({
          name: alias.name.text,
          discriminant,
          location: resolveTsNodeLocation(sf)(alias),
        }))(findSharedDiscriminant(checker)(type.types))
      : O.none;
  };

const extractRecursiveAdt =
  (checker: ts.TypeChecker) => (sf: ts.SourceFile) => (node: ts.Node) =>
    ts.isTypeAliasDeclaration(node) && hasSelfTypeReference(sf)(node)
      ? toRecursiveAdt(checker)(sf)(node)
      : O.none;

const resolveTypeRefName = (typeNode: ts.TypeNode) =>
  ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)
    ? O.some(typeNode.typeName.text)
    : O.none;

const lookupAdtName = (adts: Readonly<Record<string, RecursiveAdt>>) =>
  flow(
    (name: string) => RR.lookup(name)(adts),
    O.map((a) => a.name),
  );

const resolveAnnotatedTypeName = (adts: Readonly<Record<string, RecursiveAdt>>) =>
  flow(
    (param: ts.ParameterDeclaration) => O.fromNullable(param.type),
    O.flatMap(resolveTypeRefName),
    O.flatMap(lookupAdtName(adts)),
  );

const resolveAnnotatedAdtName =
  (adts: Readonly<Record<string, RecursiveAdt>>) => (param: ts.ParameterDeclaration) =>
    resolveAnnotatedTypeName(adts)(param);

const readParamAliasName = (checker: ts.TypeChecker) => (param: ts.ParameterDeclaration) =>
  O.map((sym: ts.Symbol) => sym.name)(
    O.fromNullable(checker.getTypeAtLocation(param).aliasSymbol),
  );

type AdtLookupEnv = Readonly<{
  adts: Readonly<Record<string, RecursiveAdt>>;
  checker: ts.TypeChecker;
}>;

type WalkerEnv = AdtLookupEnv & Readonly<{ sf: ts.SourceFile }>;

const resolveCheckedAdtName = (env: AdtLookupEnv) => (param: ts.ParameterDeclaration) =>
  O.flatMap(lookupAdtName(env.adts))(readParamAliasName(env.checker)(param));

const resolveParamAdtName = (env: AdtLookupEnv) => (param: ts.ParameterDeclaration) =>
  O.alt(() => resolveCheckedAdtName(env)(param))(resolveAnnotatedAdtName(env.adts)(param));

const hasCallArgument = (id: ts.Identifier) => (call: ts.CallExpression) =>
  call.arguments.includes(id);

const isCallCalleeOrArg = (id: ts.Identifier) => (call: ts.CallExpression) =>
  call.expression === id || hasCallArgument(id)(call);

const isSelfCallOrArg = (fnName: string) => (n: ts.Node) =>
  ts.isIdentifier(n) &&
  n.text === fnName &&
  ts.isCallExpression(n.parent) &&
  isCallCalleeOrArg(n)(n.parent);

const hasSelfRecursiveReference = (sf: ts.SourceFile) => (decl: NamedTsFunction) =>
  RA.some(isSelfCallOrArg(decl.name))(collectTsNodes(sf)(decl.fnBody));

const isMatchCallExpr = (n: ts.Node) =>
  ts.isCallExpression(n) && ts.isIdentifier(n.expression) && MATCH_CALL_NAMES.has(n.expression.text);

const isDiscriminantAccess = (discriminant: string) => (n: ts.Node) =>
  ts.isPropertyAccessExpression(n) && n.name.text === discriminant;

const isAdtDispatchNode = (discriminant: string) => (n: ts.Node) =>
  isMatchCallExpr(n) || ts.isSwitchStatement(n) || isDiscriminantAccess(discriminant)(n);

const hasAdtDispatch =
  ({ discriminant, sf }: Readonly<Record<"discriminant", string> & { readonly sf: ts.SourceFile }>) =>
  (fnBody: ts.Node) =>
    RA.some(isAdtDispatchNode(discriminant))(collectTsNodes(sf)(fnBody));

const hasDispatchForAdt =
  ({ adtName, env }: Readonly<Record<"adtName", string> & { readonly env: WalkerEnv }>) =>
  (decl: NamedTsFunction) =>
    O.exists((adt: RecursiveAdt) =>
      hasAdtDispatch({ discriminant: adt.discriminant, sf: env.sf })(decl.fnBody),
    )(RR.lookup(adtName)(env.adts));

const isFoldFunctionName = (name: string) => FOLD_FUNCTION_RE.test(name);
const toParamArray = (params: ts.NodeArray<ts.ParameterDeclaration>) => Array.from(params);

const findWalkerAdtName = (env: WalkerEnv) => (decl: NamedTsFunction) =>
  flow(
    toParamArray,
    RA.filterMap(resolveParamAdtName(env)),
    RA.findFirst((adtName: string) => hasDispatchForAdt({ adtName, env })(decl)),
    O.map((adtName: string) => ({
      adtName,
      functionName: decl.name,
      location: resolveTsNodeLocation(env.sf)(decl.locNode),
    })),
  );

const inspectFunctionForWalker = (env: WalkerEnv) => (decl: NamedTsFunction) =>
  isFoldFunctionName(decl.name) || !hasSelfRecursiveReference(env.sf)(decl)
    ? O.none
    : findWalkerAdtName(env)(decl)(decl.paramNodes);

const collectFileNodes = (sf: ts.SourceFile) => collectTsNodes(sf)(sf);

const collectNamedFunctions = flow(collectFileNodes, RA.filterMap(extractNamedTsFunction));

const extractFileWalkers = (env: AdtLookupEnv) => (sf: ts.SourceFile) =>
  RA.filterMap(inspectFunctionForWalker({ ...env, sf }))(collectNamedFunctions(sf));

const collectFileAdts = (checker: ts.TypeChecker) => (sf: ts.SourceFile) =>
  RA.filterMap(extractRecursiveAdt(checker)(sf))(collectFileNodes(sf));

const indexAdts = flow(
  RA.map((adt: RecursiveAdt) => [adt.name, adt] as const),
  RR.fromEntries,
);

const collectAllAdts = (checker: ts.TypeChecker) => (sourceFiles: ReadonlyArray<ts.SourceFile>) =>
  indexAdts(RA.flatMap(collectFileAdts(checker))(sourceFiles));

const collectProgramAdtInventory = (program: ts.Program) => {
  const checker = program.getTypeChecker();
  const sourceFiles = collectProjectSourceFiles(program);
  const adts = collectAllAdts(checker)(sourceFiles);
  return {
    adts,
    walkers: RA.flatMap(extractFileWalkers({ adts, checker }))(sourceFiles),
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

const buildCatamorphismFinding =
  (adts: Readonly<Record<string, RecursiveAdt>>) =>
  ([adtName, list]: readonly [string, ReadonlyArray<RecursiveWalker>]) =>
    O.map((adt: RecursiveAdt) => ({
      adtName,
      discriminant: adt.discriminant,
      adtLocation: adt.location,
      walkers: list,
    }))(RR.lookup(adtName)(adts));

const buildCatamorphismAnalysis = (candidates: ReadonlyArray<CatamorphismFinding>) => ({
  candidates,
  locationIndex: indexFindingsByLocation(candidates),
});

const summarizeWalkers = (adts: Readonly<Record<string, RecursiveAdt>>) => (minWalkers: number) =>
  flow(
    groupWalkersByAdt,
    RR.toEntries,
    RA.filter(
      ([, list]: readonly [string, ReadonlyArray<RecursiveWalker>]) => list.length >= minWalkers,
    ),
    RA.filterMap(buildCatamorphismFinding(adts)),
    buildCatamorphismAnalysis,
  );

const analyzeInventory =
  (minWalkers: number) =>
  ({ adts, walkers }: ProgramAdtInventory) =>
    summarizeWalkers(adts)(minWalkers)(walkers);

const computeCatamorphismsForMinWalkers = (minWalkers: number) =>
  flow(memoizeByProgram(walkCache)(collectProgramAdtInventory), analyzeInventory(minWalkers));

const makeCatamorphismCacheKey = (minWalkers: number) => String(minWalkers);

export const analyzeCatamorphisms = ((program: ts.Program) => (minWalkers = 2) =>
  memoizeByProgramAndKey(analysisCache)(computeCatamorphismsForMinWalkers(minWalkers))(program)(
    makeCatamorphismCacheKey(minWalkers),
  )) satisfies (program: ts.Program) => (minWalkers?: number) => CatamorphismAnalysis;
