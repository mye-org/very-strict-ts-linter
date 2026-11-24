import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import * as S from "fp-ts/lib/string.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { memoizeByProgram, memoizeByProgramAndKey } from "../lib/program-memo.js";
import { collectProjectSourceFiles, normalizeFilePath } from "../lib/source-paths.js";
import { NamedTsFunction, extractNamedTsFunction } from "../lib/ts-named-function.js";
import { TsLocation, makeLocationKey, resolveTsNodeLocation } from "../lib/ts-node-location.js";
import { collectTsNodes } from "../lib/ts-node-traversal.js";
import { resolveTsTypeName } from "../lib/ts-type-name.js";

export type ContextDrillingFinding = Readonly<
  Record<"typeName" | "paramName", string> &
    Record<"depth", number> & {
      readonly chain: ReadonlyArray<string>;
      readonly rootLocation: TsLocation;
      readonly locations: ReadonlyArray<TsLocation>;
    }
>;

export type ContextDrillingAnalysis = Readonly<{
  readonly chains: ReadonlyArray<ContextDrillingFinding>;
  readonly locationIndex: Readonly<Record<string, ReadonlyArray<ContextDrillingFinding>>>;
}>;

type ParamSlot = Readonly<
  Record<"name" | "typeName", string> &
    Record<"index", number> & {
      readonly symbol: ts.Symbol;
    }
>;

type FunctionEntry = Readonly<
  Record<"key" | "name", string> & {
    readonly fnBody: ts.Node;
    readonly sf: ts.SourceFile;
    readonly location: TsLocation;
    readonly paramSlots: ReadonlyArray<ParamSlot>;
  }
>;

type SlotMeta = Readonly<
  Record<"fnKey" | "fnName" | "paramName" | "typeName", string> & {
    readonly location: TsLocation;
  }
>;

type ForwardEdge = Readonly<Record<"fromNode" | "toNode", string>>;

type ProgramGraph = Readonly<{
  readonly fnByKey: Readonly<Record<string, FunctionEntry>>;
  readonly slotMeta: Readonly<Record<string, SlotMeta>>;
  readonly outgoing: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly incomingCount: Readonly<Record<string, number>>;
}>;

type PathMemo = Readonly<Record<string, ReadonlyArray<string>>>;

type WalkEnv = Readonly<{
  readonly outgoing: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly visiting: ReadonlySet<string>;
}>;

type NeighborSweepState = Readonly<{
  readonly bestSuffix: ReadonlyArray<string>;
  readonly memo: PathMemo;
  readonly cycleStatus: "clean" | "cycle";
}>;

type LongestPathOutcome = Readonly<{
  readonly path: ReadonlyArray<string>;
  readonly memo: PathMemo;
}>;

type RootSweepState = Readonly<{
  readonly paths: ReadonlyArray<ReadonlyArray<string>>;
  readonly memo: PathMemo;
}>;

const graphCache = new WeakMap<ts.Program, ProgramGraph>();
const analysisCache = new WeakMap<ts.Program, Readonly<Record<string, ContextDrillingAnalysis>>>();

const EXCLUDED_CONTEXT_TYPES: ReadonlySet<string> = new Set([
  "Array",
  "ReadonlyArray",
  "Set",
  "ReadonlySet",
  "Map",
  "ReadonlyMap",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Option",
  "Either",
  "Task",
  "TaskEither",
  "IO",
  "IOEither",
  "Date",
  "RegExp",
  "Error",
  "Node",
  "SourceFile",
  "Program",
  "TypeChecker",
  "Symbol",
  "Type",
  "Expression",
  "Statement",
  "Declaration",
  "CallExpression",
  "ObjectExpression",
  "MemberExpression",
  "Identifier",
  "FunctionNode",
  "ParserServicesWithTypeInformation",
]);

const PRIMITIVE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.VoidLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Any |
  ts.TypeFlags.Unknown |
  ts.TypeFlags.Never;

const hasPrimitiveFlags = (type: ts.Type) => Boolean(type.flags & PRIMITIVE_FLAGS);

const isPrimitiveOrPrimitiveUnion = (type: ts.Type) =>
  hasPrimitiveFlags(type) || (type.isUnion() && RA.every(hasPrimitiveFlags)(type.types));

const isPureCallableType = (type: ts.Type) =>
  type.getCallSignatures().length > 0 && type.getProperties().length === 0;

const isContextObjectType = (type: ts.Type, checker: ts.TypeChecker) =>
  !isPrimitiveOrPrimitiveUnion(type) &&
  !checker.isArrayType(type) &&
  !checker.isTupleType(type) &&
  !isPureCallableType(type) &&
  type.getProperties().length > 0;

