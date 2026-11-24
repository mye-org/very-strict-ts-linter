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

const checkLiteralProp = (checker: ts.TypeChecker) =>
  flow((prop: ts.Symbol) => checker.getTypeOfSymbol(prop), isLiteralDiscriminantType);

type DiscriminantCheckEnv = Readonly<
  Record<"key", string> & {
    readonly checker: ts.TypeChecker;
  }
>;

const hasLiteralDiscriminant = (member: ts.Type, { key, checker }: DiscriminantCheckEnv) =>
  O.exists(checkLiteralProp(checker))(lookupMemberProp(member, key));

const hasDiscriminantOnAllMembers = (
  members: ReadonlyArray<ts.Type>,
  env: DiscriminantCheckEnv,
) => RA.every((m: ts.Type) => hasLiteralDiscriminant(m, env))(members);

const findSharedDiscriminant = (members: ReadonlyArray<ts.Type>, checker: ts.TypeChecker) =>
  RA.findFirst((key: string) => hasDiscriminantOnAllMembers(members, { key, checker }))(
    DISCRIMINANT_CANDIDATES,
  );

const isSelfTypeRefNode = (n: ts.Node, aliasName: string) =>
  ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) && n.typeName.text === aliasName;

const hasSelfTypeReference = (alias: ts.TypeAliasDeclaration, sf: ts.SourceFile) =>
  RA.some((n: ts.Node) => isSelfTypeRefNode(n, alias.name.text))(collectTsNodes(alias.type, sf));

const toRecursiveAdt =
  (checker: ts.TypeChecker) => (alias: ts.TypeAliasDeclaration, sf: ts.SourceFile) => {
    const type = checker.getTypeAtLocation(alias);
    return type.isUnion() && type.types.length >= 2
      ? O.map((discriminant: string) => ({
          name: alias.name.text,
          discriminant,
          location: resolveTsNodeLocation(alias, sf),
        }))(findSharedDiscriminant(type.types, checker))
      : O.none;
  };

const extractRecursiveAdt =
  (checker: ts.TypeChecker) => (node: ts.Node, sf: ts.SourceFile) =>
    ts.isTypeAliasDeclaration(node) && hasSelfTypeReference(node, sf)
      ? toRecursiveAdt(checker)(node, sf)
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

const resolveAnnotatedTypeName = (adts: Readonly<Record<string, RecursiveAdt>>) =>
  flow(
    (param: ts.ParameterDeclaration) => O.fromNullable(param.type),
    O.flatMap(resolveTypeRefName),
    O.flatMap(lookupAdtName(adts)),
  );

const resolveAnnotatedAdtName = (
  param: ts.ParameterDeclaration,
  adts: Readonly<Record<string, RecursiveAdt>>,
) => resolveAnnotatedTypeName(adts)(param);

const readParamAliasName = (param: ts.ParameterDeclaration, checker: ts.TypeChecker) =>
  O.fromNullable(checker.getTypeAtLocation(param).aliasSymbol?.name);

type AdtLookupEnv = Readonly<{
  adts: Readonly<Record<string, RecursiveAdt>>;
  checker: ts.TypeChecker;
}>;

type WalkerEnv = AdtLookupEnv & Readonly<{ sf: ts.SourceFile }>;

const resolveCheckedAdtName = (param: ts.ParameterDeclaration, env: AdtLookupEnv) =>
  O.flatMap(lookupAdtName(env.adts))(readParamAliasName(param, env.checker));

const resolveParamAdtName = (param: ts.ParameterDeclaration, env: AdtLookupEnv) =>
  O.alt(() => resolveCheckedAdtName(param, env))(resolveAnnotatedAdtName(param, env.adts));

const hasCallArgument = (call: ts.CallExpression, id: ts.Identifier) => call.arguments.includes(id);

const isCallCalleeOrArg = (call: ts.CallExpression, id: ts.Identifier) =>
  call.expression === id || hasCallArgument(call, id);

const isSelfCallOrArg = (n: ts.Node, fnName: string) =>
  ts.isIdentifier(n) &&
  n.text === fnName &&
  ts.isCallExpression(n.parent) &&
  isCallCalleeOrArg(n.parent, n);

const hasSelfRecursiveReference = (decl: NamedTsFunction, sf: ts.SourceFile) =>
  RA.some((n: ts.Node) => isSelfCallOrArg(n, decl.name))(collectTsNodes(decl.fnBody, sf));

const isMatchCallExpr = (n: ts.Node) =>
  ts.isCallExpression(n) && ts.isIdentifier(n.expression) && MATCH_CALL_NAMES.has(n.expression.text);

