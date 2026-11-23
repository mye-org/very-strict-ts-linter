import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { pipe } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import {
  getProjectSourceFiles,
  memoizeByProgram,
  memoizeByProgramAndKey,
} from "../utils/program-cache.js";
import {
  collectTsNodes,
  extractNamedTsFunction,
  getTsNodeLocation,
  makeLocationKey,
  NamedTsFunction,
  TsLocation,
} from "../utils/ts-ast-helpers.js";

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

type ProgramAdtWalkData = Readonly<{
  readonly adts: Readonly<Record<string, RecursiveAdt>>;
  readonly walkers: ReadonlyArray<WalkerMatch>;
}>;

const walkCache = new WeakMap<ts.Program, ProgramAdtWalkData>();
const analysisCache = new WeakMap<ts.Program, Readonly<Record<string, CatamorphismAnalysis>>>();

const DISCRIMINANT_CANDIDATES = ["_tag", "kind", "type", "tag"] as const;
const FOLD_FUNCTION_RE = /^(fold|cata|reduce|traverse)(?=$|[A-Z0-9_])/;

const hasLiteralDiscriminant = (member: ts.Type, key: string, checker: ts.TypeChecker) =>
  pipe(
    O.fromNullable(member.getProperty(key)),
    O.map((prop) => checker.getTypeOfSymbol(prop)),
    O.exists((t) => Boolean(t.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral))),
  );

const hasDiscriminantOnAllMembers = (
  members: ReadonlyArray<ts.Type>,
  key: string,
  checker: ts.TypeChecker,
) => pipe(members, RA.every((m) => hasLiteralDiscriminant(m, key, checker)));

const findSharedDiscriminant = (members: ReadonlyArray<ts.Type>, checker: ts.TypeChecker) =>
  pipe(
    DISCRIMINANT_CANDIDATES,
    RA.findFirst((key) => hasDiscriminantOnAllMembers(members, key, checker)),
  );

const hasSelfTypeReference = (alias: ts.TypeAliasDeclaration, sf: ts.SourceFile) =>
  pipe(
    collectTsNodes(alias.type, sf),
    RA.some(
      (n) =>
        ts.isTypeReferenceNode(n) &&
        ts.isIdentifier(n.typeName) &&
        n.typeName.text === alias.name.text,
    ),
  );

const toRecursiveAdt = (
  alias: ts.TypeAliasDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) => {
  const type = checker.getTypeAtLocation(alias);
  return type.isUnion() && type.types.length >= 2
    ? pipe(
        findSharedDiscriminant(type.types, checker),
        O.map((discriminant) => ({
          name: alias.name.text,
          discriminant,
          location: getTsNodeLocation(alias, sf),
        })),
      )
    : O.none;
};

const extractRecursiveAdt = (node: ts.Node, sf: ts.SourceFile, checker: ts.TypeChecker) =>
  ts.isTypeAliasDeclaration(node) && hasSelfTypeReference(node, sf)
    ? toRecursiveAdt(node, sf, checker)
    : O.none;

const getAnnotatedAdtName = (
  param: ts.ParameterDeclaration,
  adts: Readonly<Record<string, RecursiveAdt>>,
) =>
  param.type && ts.isTypeReferenceNode(param.type) && ts.isIdentifier(param.type.typeName)
    ? pipe(RR.lookup(param.type.typeName.text, adts), O.map((a) => a.name))
    : O.none;

const getCheckedAdtName = (
  param: ts.ParameterDeclaration,
  adts: Readonly<Record<string, RecursiveAdt>>,
  checker: ts.TypeChecker,
) =>
  pipe(
    O.fromNullable(checker.getTypeAtLocation(param).aliasSymbol?.name),
    O.flatMap((name) => RR.lookup(name, adts)),
    O.map((a) => a.name),
  );

const getParamAdtName = (
  param: ts.ParameterDeclaration,
  adts: Readonly<Record<string, RecursiveAdt>>,
  checker: ts.TypeChecker,
) =>
  pipe(
    getAnnotatedAdtName(param, adts),
    O.alt(() => getCheckedAdtName(param, adts, checker)),
  );

const isSelfCallOrArg = (n: ts.Node, fnName: string) =>
  ts.isIdentifier(n) &&
  n.text === fnName &&
  ts.isCallExpression(n.parent) &&
  (n.parent.expression === n || n.parent.arguments.includes(n));

const hasSelfRecursiveReference = (fnBody: ts.Node, fnName: string, sf: ts.SourceFile) =>
  pipe(
    collectTsNodes(fnBody, sf),
    RA.some((n) => isSelfCallOrArg(n, fnName)),
  );

const hasAdtDispatch = (fnBody: ts.Node, discriminant: string, sf: ts.SourceFile) =>
  pipe(
    collectTsNodes(fnBody, sf),
    RA.some(
      (n) =>
        (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "match") ||
        ts.isSwitchStatement(n) ||
        (ts.isPropertyAccessExpression(n) && n.name.text === discriminant),
    ),
  );