const resolveContextTypeLabel = (type: ts.Type, checker: ts.TypeChecker) =>
  O.match(
    () => (type.getProperties().length >= 2 ? O.some(checker.typeToString(type)) : O.none),
    (name: string) => (EXCLUDED_CONTEXT_TYPES.has(name) ? O.none : O.some(name)),
  )(resolveTsTypeName(type));

const resolveContextTypeName = (param: ts.ParameterDeclaration, checker: ts.TypeChecker) => {
  const type = checker.getTypeAtLocation(param);
  return isContextObjectType(type, checker) ? resolveContextTypeLabel(type, checker) : O.none;
};

const formatFnKey = (normalizedPath: string, name: string) => `${normalizedPath}::${name}`;

const makeFnKey = (sf: ts.SourceFile, name: string) =>
  formatFnKey(normalizeFilePath(sf.fileName), name);

const makeSlotKey = (fnKey: string, paramIndex: number) => `${fnKey}#${String(paramIndex)}`;

const resolveParamSymbol = (id: ts.Identifier, checker: ts.TypeChecker) =>
  O.fromNullable(checker.getSymbolAtLocation(id));

const extractParamSlot =
  (checker: ts.TypeChecker) => (param: ts.ParameterDeclaration, index: number) =>
    match(param)
      .with({ name: P.when(ts.isIdentifier) }, (p) => {
        const typeOpt = resolveContextTypeName(p, checker);
        const symOpt = resolveParamSymbol(p.name, checker);
        return O.isSome(typeOpt) && O.isSome(symOpt)
          ? O.some<ParamSlot>({
              index,
              name: p.name.text,
              typeName: typeOpt.value,
              symbol: symOpt.value,
            })
          : O.none;
      })
      .with(P._, () => O.none)
      .exhaustive();

const toParamArray = (params: ts.NodeArray<ts.ParameterDeclaration>) => Array.from(params);

const collectParamSlots = (
  params: ts.NodeArray<ts.ParameterDeclaration>,
  checker: ts.TypeChecker,
) =>
  RA.filterMapWithIndex((idx, p: ts.ParameterDeclaration) =>
    extractParamSlot(checker)(p, idx),
  )(toParamArray(params));

const buildFunctionEntry =
  (checker: ts.TypeChecker) => (spec: NamedTsFunction, sf: ts.SourceFile) => ({
    key: makeFnKey(sf, spec.name),
    name: spec.name,
    fnBody: spec.fnBody,
    sf,
    location: resolveTsNodeLocation(spec.locNode, sf),
    paramSlots: collectParamSlots(spec.paramNodes, checker),
  });

const extractNamedFunction =
  (checker: ts.TypeChecker) => (node: ts.Node, sf: ts.SourceFile) =>
    O.map((spec: NamedTsFunction) => buildFunctionEntry(checker)(spec, sf))(
      extractNamedTsFunction(node),
    );

const hasCallArgument = (call: ts.CallExpression, id: ts.Identifier) => call.arguments.includes(id);

const isDirectCallArgument = (id: ts.Identifier) =>
  ts.isCallExpression(id.parent) && hasCallArgument(id.parent, id);

const findParamReferences =
  (checker: ts.TypeChecker) => (fn: FunctionEntry, slot: ParamSlot) =>
    RA.filter(
      (n: ts.Node): n is ts.Identifier =>
        ts.isIdentifier(n) &&
        n.text === slot.name &&
        checker.getSymbolAtLocation(n) === slot.symbol,
    )(collectTsNodes(fn.fnBody, fn.sf));

const makeDeclFnKey = (decl: ts.Declaration, name: string) =>
  makeFnKey(decl.getSourceFile(), name);

const lookupDeclByName =
  (fnByKey: Readonly<Record<string, FunctionEntry>>) => (decl: ts.Declaration, name: string) =>
    RR.lookup(makeDeclFnKey(decl, name), fnByKey);

const lookupDeclEntry = (decl: ts.Declaration, fnByKey: Readonly<Record<string, FunctionEntry>>) =>
  match(decl)
    .when(ts.isFunctionDeclaration, (fn) =>
      fn.name ? lookupDeclByName(fnByKey)(fn, fn.name.text) : O.none,
    )
    .when(ts.isVariableDeclaration, (v) =>
      ts.isIdentifier(v.name) ? lookupDeclByName(fnByKey)(v, v.name.text) : O.none,
    )
    .otherwise(() => O.none);

const resolveAliasSymbol = (sym: ts.Symbol, checker: ts.TypeChecker) =>
  sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;

