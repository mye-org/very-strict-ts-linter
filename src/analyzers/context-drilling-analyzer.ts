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

const extractParamSlot = (
  param: ts.ParameterDeclaration,
  index: number,
  checker: ts.TypeChecker,
) =>
  match(param.name)
    .when(ts.isIdentifier, (paramId) => {
      const typeOpt = resolveContextTypeName(param, checker);
      const symOpt = resolveParamSymbol(paramId, checker);
      return O.isSome(typeOpt) && O.isSome(symOpt)
        ? O.some<ParamSlot>({
            index,
            name: paramId.text,
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
  RA.filterMapWithIndex((idx, p: ts.ParameterDeclaration) => extractParamSlot(p, idx, checker))(
    toParamArray(params),
  );

const buildFunctionEntry = (spec: NamedTsFunction, sf: ts.SourceFile, checker: ts.TypeChecker) => ({
  key: makeFnKey(sf, spec.name),
  name: spec.name,
  fnBody: spec.fnBody,
  sf,
  location: resolveTsNodeLocation(spec.locNode, sf),
  paramSlots: collectParamSlots(spec.paramNodes, checker),
});

const extractNamedFunction = (node: ts.Node, sf: ts.SourceFile, checker: ts.TypeChecker) =>
  O.map((spec: NamedTsFunction) => buildFunctionEntry(spec, sf, checker))(
    extractNamedTsFunction(node),
  );

const hasCallArgument = (call: ts.CallExpression, id: ts.Identifier) => call.arguments.includes(id);

const isDirectCallArgument = (id: ts.Identifier) =>
  ts.isCallExpression(id.parent) && hasCallArgument(id.parent, id);

const findParamReferences = (fn: FunctionEntry, slot: ParamSlot, checker: ts.TypeChecker) =>
  RA.filter(
    (n: ts.Node): n is ts.Identifier =>
      ts.isIdentifier(n) &&
      n.text === slot.name &&
      checker.getSymbolAtLocation(n) === slot.symbol,
  )(collectTsNodes(fn.fnBody, fn.sf));

const makeDeclFnKey = (decl: ts.Declaration, name: string) =>
  makeFnKey(decl.getSourceFile(), name);

const lookupDeclByName = (
  decl: ts.Declaration,
  name: string,
  fnByKey: Readonly<Record<string, FunctionEntry>>,
) => RR.lookup(makeDeclFnKey(decl, name), fnByKey);

const lookupDeclEntry = (decl: ts.Declaration, fnByKey: Readonly<Record<string, FunctionEntry>>) =>
  match(decl)
    .when(ts.isFunctionDeclaration, (fn) =>
      fn.name ? lookupDeclByName(fn, fn.name.text, fnByKey) : O.none,
    )
    .when(ts.isVariableDeclaration, (v) =>
      ts.isIdentifier(v.name) ? lookupDeclByName(v, v.name.text, fnByKey) : O.none,
    )
    .otherwise(() => O.none);

const resolveAliasSymbol = (sym: ts.Symbol, checker: ts.TypeChecker) =>
  sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;

const resolveSymbolDecl = (sym: ts.Symbol) =>
  O.fromNullable(sym.valueDeclaration ?? sym.declarations?.[0]);

const lookupCalleeSymbol = (call: ts.CallExpression, checker: ts.TypeChecker) =>
  O.fromNullable(checker.getSymbolAtLocation(call.expression));

const resolveCalleeFromSymbol = (
  fnByKey: Readonly<Record<string, FunctionEntry>>,
  checker: ts.TypeChecker,
) =>
  flow(
    (sym: ts.Symbol) => resolveAliasSymbol(sym, checker),
    resolveSymbolDecl,
    O.flatMap((decl: ts.Declaration) => lookupDeclEntry(decl, fnByKey)),
  );

const resolveCalleeFn = (
  call: ts.CallExpression,
  fnByKey: Readonly<Record<string, FunctionEntry>>,
  checker: ts.TypeChecker,
) => O.flatMap(resolveCalleeFromSymbol(fnByKey, checker))(lookupCalleeSymbol(call, checker));

const matchTargetSlotEdge = (
  fromNode: string,
  target: FunctionEntry,
  argIdx: number,
  typeName: string,
) =>
  O.map((targetSlot: ParamSlot) => ({
    fromNode,
    toNode: makeSlotKey(target.key, targetSlot.index),
  }))(
    RA.findFirst((p: ParamSlot) => p.index === argIdx && p.typeName === typeName)(target.paramSlots),
  );

const findArgumentIndex = (call: ts.CallExpression, id: ts.Identifier) =>
  call.arguments.indexOf(id);

const matchTargetWithSlot = (
  fn: FunctionEntry,
  slot: ParamSlot,
  call: ts.CallExpression,
  id: ts.Identifier,
  target: FunctionEntry,
) =>
  matchTargetSlotEdge(
    makeSlotKey(fn.key, slot.index),
    target,
    findArgumentIndex(call, id),
    slot.typeName,
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
      targetOpt: resolveCalleeFn(call, query.fnByKey, query.checker),
    }),
    ({ call, targetOpt }) =>
      O.flatMap((target: FunctionEntry) =>
        target.key === query.fn.key
          ? O.none
          : matchTargetWithSlot(query.fn, query.slot, call, query.id, target),
      )(targetOpt),
  );

const toForwardEdge = (query: SlotEdgeQuery) =>
  match(query.id.parent)
    .when(ts.isCallExpression, (call) => matchSlotEdgeWithCall(query)(call))
    .otherwise(() => O.none);

const collectSlotEdges = (
  fn: FunctionEntry,
  slot: ParamSlot,
  fnByKey: Readonly<Record<string, FunctionEntry>>,
  checker: ts.TypeChecker,
) => {
  const refs = findParamReferences(fn, slot, checker);
  return refs.length > 0 && RA.every(isDirectCallArgument)(refs)
    ? RA.filterMap((id: ts.Identifier) => toForwardEdge({ fn, slot, id, fnByKey, checker }))(refs)
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
  RA.filterMap((n: ts.Node) => extractNamedFunction(n, sf, checker))(collectTsNodes(sf, sf));

const collectFnEdges = (
  fn: FunctionEntry,
  fnByKey: Readonly<Record<string, FunctionEntry>>,
  checker: ts.TypeChecker,
) => RA.flatMap((slot: ParamSlot) => collectSlotEdges(fn, slot, fnByKey, checker))(fn.paramSlots);

const collectAllEdges = (
  entries: ReadonlyArray<FunctionEntry>,
  fnByKey: Readonly<Record<string, FunctionEntry>>,
  checker: ts.TypeChecker,
) => RA.flatMap((fn: FunctionEntry) => collectFnEdges(fn, fnByKey, checker))(entries);

const buildProgramGraph = (program: ts.Program) => {
  const checker = program.getTypeChecker();
  const entries = RA.flatMap((sf: ts.SourceFile) => collectFileEntries(sf, checker))(
    collectProjectSourceFiles(program),
  );
  const fnByKey = indexFunctions(entries);
  const edges = collectAllEdges(entries, fnByKey, checker);
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

const advanceNeighborState = (
  state: NeighborSweepState,
  next: string,
  env: WalkEnv,
) => {
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
    : advanceNeighborState(state, next, env);

const finalizeNodePath = (nodeId: string, outcome: NeighborSweepState) => {
  const path = [nodeId, ...outcome.bestSuffix];
  return match(outcome.cycleStatus)
    .with("clean", () => ({ path, memo: { ...outcome.memo, [nodeId]: path } }))
    .with("cycle", () => ({ path, memo: outcome.memo }))
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

const collectRootNodeIds = flow(
  (graph: ProgramGraph) => ({
    keys: RR.keys(graph.outgoing),
    incomingCount: graph.incomingCount,
  }),
  ({ keys, incomingCount }) => RA.filter((nodeId: string) => (incomingCount[nodeId] ?? 0) === 0)(keys),
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
  flow(
    (program: ts.Program) => memoizeByProgram(program, graphCache, buildProgramGraph),
    analyzeProgramGraph(minDepth),
  );

const makeDrillingCacheKey = (minDepth: number) => String(minDepth);

export const analyzeContextDrilling = (
  program: ts.Program,
  minDepth = 3,
): ContextDrillingAnalysis =>
  memoizeByProgramAndKey(
    program,
    makeDrillingCacheKey(minDepth),
    analysisCache,
    computeContextDrillingForMinDepth(minDepth),
  );