const hasDispatchForAdt = (
  adtName: string,
  fnBody: ts.Node,
  sf: ts.SourceFile,
  adts: Readonly<Record<string, RecursiveAdt>>,
) =>
  pipe(
    RR.lookup(adtName, adts),
    O.exists((adt) => hasAdtDispatch(fnBody, adt.discriminant, sf)),
  );

const inspectFunctionForWalker = (
  decl: NamedTsFunction,
  sf: ts.SourceFile,
  adts: Readonly<Record<string, RecursiveAdt>>,
  checker: ts.TypeChecker,
) =>
  FOLD_FUNCTION_RE.test(decl.name) || !hasSelfRecursiveReference(decl.fnBody, decl.name, sf)
    ? O.none
    : pipe(
        Array.from(decl.paramNodes),
        RA.filterMap((p) => getParamAdtName(p, adts, checker)),
        RA.findFirst((adtName) => hasDispatchForAdt(adtName, decl.fnBody, sf, adts)),
        O.map((adtName) => ({
          adtName,
          functionName: decl.name,
          location: getTsNodeLocation(decl.locNode, sf),
        })),
      );

const extractFileWalkers = (
  sf: ts.SourceFile,
  adts: Readonly<Record<string, RecursiveAdt>>,
  checker: ts.TypeChecker,
) =>
  pipe(
    collectTsNodes(sf, sf),
    RA.filterMap(extractNamedTsFunction),
    RA.filterMap((decl) => inspectFunctionForWalker(decl, sf, adts, checker)),
  );

const collectFileAdts = (sf: ts.SourceFile, checker: ts.TypeChecker) =>
  pipe(
    collectTsNodes(sf, sf),
    RA.filterMap((n) => extractRecursiveAdt(n, sf, checker)),
  );

const indexAdts = (list: ReadonlyArray<RecursiveAdt>) =>
  pipe(
    list,
    RA.reduce<RecursiveAdt, Readonly<Record<string, RecursiveAdt>>>({}, (acc, adt) => ({
      ...acc,
      [adt.name]: adt,
    })),
  );

const collectAllAdts = (sourceFiles: ReadonlyArray<ts.SourceFile>, checker: ts.TypeChecker) =>
  pipe(sourceFiles, RA.flatMap((sf) => collectFileAdts(sf, checker)), indexAdts);

const collectProgramAdtWalkData = (program: ts.Program) => {
  const checker = program.getTypeChecker();
  const sourceFiles = getProjectSourceFiles(program);
  const adts = collectAllAdts(sourceFiles, checker);
  return {
    adts,
    walkers: pipe(sourceFiles, RA.flatMap((sf) => extractFileWalkers(sf, adts, checker))),
  };
};

const addWalkersToIndex = (
  acc: Readonly<Record<string, ReadonlyArray<CatamorphismFinding>>>,
  finding: CatamorphismFinding,
) =>
  pipe(
    finding.walkers,
    RA.reduce(acc, (inner, w) => {
      const key = makeLocationKey(w.location);
      return { ...inner, [key]: [...(inner[key] ?? []), finding] };
    }),
  );

const indexFindingsByLocation = (candidates: ReadonlyArray<CatamorphismFinding>) =>
  pipe(
    candidates,
    RA.reduce<CatamorphismFinding, Readonly<Record<string, ReadonlyArray<CatamorphismFinding>>>>(
      {},
      addWalkersToIndex,
    ),
  );

const groupWalkersByAdt = (walkers: ReadonlyArray<WalkerMatch>) =>
  pipe(
    walkers,
    RA.reduce<WalkerMatch, Readonly<Record<string, ReadonlyArray<RecursiveWalker>>>>(
      {},
      (acc, w) => ({
        ...acc,
        [w.adtName]: [...(acc[w.adtName] ?? []), { functionName: w.functionName, location: w.location }],
      }),
    ),
  );

const buildCatamorphismFinding = (
  adtName: string,
  list: ReadonlyArray<RecursiveWalker>,
  adts: Readonly<Record<string, RecursiveAdt>>,
) =>
  pipe(
    RR.lookup(adtName, adts),
    O.map((adt) => ({
      adtName,
      discriminant: adt.discriminant,
      adtLocation: adt.location,
      walkers: list,
    })),
  );

const computeCatamorphisms = (program: ts.Program, minWalkers: number) => {
  const { adts, walkers } = memoizeByProgram(program, walkCache, collectProgramAdtWalkData);
  const candidates = pipe(
    groupWalkersByAdt(walkers),
    RR.toEntries,
    RA.filter(([, list]) => list.length >= minWalkers),
    RA.filterMap(([adtName, list]) => buildCatamorphismFinding(adtName, list, adts)),
  );
  return { candidates, locationIndex: indexFindingsByLocation(candidates) };
};

export const analyzeCatamorphisms = (program: ts.Program, minWalkers = 2) =>
  memoizeByProgramAndKey(program, String(minWalkers), analysisCache, (p) =>
    computeCatamorphisms(p, minWalkers),
  );