const resolveFirstSymbolDecl = flow(
  (sym: ts.Symbol) => O.fromNullable(sym.declarations),
  O.flatMap(RA.head),
);

const resolveValueDecl = flow(
  (sym: ts.Symbol) => sym.valueDeclaration,
  O.fromNullable,
);

const resolveSymbolDecl = flow(
  (sym: ts.Symbol) => ({ sym, valueDecl: resolveValueDecl(sym) }),
  ({ sym, valueDecl }) => O.alt(() => resolveFirstSymbolDecl(sym))(valueDecl),
);

const lookupCalleeSymbol = (call: ts.CallExpression, checker: ts.TypeChecker) =>
  O.fromNullable(checker.getSymbolAtLocation(call.expression));

type DrillingGraphEnv = Readonly<{
  fnByKey: Readonly<Record<string, FunctionEntry>>;
  checker: ts.TypeChecker;
}>;

const resolveCalleeFromSymbol = ({ fnByKey, checker }: DrillingGraphEnv) =>
  flow(
    (sym: ts.Symbol) => resolveAliasSymbol(sym, checker),
    resolveSymbolDecl,
    O.flatMap((decl: ts.Declaration) => lookupDeclEntry(decl, fnByKey)),
  );

const resolveCalleeFn = (call: ts.CallExpression, env: DrillingGraphEnv) =>
  O.flatMap(resolveCalleeFromSymbol(env))(lookupCalleeSymbol(call, env.checker));

const matchTargetSlotEdge =
  (fromNode: string, typeName: string) => (target: FunctionEntry, argIdx: number) =>
    O.map((targetSlot: ParamSlot) => ({
      fromNode,
      toNode: makeSlotKey(target.key, targetSlot.index),
    }))(
      RA.findFirst((p: ParamSlot) => p.index === argIdx && p.typeName === typeName)(
        target.paramSlots,
      ),
    );

const findArgumentIndex = (call: ts.CallExpression, id: ts.Identifier) =>
  call.arguments.indexOf(id);

const matchTargetWithSlot = (
  query: SlotEdgeQuery & Readonly<{ call: ts.CallExpression }>,
  target: FunctionEntry,
) =>
  matchTargetSlotEdge(makeSlotKey(query.fn.key, query.slot.index), query.slot.typeName)(
    target,
    findArgumentIndex(query.call, query.id),
  );

type SlotEdgeQuery = Readonly<{
  fn: FunctionEntry;
  slot: ParamSlot;
  id: ts.Identifier;
  fnByKey: Readonly<Record<string, FunctionEntry>>;
  checker: ts.TypeChecker;
}>;

const matchSlotEdgeWithCall = (query: SlotEdgeQuery) =>
  flow(
    (call: ts.CallExpression) => ({
      call,
      targetOpt: resolveCalleeFn(call, { fnByKey: query.fnByKey, checker: query.checker }),
    }),
    ({ call, targetOpt }) =>
      O.flatMap((target: FunctionEntry) =>
        target.key === query.fn.key
          ? O.none
          : matchTargetWithSlot({ ...query, call }, target),
      )(targetOpt),
  );

const toForwardEdge = (query: SlotEdgeQuery) =>
  match(query.id.parent)
    .when(ts.isCallExpression, (call) => matchSlotEdgeWithCall(query)(call))
    .otherwise(() => O.none);

const collectSlotEdges = (env: DrillingGraphEnv) => (fn: FunctionEntry, slot: ParamSlot) => {
  const refs = findParamReferences(env.checker)(fn, slot);
  return refs.length > 0 && RA.every(isDirectCallArgument)(refs)
    ? RA.filterMap((id: ts.Identifier) =>
        toForwardEdge({ fn, slot, id, fnByKey: env.fnByKey, checker: env.checker }),
      )(refs)
    : ([] satisfies ReadonlyArray<ForwardEdge>);
};

const indexFunctions = flow(
  RA.map((entry: FunctionEntry) => [entry.key, entry] as const),
  RR.fromEntries,
);

const expandFnSlotMeta = (fn: FunctionEntry) =>
  RA.map(
    (p: ParamSlot) =>
      [
        makeSlotKey(fn.key, p.index),
        {
          fnKey: fn.key,
          fnName: fn.name,
          paramName: p.name,
          typeName: p.typeName,
          location: fn.location,
        },
      ] as const,
  )(fn.paramSlots);

const indexSlotMeta = flow(RA.flatMap(expandFnSlotMeta), RR.fromEntries);

const extractUniqueTargets = flow(
  RA.map((edge: ForwardEdge) => edge.toNode),
  RA.uniq(S.Eq),
);