const isDiscriminantAccess = (n: ts.Node, discriminant: string) =>
  ts.isPropertyAccessExpression(n) && n.name.text === discriminant;

const isAdtDispatchNode = (n: ts.Node, discriminant: string) =>
  isMatchCallExpr(n) || ts.isSwitchStatement(n) || isDiscriminantAccess(n, discriminant);

const hasAdtDispatch = (
  fnBody: ts.Node,
  { discriminant, sf }: Readonly<Record<"discriminant", string> & { readonly sf: ts.SourceFile }>,
) => RA.some((n: ts.Node) => isAdtDispatchNode(n, discriminant))(collectTsNodes(fnBody, sf));

const hasDispatchForAdt = (
  decl: NamedTsFunction,
  { adtName, env }: Readonly<Record<"adtName", string> & { readonly env: WalkerEnv }>,
) =>
  O.exists((adt: RecursiveAdt) =>
    hasAdtDispatch(decl.fnBody, { discriminant: adt.discriminant, sf: env.sf }),
  )(RR.lookup(adtName, env.adts));

const isFoldFunctionName = (name: string) => FOLD_FUNCTION_RE.test(name);
const toParamArray = (params: ts.NodeArray<ts.ParameterDeclaration>) => Array.from(params);

const findWalkerAdtName = (decl: NamedTsFunction, env: WalkerEnv) =>
  flow(
    toParamArray,
    RA.filterMap((p: ts.ParameterDeclaration) => resolveParamAdtName(p, env)),
    RA.findFirst((adtName: string) => hasDispatchForAdt(decl, { adtName, env })),
    O.map((adtName: string) => ({
      adtName,
      functionName: decl.name,
      location: resolveTsNodeLocation(decl.locNode, env.sf),
    })),
  );

const inspectFunctionForWalker = (decl: NamedTsFunction, env: WalkerEnv) =>
  isFoldFunctionName(decl.name) || !hasSelfRecursiveReference(decl, env.sf)
    ? O.none
    : findWalkerAdtName(decl, env)(decl.paramNodes);

const collectFileNodes = (sf: ts.SourceFile) => collectTsNodes(sf, sf);

const collectNamedFunctions = flow(collectFileNodes, RA.filterMap(extractNamedTsFunction));

const extractFileWalkers = (sf: ts.SourceFile, env: AdtLookupEnv) =>
  RA.filterMap((decl: NamedTsFunction) => inspectFunctionForWalker(decl, { ...env, sf }))(
    collectNamedFunctions(sf),
  );

const collectFileAdts = (sf: ts.SourceFile, checker: ts.TypeChecker) =>
  RA.filterMap((n: ts.Node) => extractRecursiveAdt(checker)(n, sf))(collectFileNodes(sf));

const indexAdts = flow(
  RA.map((adt: RecursiveAdt) => [adt.name, adt] as const),
  RR.fromEntries,
);

const collectAllAdts = (sourceFiles: ReadonlyArray<ts.SourceFile>, checker: ts.TypeChecker) =>
  indexAdts(RA.flatMap((sf: ts.SourceFile) => collectFileAdts(sf, checker))(sourceFiles));

const collectProgramAdtInventory = (program: ts.Program) => {
  const checker = program.getTypeChecker();
  const sourceFiles = collectProjectSourceFiles(program);
  const adts = collectAllAdts(sourceFiles, checker);
  return {
    adts,
    walkers: RA.flatMap((sf: ts.SourceFile) => extractFileWalkers(sf, { adts, checker }))(
      sourceFiles,
    ),
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
    }))(RR.lookup(adtName, adts));

const buildCatamorphismAnalysis = (candidates: ReadonlyArray<CatamorphismFinding>) => ({
  candidates,
  locationIndex: indexFindingsByLocation(candidates),
});

const summarizeWalkers = (adts: Readonly<Record<string, RecursiveAdt>>, minWalkers: number) =>
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
    summarizeWalkers(adts, minWalkers)(walkers);

const computeCatamorphismsForMinWalkers = (minWalkers: number) =>
  flow(memoizeByProgram(walkCache, collectProgramAdtInventory), analyzeInventory(minWalkers));

const makeCatamorphismCacheKey = (minWalkers: number) => String(minWalkers);

export const analyzeCatamorphisms = (program: ts.Program, minWalkers = 2): CatamorphismAnalysis =>
  memoizeByProgramAndKey(
    analysisCache,
    computeCatamorphismsForMinWalkers(minWalkers),
  )(program, makeCatamorphismCacheKey(minWalkers));
