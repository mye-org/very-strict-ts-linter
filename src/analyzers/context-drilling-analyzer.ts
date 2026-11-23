import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { flow, pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import {
  getProjectSourceFiles,
  memoizeByProgram,
  memoizeByProgramAndKey,
  normalizeFilePath,
} from "../utils/program-cache.js";
import {
  collectTsNodes,
  extractNamedTsFunction,
  getTsNodeLocation,
  makeLocationKey,
  NamedTsFunction,
  TsLocation,
} from "../utils/ts-ast-helpers.js";
import { getTsTypeName } from "../utils/type-helpers.js";

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
  readonly nodeInfo: Readonly<Record<string, SlotMeta>>;
  readonly outgoing: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly incomingCount: Readonly<Record<string, number>>;
}>;

const graphCache = new WeakMap<ts.Program, ProgramGraph>();
const analysisCache = new WeakMap<ts.Program, Readonly<Record<string, ContextDrillingAnalysis>>>();

const EXCLUDED_CONTEXT_TYPES = new Set([
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

const isPrimitiveOrPrimitiveUnion = (type: ts.Type) =>
  Boolean(type.flags & PRIMITIVE_FLAGS) ||
  (type.isUnion() && pipe(type.types, RA.every((m) => Boolean(m.flags & PRIMITIVE_FLAGS))));

const isPureCallableType = (type: ts.Type) =>
  type.getCallSignatures().length > 0 && type.getProperties().length === 0;

const isContextObjectType = (type: ts.Type, checker: ts.TypeChecker) =>
  !isPrimitiveOrPrimitiveUnion(type) &&
  !checker.isArrayType(type) &&
  !checker.isTupleType(type) &&
  !isPureCallableType(type) &&
  type.getProperties().length > 0;

const resolveContextTypeLabel = (type: ts.Type, checker: ts.TypeChecker) =>
  pipe(
    getTsTypeName(type),
    O.match(
      () => (type.getProperties().length >= 2 ? O.some(checker.typeToString(type)) : O.none),
      (name) => (EXCLUDED_CONTEXT_TYPES.has(name) ? O.none : O.some(name)),
    ),
  );

const getContextTypeName = (param: ts.ParameterDeclaration, checker: ts.TypeChecker) => {
  const type = checker.getTypeAtLocation(param);
  return isContextObjectType(type, checker) ? resolveContextTypeLabel(type, checker) : O.none;
};

const makeFnKey = (sf: ts.SourceFile, name: string) =>
  `${normalizeFilePath(sf.fileName)}::${name}`;

const makeSlotKey = (fnKey: string, paramIndex: number) => `${fnKey}#${String(paramIndex)}`;

const getParamSymbol = (id: ts.Identifier, checker: ts.TypeChecker) =>
  O.fromNullable(checker.getSymbolAtLocation(id));

const extractParamSlot = (
  param: ts.ParameterDeclaration,
  index: number,
  checker: ts.TypeChecker,
) =>
  ts.isIdentifier(param.name)
    ? pipe(
        O.Do,
        O.apS("typeName", getContextTypeName(param, checker)),
        O.apS("symbol", getParamSymbol(param.name, checker)),
        O.map(({ typeName, symbol }) => ({
          index,
          name: (param.name as ts.Identifier).text,
          typeName,
          symbol,
        })),
      )
    : O.none;

const buildFunctionEntry = (spec: NamedTsFunction, sf: ts.SourceFile, checker: ts.TypeChecker) => ({
  key: makeFnKey(sf, spec.name),
  name: spec.name,
  fnBody: spec.fnBody,
  sf,
  location: getTsNodeLocation(spec.locNode, sf),
  paramSlots: pipe(
    Array.from(spec.paramNodes),
    RA.filterMapWithIndex((idx, p) => extractParamSlot(p, idx, checker)),
  ),
});

const extractNamedFunction = (node: ts.Node, sf: ts.SourceFile, checker: ts.TypeChecker) =>
  pipe(
    extractNamedTsFunction(node),
    O.map((spec) => buildFunctionEntry(spec, sf, checker)),
  );

const isDirectCallArgument = (id: ts.Identifier) =>
  ts.isCallExpression(id.parent) && id.parent.arguments.includes(id);

const findParamReferences = (fn: FunctionEntry, slot: ParamSlot, checker: ts.TypeChecker) =>
  pipe(
    collectTsNodes(fn.fnBody, fn.sf),
    RA.filter(
      (n): n is ts.Identifier =>
        ts.isIdentifier(n) &&
        n.text === slot.name &&
        checker.getSymbolAtLocation(n) === slot.symbol,
    ),
  );

const lookupDeclEntry = (decl: ts.Declaration, fnByKey: Readonly<Record<string, FunctionEntry>>) =>
  match(decl)
    .when(ts.isFunctionDeclaration, (fn) =>
      fn.name ? O.fromNullable(fnByKey[makeFnKey(fn.getSourceFile(), fn.name.text)]) : O.none,
    )
    .when(ts.isVariableDeclaration, (v) =>
      ts.isIdentifier(v.name)
        ? O.fromNullable(fnByKey[makeFnKey(v.getSourceFile(), v.name.text)])
        : O.none,
    )
    .otherwise(() => O.none);

const resolveAliasSymbol = (sym: ts.Symbol, checker: ts.TypeChecker) =>
  sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;

const resolveCalleeFn = (
  call: ts.CallExpression,
  fnByKey: Readonly<Record<string, FunctionEntry>>,
  checker: ts.TypeChecker,
) =>
  pipe(
    O.fromNullable(checker.getSymbolAtLocation(call.expression)),
    O.map((sym) => resolveAliasSymbol(sym, checker)),
    O.flatMap((sym) => O.fromNullable(sym.valueDeclaration ?? sym.declarations?.[0])),
    O.flatMap((decl) => lookupDeclEntry(decl, fnByKey)),
  );

const matchTargetSlotEdge = (
  fromNode: string,
  target: FunctionEntry,
  argIdx: number,
  typeName: string,
) =>
  pipe(
    target.paramSlots,
    RA.findFirst((p) => p.index === argIdx && p.typeName === typeName),
    O.map((targetSlot) => ({ fromNode, toNode: makeSlotKey(target.key, targetSlot.index) })),
  );

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
    call.arguments.indexOf(id),
    slot.typeName,
  );

const toForwardEdge = (
  id: ts.Identifier,
  fn: FunctionEntry,
  slot: ParamSlot,
  fnByKey: Readonly<Record<string, FunctionEntry>>,
  checker: ts.TypeChecker,
) => {
  const call = id.parent as ts.CallExpression;
  return pipe(
    resolveCalleeFn(call, fnByKey, checker),
    O.filter((target) => target.key !== fn.key),
    O.flatMap((target) => matchTargetWithSlot(fn, slot, call, id, target)),
  );
};

const collectSlotEdges = (
  fn: FunctionEntry,
  slot: ParamSlot,
  fnByKey: Readonly<Record<string, FunctionEntry>>,
  checker: ts.TypeChecker,
) => {
  const refs = findParamReferences(fn, slot, checker);
  return refs.length > 0 && pipe(refs, RA.every(isDirectCallArgument))
    ? pipe(refs, RA.filterMap((id) => toForwardEdge(id, fn, slot, fnByKey, checker)))
    : ([] as ReadonlyArray<ForwardEdge>);
};

const indexFunctions = (entries: ReadonlyArray<FunctionEntry>) => {
  const index: Record<string, FunctionEntry> = {};
  for (const entry of entries) {
    index[entry.key] = entry;
  }
  return index as Readonly<Record<string, FunctionEntry>>;
};

const indexNodeInfo = (entries: ReadonlyArray<FunctionEntry>) => {
  const index: Record<string, SlotMeta> = {};
  for (const fn of entries) {
    for (const p of fn.paramSlots) {
      index[makeSlotKey(fn.key, p.index)] = {
        fnKey: fn.key,
        fnName: fn.name,
        paramName: p.name,
        typeName: p.typeName,
        location: fn.location,
      };
    }
  }
  return index as Readonly<Record<string, SlotMeta>>;
};

const buildOutgoingMap = (edges: ReadonlyArray<ForwardEdge>) => {
  const map: Record<string, Array<string>> = {};
  const seen: Record<string, Set<string>> = {};
  for (const edge of edges) {
    const targetSet = seen[edge.fromNode] ?? new Set<string>();
    if (!targetSet.has(edge.toNode)) {
      targetSet.add(edge.toNode);
      seen[edge.fromNode] = targetSet;
      const list = map[edge.fromNode] ?? [];
      list.push(edge.toNode);
      map[edge.fromNode] = list;
    }
  }
  return map as Readonly<Record<string, ReadonlyArray<string>>>;
};

const buildIncomingCount = (edges: ReadonlyArray<ForwardEdge>) => {
  const counts: Record<string, number> = {};
  for (const edge of edges) {
    counts[edge.toNode] = (counts[edge.toNode] ?? 0) + 1;
  }
  return counts as Readonly<Record<string, number>>;
};

const collectFileEntries = (sf: ts.SourceFile, checker: ts.TypeChecker) =>
  pipe(
    collectTsNodes(sf, sf),
    RA.filterMap((n) => extractNamedFunction(n, sf, checker)),
  );

const collectFnEdges = (
  fn: FunctionEntry,
  fnByKey: Readonly<Record<string, FunctionEntry>>,
  checker: ts.TypeChecker,
) => pipe(fn.paramSlots, RA.flatMap((slot) => collectSlotEdges(fn, slot, fnByKey, checker)));

const collectAllEdges = (
  entries: ReadonlyArray<FunctionEntry>,
  fnByKey: Readonly<Record<string, FunctionEntry>>,
  checker: ts.TypeChecker,
) => pipe(entries, RA.flatMap((fn) => collectFnEdges(fn, fnByKey, checker)));

const buildProgramGraph = (program: ts.Program) => {
  const checker = program.getTypeChecker();
  const entries = pipe(
    getProjectSourceFiles(program),
    RA.flatMap((sf) => collectFileEntries(sf, checker)),
  );
  const fnByKey = indexFunctions(entries);
  const edges = collectAllEdges(entries, fnByKey, checker);
  return {
    fnByKey,
    nodeInfo: indexNodeInfo(entries),
    outgoing: buildOutgoingMap(edges),
    incomingCount: buildIncomingCount(edges),
  };
};

const getOutgoingNeighbors = (
  nodeId: string,
  outgoing: Readonly<Record<string, ReadonlyArray<string>>>,
) =>
  pipe(
    RR.lookup(nodeId, outgoing),
    O.getOrElse(() => [] as ReadonlyArray<string>),
  );

const findLongestPathMemoized = (
  startId: string,
  outgoing: Readonly<Record<string, ReadonlyArray<string>>>,
  memo: Map<string, ReadonlyArray<string>>,
): ReadonlyArray<string> => {
  const visiting = new Set<string>();
  const dfs = (nodeId: string): ReadonlyArray<string> => {
    const cached = memo.get(nodeId);
    if (cached) return cached;
    visiting.add(nodeId);
    let bestSuffix: ReadonlyArray<string> = [];
    let hitCycle = false;
    for (const next of getOutgoingNeighbors(nodeId, outgoing)) {
      if (visiting.has(next)) {
        hitCycle = true;
        continue;
      }
      const candidate = dfs(next);
      if (candidate.length > bestSuffix.length) {
        bestSuffix = candidate;
      }
    }
    visiting.delete(nodeId);
    const result = [nodeId, ...bestSuffix];
    if (!hitCycle) {
      memo.set(nodeId, result);
    }
    return result;
  };
  return dfs(startId);
};

const lookupSlotMeta = (id: string, nodeInfo: Readonly<Record<string, SlotMeta>>) =>
  RR.lookup(id, nodeInfo);

type PathView = Readonly<{
  readonly path: ReadonlyArray<string>;
  readonly nodeInfo: Readonly<Record<string, SlotMeta>>;
}>;

const extractChainNames = ({ path, nodeInfo }: PathView) =>
  pipe(
    path,
    RA.filterMap(flow((id) => lookupSlotMeta(id, nodeInfo), O.map((info) => info.fnName))),
  );

const extractChainLocations = ({ path, nodeInfo }: PathView) =>
  pipe(
    path,
    RA.filterMap(flow((id) => lookupSlotMeta(id, nodeInfo), O.map((info) => info.location))),
  );

const buildFindingFromRoot = (rootInfo: SlotMeta, view: PathView) => ({
  typeName: rootInfo.typeName,
  paramName: rootInfo.paramName,
  depth: view.path.length - 1,
  chain: extractChainNames(view),
  rootLocation: rootInfo.location,
  locations: extractChainLocations(view),
});

const pathToFinding = (path: ReadonlyArray<string>, graph: ProgramGraph) =>
  pipe(
    O.fromNullable(path[0]),
    O.flatMap((rootId) => lookupSlotMeta(rootId, graph.nodeInfo)),
    O.map((rootInfo) => buildFindingFromRoot(rootInfo, { path, nodeInfo: graph.nodeInfo })),
  );

const indexChainsByLocation = (chains: ReadonlyArray<ContextDrillingFinding>) => {
  const index: Record<string, Array<ContextDrillingFinding>> = {};
  for (const f of chains) {
    const key = makeLocationKey(f.rootLocation);
    const list = index[key] ?? [];
    list.push(f);
    index[key] = list;
  }
  return index as Readonly<Record<string, ReadonlyArray<ContextDrillingFinding>>>;
};

const computeContextDrilling = (program: ts.Program, minDepth: number) => {
  const graph = memoizeByProgram(program, graphCache, buildProgramGraph);
  const memo = new Map<string, ReadonlyArray<string>>();
  const chains = pipe(
    RR.keys(graph.outgoing),
    RA.filterMap((nodeId) =>
      (graph.incomingCount[nodeId] ?? 0) === 0
        ? O.some(findLongestPathMemoized(nodeId, graph.outgoing, memo))
        : O.none,
    ),
    RA.filter((path) => path.length - 1 >= minDepth),
    RA.filterMap((path) => pathToFinding(path, graph)),
  );
  return { chains, locationIndex: indexChainsByLocation(chains) };
};

export const analyzeContextDrilling = (program: ts.Program, minDepth = 3) =>
  memoizeByProgramAndKey(program, String(minDepth), analysisCache, (p) =>
    computeContextDrilling(p, minDepth),
  );