const buildOutgoingMap = flow(
  RNEA.groupBy((edge: ForwardEdge) => edge.fromNode),
  RR.map(extractUniqueTargets),
);

const buildIncomingCount = flow(
  RNEA.groupBy((edge: ForwardEdge) => edge.toNode),
  RR.map((group) => group.length),
);

const collectFileEntries = (sf: ts.SourceFile, checker: ts.TypeChecker) =>
  RA.filterMap((n: ts.Node) => extractNamedFunction(checker)(n, sf))(collectTsNodes(sf, sf));

const collectFnEdges = (env: DrillingGraphEnv) => (fn: FunctionEntry) =>
  RA.flatMap((slot: ParamSlot) => collectSlotEdges(env)(fn, slot))(fn.paramSlots);

const collectAllEdges = (entries: ReadonlyArray<FunctionEntry>, env: DrillingGraphEnv) =>
  RA.flatMap(collectFnEdges(env))(entries);

const buildProgramGraph = (program: ts.Program) => {
  const checker = program.getTypeChecker();
  const entries = RA.flatMap((sf: ts.SourceFile) => collectFileEntries(sf, checker))(
    collectProjectSourceFiles(program),
  );
  const fnByKey = indexFunctions(entries);
  const edges = collectAllEdges(entries, { fnByKey, checker });
  return {
    fnByKey,
    slotMeta: indexSlotMeta(entries),
    outgoing: buildOutgoingMap(edges),
    incomingCount: buildIncomingCount(edges),
  };
};

const resolveOutgoingNeighbors = (
  nodeId: string,
  outgoing: Readonly<Record<string, ReadonlyArray<string>>>,
) => O.getOrElseW(() => [])(RR.lookup(nodeId, outgoing));

const pickLongerPath = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  b.length > a.length ? b : a;

const addVisitingNode = (visiting: ReadonlySet<string>, nodeId: string) =>
  new Set([...visiting, nodeId]);

type PathWalkRequest = Readonly<
  Record<"nodeId", string> & {
    readonly env: WalkEnv;
    readonly memo: PathMemo;
  }
>;

const advanceNeighborState =
  (env: WalkEnv) => (state: NeighborSweepState, next: string) => {
    const child = walkLongestPath({ nodeId: next, env, memo: state.memo });
    return {
      bestSuffix: pickLongerPath(state.bestSuffix, child.path),
      memo: child.memo,
      cycleStatus: state.cycleStatus,
    };
  };

const sweepNeighbor = (env: WalkEnv) => (state: NeighborSweepState, next: string) =>
  env.visiting.has(next)
    ? { ...state, cycleStatus: "cycle" as const }
    : advanceNeighborState(env)(state, next);

const finalizeNodePath = (nodeId: string, outcome: NeighborSweepState) => {
  const path = [nodeId, ...outcome.bestSuffix];
  return match(outcome)
    .with({ cycleStatus: "clean" }, ({ memo }) => ({ path, memo: { ...memo, [nodeId]: path } }))
    .with({ cycleStatus: "cycle" }, ({ memo }) => ({ path, memo }))
    .exhaustive();
};

const enterNodeEnv = ({ env, nodeId }: PathWalkRequest) => ({
  outgoing: env.outgoing,
  visiting: addVisitingNode(env.visiting, nodeId),
});

const reduceNeighborsWithEnv = (nextEnv: WalkEnv, memo: PathMemo) =>
  RA.reduce<string, NeighborSweepState>(
    { bestSuffix: [], memo, cycleStatus: "clean" },
    sweepNeighbor(nextEnv),
  );

const computeLongestPath: (req: PathWalkRequest) => LongestPathOutcome = flow(
  (req: PathWalkRequest) => ({
    nodeId: req.nodeId,
    outcome: reduceNeighborsWithEnv(enterNodeEnv(req), req.memo)(
      resolveOutgoingNeighbors(req.nodeId, req.env.outgoing),
    ),
  }),
  ({ nodeId, outcome }) => finalizeNodePath(nodeId, outcome),
);

const lookupMemoPath = (req: PathWalkRequest) => RR.lookup(req.nodeId, req.memo);

const walkLongestPath: (req: PathWalkRequest) => LongestPathOutcome = flow(
  (req: PathWalkRequest) => ({ req, memoPath: lookupMemoPath(req) }),
  ({ req, memoPath }) =>
    O.match(
      () => computeLongestPath(req),
      (path: ReadonlyArray<string>) => ({ path, memo: req.memo }),
    )(memoPath),
);

const lookupSlotMeta = (id: string, slotMeta: Readonly<Record<string, SlotMeta>>) =>
  RR.lookup(id, slotMeta);

type PathView = Readonly<{
  readonly path: ReadonlyArray<string>;
  readonly slotMeta: Readonly<Record<string, SlotMeta>>;
}>;

const lookupSlotFnName = (slotMeta: Readonly<Record<string, SlotMeta>>) =>
  flow(
    (id: string) => lookupSlotMeta(id, slotMeta),
    O.map((meta) => meta.fnName),
  );

const lookupSlotLocation = (slotMeta: Readonly<Record<string, SlotMeta>>) =>
  flow(
    (id: string) => lookupSlotMeta(id, slotMeta),
    O.map((meta) => meta.location),
  );

const extractChainNames = ({ path, slotMeta }: PathView) =>
  RA.filterMap(lookupSlotFnName(slotMeta))(path);

const extractChainLocations = ({ path, slotMeta }: PathView) =>
  RA.filterMap(lookupSlotLocation(slotMeta))(path);

const buildFindingFromRoot = (rootMeta: SlotMeta, view: PathView) => ({
  typeName: rootMeta.typeName,
  paramName: rootMeta.paramName,
  depth: view.path.length - 1,
  chain: extractChainNames(view),
  rootLocation: rootMeta.location,
  locations: extractChainLocations(view),
});

const resolveFindingFromRootId = (path: ReadonlyArray<string>, graph: ProgramGraph) =>
  flow(
    (rootId: string) => lookupSlotMeta(rootId, graph.slotMeta),
    O.map((rootMeta: SlotMeta) => buildFindingFromRoot(rootMeta, { path, slotMeta: graph.slotMeta })),
  );

const pathToFinding = (path: ReadonlyArray<string>, graph: ProgramGraph) =>
  O.flatMap(resolveFindingFromRootId(path, graph))(O.fromNullable(path[0]));

const indexChainsByLocation = RNEA.groupBy((f: ContextDrillingFinding) =>
  makeLocationKey(f.rootLocation),
);

const lookupIncomingCount = (incomingCount: Readonly<Record<string, number>>, nodeId: string) =>
  O.getOrElse(() => 0)(RR.lookup(nodeId, incomingCount));

const collectRootNodeIds = flow(
  (graph: ProgramGraph) => ({
    keys: RR.keys(graph.outgoing),
    incomingCount: graph.incomingCount,
  }),
  ({ keys, incomingCount }) =>
    RA.filter((nodeId: string) => lookupIncomingCount(incomingCount, nodeId) === 0)(keys),
);

const appendRootLongestPath =
  (outgoing: Readonly<Record<string, ReadonlyArray<string>>>) =>
  (state: RootSweepState, nodeId: string) => {
    const outcome = walkLongestPath({ nodeId, env: { outgoing, visiting: new Set() }, memo: state.memo });
    return {
      paths: [...state.paths, outcome.path],
      memo: outcome.memo,
    };
  };

const EMPTY_ROOT_SWEEP: RootSweepState = { paths: [], memo: {} };

const collectRootLongestPaths = (graph: ProgramGraph) =>
  RA.reduce(EMPTY_ROOT_SWEEP, appendRootLongestPath(graph.outgoing))(
    collectRootNodeIds(graph),
  ).paths;

const buildDrillingAnalysis = (chains: ReadonlyArray<ContextDrillingFinding>) => ({
  chains,
  locationIndex: indexChainsByLocation(chains),
});

const filterDeepPaths = (minDepth: number) =>
  flow(
    collectRootLongestPaths,
    RA.filter((path: ReadonlyArray<string>) => path.length - 1 >= minDepth),
  );

const analyzeProgramGraph = (minDepth: number) =>
  flow(
    (graph: ProgramGraph) => ({ graph, paths: filterDeepPaths(minDepth)(graph) }),
    ({ graph, paths }) =>
      buildDrillingAnalysis(
        RA.filterMap((path: ReadonlyArray<string>) => pathToFinding(path, graph))(paths),
      ),
  );

const computeContextDrillingForMinDepth = (minDepth: number) =>
  flow(memoizeByProgram(graphCache, buildProgramGraph), analyzeProgramGraph(minDepth));

const makeDrillingCacheKey = (minDepth: number) => String(minDepth);

export const analyzeContextDrilling = ((program: ts.Program, minDepth = 3) =>
  memoizeByProgramAndKey(
    analysisCache,
    computeContextDrillingForMinDepth(minDepth),
  )(program, makeDrillingCacheKey(minDepth))) satisfies (
  program: ts.Program,
  minDepth?: number,
) => ContextDrillingAnalysis;
