import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as S from "fp-ts/lib/string.js";
import { pipe } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import {
  getProjectSourceFiles,
  isMatchingAnyPattern,
  memoizeByProgramAndKey,
  normalizeFilePath,
} from "../utils/program-cache.js";
import { getTsNodeLocation, makeLocationKey } from "../utils/ts-ast-helpers.js";
import {
  DEFAULT_TEST_PATTERNS,
  extractFileRuntimeExports,
  isBarrelFile,
  resolveCanonicalSymbol,
  unwrapExpression,
} from "./module-symbol-graph.js";

export type TestClassification =
  | "component"
  | "composition"
  | "system-invariant"
  | "potentially-redundant";

export type TestScopeOptions = Readonly<{
  readonly testPatterns: ReadonlyArray<string>;
  readonly minRepeatedCases: number;
  readonly minDelegatedCases: number;
  readonly minUnrelatedComponents: number;
  readonly checkSameLevelDuplicates: "enabled" | "disabled";
}>;

export type RedundantCrossLevelFinding = Readonly<
  Record<"kind", "redundantCrossLevelTest"> &
    Record<
      "testName" | "fileName" | "locationKey" | "property" | "higherComponent" | "lowerComponent",
      string
    > &
    Record<"line", number> & {
      readonly existingTests: ReadonlyArray<string>;
      readonly confidence: "high" | "medium";
    }
>;

export type DuplicateSameLevelFinding = Readonly<
  Record<"kind", "duplicateSameLevelTest"> &
    Record<"testName" | "fileName" | "locationKey" | "targetComponent" | "primaryTest", string> &
    Record<"line", number>
>;

export type RedundantTestFinding = RedundantCrossLevelFinding | DuplicateSameLevelFinding;

export type LowestLevelFinding = Readonly<
  Record<
    "testName" | "fileName" | "locationKey" | "property" | "higherComponent" | "lowerComponent",
    string
  > &
    Record<"line" | "caseCount", number>
>;

export type SingleResponsibilityFinding = Readonly<
  Record<"testName" | "fileName" | "locationKey", string> &
    Record<"line", number> & {
      readonly groups: ReadonlyArray<ReadonlyArray<string>>;
    }
>;

export type TestCaseSummary = Readonly<
  Record<"id" | "name" | "fullName" | "fileName" | "locationKey", string> &
    Record<"line", number> & {
      readonly classification: TestClassification;
      readonly directTargets: ReadonlyArray<string>;
      readonly mockedTargets: ReadonlyArray<string>;
    }
>;

export type TestScopeAnalysis = Readonly<{
  readonly tests: ReadonlyArray<TestCaseSummary>;
  readonly redundancyByFile: Readonly<Record<string, ReadonlyArray<RedundantTestFinding>>>;
  readonly lowestLevelByFile: Readonly<Record<string, ReadonlyArray<LowestLevelFinding>>>;
  readonly responsibilityByFile: Readonly<Record<string, ReadonlyArray<SingleResponsibilityFinding>>>;
}>;

export const DEFAULT_TEST_SCOPE_OPTIONS: TestScopeOptions = {
  testPatterns: DEFAULT_TEST_PATTERNS,
  minRepeatedCases: 2,
  minDelegatedCases: 2,
  minUnrelatedComponents: 2,
  checkSameLevelDuplicates: "enabled",
};

// ---------------------------------------------------------------------------
// Internal Models
// ---------------------------------------------------------------------------

type ProductionComponent = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly fileName: string;
  readonly line: number;
  readonly isExported: boolean;
  readonly symbol: O.Option<ts.Symbol>;
  readonly fnNode: ts.FunctionLikeDeclaration;
  readonly directCallees: ReadonlyArray<string>;
  readonly transitiveCallees: ReadonlyArray<string>;
  readonly returnFieldProvenance: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly directReturnProvenance: ReadonlyArray<string>;
  readonly errorProvenance: ReadonlyArray<string>;
}>;

type ProductionGraph = Readonly<{
  readonly componentsById: Readonly<Record<string, ProductionComponent>>;
  readonly idBySymbol: ReadonlyMap<ts.Symbol, string>;
  readonly idsByFile: Readonly<Record<string, ReadonlyArray<string>>>;
}>;

type AssertionCategory =
  | "equality"
  | "error"
  | "spy-interaction"
  | "predicate"
  | "containment"
  | "shape"
  | "other";

type ExtractedAssertion = Readonly<{
  readonly category: AssertionCategory;
  readonly matcher: string;
  readonly subjectComponentId: O.Option<string>;
  readonly projectedPath: ReadonlyArray<string>;
  readonly inputFingerprint: O.Option<string>;
  readonly expectedFingerprint: O.Option<string>;
  readonly expectedObjectKeys: ReadonlyArray<string>;
  readonly referencedComponents: ReadonlyArray<string>;
  readonly referencedSubjectFields: ReadonlyArray<string>;
}>;

type DataflowEdge = Readonly<{
  readonly fromComponentId: string;
  readonly toComponentId: string;
}>;

type ExtractedTestCase = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly fullName: string;
  readonly fileName: string;
  readonly line: number;
  readonly locationKey: string;
  readonly eachCount: number;
  readonly directTargets: ReadonlyArray<string>;
  readonly mockedTargets: ReadonlyArray<string>;
  readonly assertions: ReadonlyArray<ExtractedAssertion>;
  readonly dataflowEdges: ReadonlyArray<DataflowEdge>;
}>;

type InferredPropertyKind =
  | "interaction"
  | "system-invariant"
  | "composition"
  | "projected-output"
  | "delegated-error"
  | "direct-passthrough"
  | "component-behavior";

type InferredProperty = Readonly<{
  readonly kind: InferredPropertyKind;
  readonly directTargetId: string;
  readonly ownerComponentId: string;
  readonly label: string;
  readonly assertion: ExtractedAssertion;
}>;

type ClassifiedTestCase = Readonly<{
  readonly test: ExtractedTestCase;
  readonly properties: ReadonlyArray<InferredProperty>;
  readonly classification: TestClassification;
}>;

// ---------------------------------------------------------------------------
// AST & Symbol Utilities
// ---------------------------------------------------------------------------

const TEST_FN_NAMES = new Set(["it", "test"]);
const DESCRIBE_FN_NAMES = new Set(["describe", "suite"]);
const MOCK_RUNNER_NAMES = new Set(["vi", "jest"]);

const SPY_MATCHERS = new Set([
  "toHaveBeenCalled",
  "toHaveBeenCalledTimes",
  "toHaveBeenCalledWith",
  "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith",
  "toHaveReturned",
  "toHaveReturnedTimes",
  "toHaveReturnedWith",
  "toHaveLastReturnedWith",
  "toHaveNthReturnedWith",
]);

const EQUALITY_MATCHERS = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toBeCloseTo",
  "equal",
  "strictEqual",
  "deepEqual",
  "deepStrictEqual",
]);

const ERROR_MATCHERS = new Set([
  "toThrow",
  "toThrowError",
  "toThrowErrorMatchingSnapshot",
  "toThrowErrorMatchingInlineSnapshot",
  "throws",
  "rejects",
]);

const PREDICATE_MATCHERS = new Set([
  "toBeTruthy",
  "toBeFalsy",
  "toBeDefined",
  "toBeUndefined",
  "toBeNull",
  "toBeNaN",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "ok",
]);

const CONTAINMENT_MATCHERS = new Set([
  "toContain",
  "toContainEqual",
  "toMatch",
  "toHaveLength",
  "match",
]);

const SHAPE_MATCHERS = new Set(["toMatchObject", "toHaveProperty", "toBeInstanceOf"]);

const MOCK_IMPL_METHODS = new Set([
  "mockReturnValue",
  "mockReturnValueOnce",
  "mockResolvedValue",
  "mockResolvedValueOnce",
  "mockRejectedValue",
  "mockRejectedValueOnce",
  "mockImplementation",
  "mockImplementationOnce",
]);

const FP_ERROR_CHECK_METHODS = new Set(["isLeft", "isNone"]);

const makeComponentId = (fileName: string, name: string) => `${fileName}#${name}`;

const collectOwnBodyNodes = (body: ts.Node): ReadonlyArray<ts.Node> => {
  const result: Array<ts.Node> = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return result;
};

const collectAllBodyNodes = (body: ts.Node): ReadonlyArray<ts.Node> => {
  const result: Array<ts.Node> = [];
  const visit = (node: ts.Node) => {
    result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return result;
};

const resolveSymbolToComponentId = (
  sym: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
): O.Option<string> => {
  if (!sym) return O.none;
  const canonical = resolveCanonicalSymbol(sym, checker);
  const direct = idBySymbol.get(canonical);
  if (direct !== undefined) return O.some(direct);
  const rawMatch = idBySymbol.get(sym);
  if (rawMatch !== undefined) return O.some(rawMatch);
  return O.none;
};

const resolveExpressionToComponentId = (
  expr: ts.Expression,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
): O.Option<string> => {
  const unwrapped = unwrapExpression(expr);
  if (ts.isIdentifier(unwrapped) || ts.isPropertyAccessExpression(unwrapped)) {
    const sym = checker.getSymbolAtLocation(unwrapped);
    return resolveSymbolToComponentId(sym, checker, idBySymbol);
  }
  return O.none;
};

const isInsideSwallowingTryCatch = (node: ts.Node, boundary: ts.Node): boolean => {
  let curr: ts.Node | undefined = node.parent;
  while (curr && curr !== boundary) {
    if (ts.isTryStatement(curr) && curr.catchClause) {
      const catchNodes = collectOwnBodyNodes(curr.catchClause.block);
      const rethrows = catchNodes.some((n) => ts.isThrowStatement(n));
      if (!rethrows) return true;
    }
    curr = curr.parent;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Stage 1A: Production Component Graph & Return/Error Provenance
// ---------------------------------------------------------------------------

type RawProductionFn = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly fileName: string;
  readonly line: number;
  readonly isExported: boolean;
  readonly symbol: O.Option<ts.Symbol>;
  readonly fnNode: ts.FunctionLikeDeclaration;
}>;

const collectFileProductionFns = (
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
): ReadonlyArray<RawProductionFn> => {
  if (isBarrelFile(sf)) return [];
  const fileName = normalizeFilePath(sf.fileName);
  const runtimeExports = extractFileRuntimeExports(sf, checker);
  const exportedDecls = new Set<ts.Node>(runtimeExports.map((e) => e.declaration));
  const exportedSyms = new Set<ts.Symbol>(
    pipe(
      runtimeExports,
      RA.filterMap((e) => e.symbol),
      RA.map((s) => resolveCanonicalSymbol(s, checker)),
    ),
  );

  const records: Array<RawProductionFn> = [];
  const seenIds = new Set<string>();

  const register = (
    name: string,
    fnNode: ts.FunctionLikeDeclaration,
    reportNode: ts.Node,
    sym: O.Option<ts.Symbol>,
    isExported: boolean,
  ) => {
    if (!fnNode.body) return;
    const id = makeComponentId(fileName, name);
    if (seenIds.has(id)) return;
    seenIds.add(id);
    const loc = getTsNodeLocation(reportNode, sf);
    records.push({ id, name, fileName, line: loc.line, isExported, symbol: sym, fnNode });
  };

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body && stmt.name) {
      const sym = O.fromNullable(checker.getSymbolAtLocation(stmt.name));
      const isExp =
        exportedDecls.has(stmt) ||
        (O.isSome(sym) && exportedSyms.has(resolveCanonicalSymbol(sym.value, checker)));
      register(stmt.name.text, stmt, stmt, sym, isExp);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = unwrapExpression(decl.initializer);
        if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) continue;
        const sym = O.fromNullable(checker.getSymbolAtLocation(decl.name));
        const isExp =
          exportedDecls.has(decl) ||
          (O.isSome(sym) && exportedSyms.has(resolveCanonicalSymbol(sym.value, checker)));
        register(decl.name.text, init, decl, sym, isExp);
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      const className = stmt.name.text;
      const classSym = O.fromNullable(checker.getSymbolAtLocation(stmt.name));
      const classExported =
        exportedDecls.has(stmt) ||
        (O.isSome(classSym) && exportedSyms.has(resolveCanonicalSymbol(classSym.value, checker)));
      for (const member of stmt.members) {
        if (
          ts.isMethodDeclaration(member) &&
          member.body &&
          (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
        ) {
          const methodSym = O.fromNullable(checker.getSymbolAtLocation(member.name));
          register(`${className}.${member.name.text}`, member, member, methodSym, classExported);
        }
      }
    } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const unwrapped = unwrapExpression(stmt.expression);
      if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
        register("default", unwrapped, stmt, O.fromNullable(checker.getSymbolAtLocation(stmt)), true);
      } else if (ts.isObjectLiteralExpression(unwrapped)) {
        for (const prop of unwrapped.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
          ) {
            const init = unwrapExpression(prop.initializer);
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
              register(
                `default.${prop.name.text}`,
                init,
                prop,
                O.fromNullable(checker.getSymbolAtLocation(prop.name)),
                true,
              );
            }
          } else if (
            ts.isMethodDeclaration(prop) &&
            prop.body &&
            (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
          ) {
            register(
              `default.${prop.name.text}`,
              prop,
              prop,
              O.fromNullable(checker.getSymbolAtLocation(prop.name)),
              true,
            );
          }
        }
      }
    }
  }

  return records;
};

const collectExprComponentOrigins = (
  expr: ts.Expression,
  localVarOrigins: ReadonlyMap<ts.Symbol, ReadonlyArray<string>>,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
): ReadonlyArray<string> => {
  const unwrapped = unwrapExpression(expr);
  if (ts.isCallExpression(unwrapped)) {
    const direct = resolveExpressionToComponentId(unwrapped.expression, checker, idBySymbol);
    if (O.isSome(direct)) return [direct.value];
    // Handle pipe(arg, fn1, fn2) -> track last/all component callees in pipe
    if (ts.isIdentifier(unwrapped.expression) && unwrapped.expression.text === "pipe") {
      const fromArgs = unwrapped.arguments.flatMap((a) =>
        collectExprComponentOrigins(a, localVarOrigins, checker, idBySymbol),
      );
      return pipe(fromArgs, RA.uniq(S.Eq));
    }
    // Check callback/argument origins for combinators like E.map(...) or Array.map(fn)
    const argOrigins = unwrapped.arguments.flatMap((a) =>
      collectExprComponentOrigins(a, localVarOrigins, checker, idBySymbol),
    );
    const recvOrigins = ts.isPropertyAccessExpression(unwrapped.expression)
      ? collectExprComponentOrigins(unwrapped.expression.expression, localVarOrigins, checker, idBySymbol)
      : [];
    return pipe([...recvOrigins, ...argOrigins], RA.uniq(S.Eq));
  }
  if (ts.isAwaitExpression(unwrapped)) {
    return collectExprComponentOrigins(unwrapped.expression, localVarOrigins, checker, idBySymbol);
  }
  if (ts.isIdentifier(unwrapped)) {
    const sym = checker.getSymbolAtLocation(unwrapped);
    if (sym) {
      const bound = localVarOrigins.get(sym);
      if (bound) return bound;
      const fnMatch = resolveSymbolToComponentId(sym, checker, idBySymbol);
      if (O.isSome(fnMatch)) return [fnMatch.value];
    }
    return [];
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const direct = resolveExpressionToComponentId(unwrapped, checker, idBySymbol);
    if (O.isSome(direct)) return [direct.value];
    return collectExprComponentOrigins(unwrapped.expression, localVarOrigins, checker, idBySymbol);
  }
  if (ts.isBinaryExpression(unwrapped)) {
    return pipe(
      [
        ...collectExprComponentOrigins(unwrapped.left, localVarOrigins, checker, idBySymbol),
        ...collectExprComponentOrigins(unwrapped.right, localVarOrigins, checker, idBySymbol),
      ],
      RA.uniq(S.Eq),
    );
  }
  if (ts.isConditionalExpression(unwrapped)) {
    return pipe(
      [
        ...collectExprComponentOrigins(unwrapped.whenTrue, localVarOrigins, checker, idBySymbol),
        ...collectExprComponentOrigins(unwrapped.whenFalse, localVarOrigins, checker, idBySymbol),
      ],
      RA.uniq(S.Eq),
    );
  }
  if (ts.isParenthesizedExpression(unwrapped)) {
    return collectExprComponentOrigins(unwrapped.expression, localVarOrigins, checker, idBySymbol);
  }
  return [];
};

const analyzeProductionFnBody = (
  fn: RawProductionFn,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
) => {
  if (!fn.fnNode.body) {
    return {
      directCallees: [] as ReadonlyArray<string>,
      returnFieldProvenance: {} as Readonly<Record<string, ReadonlyArray<string>>>,
      directReturnProvenance: [] as ReadonlyArray<string>,
      errorProvenance: [] as ReadonlyArray<string>,
    };
  }

  const bodyNodes = collectOwnBodyNodes(fn.fnNode.body);
  const directCallees = new Set<string>();
  const errorProvenance = new Set<string>();
  const localVarOrigins = new Map<ts.Symbol, ReadonlyArray<string>>();
  const returnFieldMap = new Map<string, Set<string>>();
  const directReturnSet = new Set<string>();

  // Pass 1: collect calls, error propagation, and local bindings
  for (const node of bodyNodes) {
    if (ts.isCallExpression(node)) {
      const calleeId = resolveExpressionToComponentId(node.expression, checker, idBySymbol);
      if (O.isSome(calleeId) && calleeId.value !== fn.id) {
        directCallees.add(calleeId.value);
        if (!isInsideSwallowingTryCatch(node, fn.fnNode.body)) {
          errorProvenance.add(calleeId.value);
        }
      }
      // Track HOF/pipe callback references
      for (const arg of node.arguments) {
        const argId = resolveExpressionToComponentId(arg, checker, idBySymbol);
        if (O.isSome(argId) && argId.value !== fn.id) {
          directCallees.add(argId.value);
          if (!isInsideSwallowingTryCatch(node, fn.fnNode.body)) {
            errorProvenance.add(argId.value);
          }
        }
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      const origins = collectExprComponentOrigins(
        node.initializer,
        localVarOrigins,
        checker,
        idBySymbol,
      ).filter((id) => id !== fn.id);
      if (origins.length > 0) {
        if (ts.isIdentifier(node.name)) {
          const sym = checker.getSymbolAtLocation(node.name);
          if (sym) localVarOrigins.set(sym, origins);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            if (ts.isIdentifier(el.name)) {
              const sym = checker.getSymbolAtLocation(el.name);
              if (sym) localVarOrigins.set(sym, origins);
            }
          }
        }
      }
    }
  }

  // Pass 2: collect returned expressions (expression arrow body or ReturnStatement)
  const returnExprs: Array<ts.Expression> = [];
  if (!ts.isBlock(fn.fnNode.body)) {
    returnExprs.push(fn.fnNode.body);
  } else {
    for (const node of bodyNodes) {
      if (ts.isReturnStatement(node) && node.expression) {
        returnExprs.push(node.expression);
      }
    }
  }

  for (const rawRet of returnExprs) {
    const ret = unwrapExpression(rawRet);
    if (ts.isObjectLiteralExpression(ret)) {
      for (const prop of ret.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) {
          const valSym = checker.getShorthandAssignmentValueSymbol(prop);
          const origins = valSym ? (localVarOrigins.get(valSym) ?? []) : [];
          if (origins.length > 0) {
            const set = returnFieldMap.get(prop.name.text) ?? new Set<string>();
            for (const o of origins) set.add(o);
            returnFieldMap.set(prop.name.text, set);
          }
        } else if (
          ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
        ) {
          const origins = collectExprComponentOrigins(
            prop.initializer,
            localVarOrigins,
            checker,
            idBySymbol,
          ).filter((id) => id !== fn.id);
          if (origins.length > 0) {
            const set = returnFieldMap.get(prop.name.text) ?? new Set<string>();
            for (const o of origins) set.add(o);
            returnFieldMap.set(prop.name.text, set);
          }
        }
      }
    } else {
      const origins = collectExprComponentOrigins(ret, localVarOrigins, checker, idBySymbol).filter(
        (id) => id !== fn.id,
      );
      for (const o of origins) directReturnSet.add(o);
    }
  }

  const returnFieldProvenance: Record<string, ReadonlyArray<string>> = {};
  for (const [key, set] of returnFieldMap.entries()) {
    returnFieldProvenance[key] = Array.from(set).sort();
  }

  return {
    directCallees: Array.from(directCallees).sort(),
    returnFieldProvenance,
    directReturnProvenance: Array.from(directReturnSet).sort(),
    errorProvenance: Array.from(errorProvenance).sort(),
  };
};

const computeTransitiveCallees = (
  startId: string,
  directById: Readonly<Record<string, ReadonlyArray<string>>>,
): ReadonlyArray<string> => {
  const visited = new Set<string>();
  const queue: Array<string> = [...(directById[startId] ?? [])];
  while (queue.length > 0) {
    const curr = queue.shift();
    if (!curr || curr === startId || visited.has(curr)) continue;
    visited.add(curr);
    for (const next of directById[curr] ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return Array.from(visited).sort();
};

const buildProductionGraph = (
  program: ts.Program,
  testPatterns: ReadonlyArray<string>,
): ProductionGraph => {
  const checker = program.getTypeChecker();
  const sourceFiles = getProjectSourceFiles(program);
  const rawFns: Array<RawProductionFn> = [];

  for (const sf of sourceFiles) {
    const fileName = normalizeFilePath(sf.fileName);
    if (isMatchingAnyPattern(fileName, testPatterns)) continue;
    rawFns.push(...collectFileProductionFns(sf, checker));
  }

  const idBySymbol = new Map<ts.Symbol, string>();
  const idsByFileMap = new Map<string, Array<string>>();

  for (const fn of rawFns) {
    if (O.isSome(fn.symbol)) {
      const canonical = resolveCanonicalSymbol(fn.symbol.value, checker);
      idBySymbol.set(canonical, fn.id);
      idBySymbol.set(fn.symbol.value, fn.id);
    }
    const list = idsByFileMap.get(fn.fileName) ?? [];
    list.push(fn.id);
    idsByFileMap.set(fn.fileName, list);
  }

  const analyzed = new Map<
    string,
    Readonly<{
      readonly raw: RawProductionFn;
      readonly directCallees: ReadonlyArray<string>;
      readonly returnFieldProvenance: Readonly<Record<string, ReadonlyArray<string>>>;
      readonly directReturnProvenance: ReadonlyArray<string>;
      readonly errorProvenance: ReadonlyArray<string>;
    }>
  >();

  const directById: Record<string, ReadonlyArray<string>> = {};
  for (const fn of rawFns) {
    const bodyInfo = analyzeProductionFnBody(fn, checker, idBySymbol);
    directById[fn.id] = bodyInfo.directCallees;
    analyzed.set(fn.id, { raw: fn, ...bodyInfo });
  }

  const componentsById: Record<string, ProductionComponent> = {};
  for (const [id, entry] of analyzed.entries()) {
    componentsById[id] = {
      id: entry.raw.id,
      name: entry.raw.name,
      fileName: entry.raw.fileName,
      line: entry.raw.line,
      isExported: entry.raw.isExported,
      symbol: entry.raw.symbol,
      fnNode: entry.raw.fnNode,
      directCallees: entry.directCallees,
      transitiveCallees: computeTransitiveCallees(id, directById),
      returnFieldProvenance: entry.returnFieldProvenance,
      directReturnProvenance: entry.directReturnProvenance,
      errorProvenance: entry.errorProvenance,
    };
  }

  const idsByFile: Record<string, ReadonlyArray<string>> = {};
  for (const [file, ids] of idsByFileMap.entries()) {
    idsByFile[file] = ids;
  }

  return { componentsById, idBySymbol, idsByFile };
};

// ---------------------------------------------------------------------------
// Stage 1B: Fingerprinting, Mocking & Test Case Extraction
// ---------------------------------------------------------------------------

const fingerprintLiteralExpr = (expr: ts.Expression): O.Option<string> => {
  const u = unwrapExpression(expr);
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) {
    return O.some(`str:${JSON.stringify(u.text)}`);
  }
  if (ts.isNumericLiteral(u)) {
    return O.some(`num:${u.text}`);
  }
  if (u.kind === ts.SyntaxKind.TrueKeyword) return O.some("bool:true");
  if (u.kind === ts.SyntaxKind.FalseKeyword) return O.some("bool:false");
  if (u.kind === ts.SyntaxKind.NullKeyword) return O.some("null");
  if (ts.isIdentifier(u) && u.text === "undefined") return O.some("undef");
  if (ts.isRegularExpressionLiteral(u)) return O.some(`re:${u.text}`);
  if (
    ts.isPrefixUnaryExpression(u) &&
    (u.operator === ts.SyntaxKind.MinusToken || u.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(u.operand)
  ) {
    const sign = u.operator === ts.SyntaxKind.MinusToken ? "-" : "";
    return O.some(`num:${sign}${u.operand.text}`);
  }
  if (ts.isArrayLiteralExpression(u)) {
    const parts: Array<string> = [];
    for (const el of u.elements) {
      const fp = fingerprintLiteralExpr(el);
      if (O.isNone(fp)) return O.none;
      parts.push(fp.value);
    }
    return O.some(`[${parts.join(",")}]`);
  }
  if (ts.isObjectLiteralExpression(u)) {
    const entries: Array<string> = [];
    for (const prop of u.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
      ) {
        const fp = fingerprintLiteralExpr(prop.initializer);
        if (O.isNone(fp)) return O.none;
        entries.push(`${prop.name.text}:${fp.value}`);
      } else {
        return O.none;
      }
    }
    return O.some(`{${entries.sort().join(",")}}`);
  }
  return O.none;
};

const fingerprintArguments = (args: ReadonlyArray<ts.Expression>): O.Option<string> => {
  if (args.length === 0) return O.some("()");
  const parts: Array<string> = [];
  for (const arg of args) {
    const fp = fingerprintLiteralExpr(arg);
    if (O.isNone(fp)) return O.none;
    parts.push(fp.value);
  }
  return O.some(`(${parts.join(",")})`);
};

const extractExpectedObjectKeys = (expr: ts.Expression | undefined): ReadonlyArray<string> => {
  if (!expr) return [];
  const u = unwrapExpression(expr);
  if (!ts.isObjectLiteralExpression(u)) return [];
  const keys: Array<string> = [];
  for (const prop of u.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      keys.push(prop.name.text);
    } else if (
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
    ) {
      keys.push(prop.name.text);
    }
  }
  return keys;
};

const classifyMatcher = (matcher: string): AssertionCategory => {
  if (SPY_MATCHERS.has(matcher)) return "spy-interaction";
  if (ERROR_MATCHERS.has(matcher)) return "error";
  if (EQUALITY_MATCHERS.has(matcher)) return "equality";
  if (PREDICATE_MATCHERS.has(matcher)) return "predicate";
  if (CONTAINMENT_MATCHERS.has(matcher)) return "containment";
  if (SHAPE_MATCHERS.has(matcher)) return "shape";
  return "other";
};

const resolveMockedComponentsInNodes = (
  nodes: ReadonlyArray<ts.Node>,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  graph: ProductionGraph,
): ReadonlySet<string> => {
  const mocked = new Set<string>();
  const sfDir = normalizeFilePath(sf.fileName).replace(/\/[^/]+$/, "");

  for (const node of nodes) {
    if (!ts.isCallExpression(node)) continue;
    const callee = node.expression;

    // vi.mock("./mod", ...) / jest.mock("./mod", ...)
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      MOCK_RUNNER_NAMES.has(callee.expression.text) &&
      callee.name.text === "mock" &&
      node.arguments.length >= 1
    ) {
      const modArg = unwrapExpression(node.arguments[0]!);
      if (ts.isStringLiteral(modArg)) {
        const modSym = checker.getSymbolAtLocation(modArg);
        const modDeclFile = modSym?.valueDeclaration?.getSourceFile().fileName;
        if (modDeclFile) {
          for (const cid of graph.idsByFile[normalizeFilePath(modDeclFile)] ?? []) {
            mocked.add(cid);
          }
        } else {
          // Fallback: resolve relative module specifier against known production file paths
          const stripped = modArg.text.replace(/\.(?:js|mjs|cjs|ts|tsx)$/, "");
          const normalizedSpec = stripped.replace(/^\.\//, "");
          for (const [prodFile, cids] of Object.entries(graph.idsByFile)) {
            const prodNoExt = prodFile.replace(/\.(?:ts|tsx)$/, "");
            if (
              prodNoExt === `${sfDir}/${normalizedSpec}` ||
              prodNoExt.endsWith(`/${normalizedSpec}`)
            ) {
              for (const cid of cids) mocked.add(cid);
            }
          }
        }
      }
    }

    // vi.spyOn(mod, "fn").mockReturnValue(...) / mockImplementation(...)
    if (
      ts.isPropertyAccessExpression(callee) &&
      MOCK_IMPL_METHODS.has(callee.name.text) &&
      ts.isCallExpression(callee.expression)
    ) {
      const spyCall = callee.expression;
      if (
        ts.isPropertyAccessExpression(spyCall.expression) &&
        ts.isIdentifier(spyCall.expression.expression) &&
        MOCK_RUNNER_NAMES.has(spyCall.expression.expression.text) &&
        spyCall.expression.name.text === "spyOn" &&
        spyCall.arguments.length >= 2
      ) {
        const targetObj = spyCall.arguments[0]!;
        const propArg = unwrapExpression(spyCall.arguments[1]!);
        if (ts.isStringLiteral(propArg)) {
          const objType = checker.getTypeAtLocation(targetObj);
          const propSym = objType.getProperty(propArg.text);
          const resolved = resolveSymbolToComponentId(propSym, checker, graph.idBySymbol);
          if (O.isSome(resolved)) {
            mocked.add(resolved.value);
          }
        }
      }
    }
  }

  return mocked;
};

type LocalTestBinding = Readonly<{
  readonly componentId: string;
  readonly projectedPath: ReadonlyArray<string>;
  readonly inputFingerprint: O.Option<string>;
}>;

const buildSameFileHelperMap = (
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  graph: ProductionGraph,
): ReadonlyMap<ts.Symbol, ReadonlyArray<string>> => {
  const helperFns = new Map<ts.Symbol, ts.FunctionLikeDeclaration>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      const sym = checker.getSymbolAtLocation(stmt.name);
      if (sym) helperFns.set(sym, stmt);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = unwrapExpression(decl.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          const sym = checker.getSymbolAtLocation(decl.name);
          if (sym) helperFns.set(sym, init);
        }
      }
    }
  }

  const directCallsByHelper = new Map<ts.Symbol, ReadonlyArray<string>>();
  for (const [sym, fn] of helperFns.entries()) {
    if (!fn.body) continue;
    const calls = new Set<string>();
    for (const node of collectAllBodyNodes(fn.body)) {
      if (ts.isCallExpression(node)) {
        const cid = resolveExpressionToComponentId(node.expression, checker, graph.idBySymbol);
        if (O.isSome(cid)) calls.add(cid.value);
      }
    }
    directCallsByHelper.set(sym, Array.from(calls));
  }

  // 2-hop helper expansion
  const expanded = new Map<ts.Symbol, ReadonlyArray<string>>();
  for (const [sym, fn] of helperFns.entries()) {
    const calls = new Set<string>(directCallsByHelper.get(sym) ?? []);
    if (fn.body) {
      for (const node of collectAllBodyNodes(fn.body)) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const calleeSym = checker.getSymbolAtLocation(node.expression);
          if (calleeSym) {
            for (const c of directCallsByHelper.get(calleeSym) ?? []) calls.add(c);
          }
        }
      }
    }
    expanded.set(sym, Array.from(calls));
  }
  return expanded;
};

const traceExprBinding = (
  expr: ts.Expression,
  localBindings: ReadonlyMap<ts.Symbol, LocalTestBinding>,
  helperMap: ReadonlyMap<ts.Symbol, ReadonlyArray<string>>,
  checker: ts.TypeChecker,
  graph: ProductionGraph,
): O.Option<LocalTestBinding> => {
  const u = unwrapExpression(expr);
  if (ts.isAwaitExpression(u)) {
    return traceExprBinding(u.expression, localBindings, helperMap, checker, graph);
  }
  if (ts.isCallExpression(u)) {
    const direct = resolveExpressionToComponentId(u.expression, checker, graph.idBySymbol);
    if (O.isSome(direct)) {
      return O.some({
        componentId: direct.value,
        projectedPath: [],
        inputFingerprint: fingerprintArguments(Array.from(u.arguments)),
      });
    }
    // Check fp-ts error/option checks like E.isLeft(checkout("bad"))
    if (
      ts.isPropertyAccessExpression(u.expression) &&
      FP_ERROR_CHECK_METHODS.has(u.expression.name.text) &&
      u.arguments.length === 1
    ) {
      const inner = traceExprBinding(u.arguments[0]!, localBindings, helperMap, checker, graph);
      if (O.isSome(inner)) {
        return O.some({
          ...inner.value,
          projectedPath: [...inner.value.projectedPath, u.expression.name.text],
        });
      }
    }
    // Check same-file thin test helper wrapping a single production component
    if (ts.isIdentifier(u.expression)) {
      const hSym = checker.getSymbolAtLocation(u.expression);
      const targets = hSym ? (helperMap.get(hSym) ?? []) : [];
      if (targets.length === 1) {
        return O.some({
          componentId: targets[0]!,
          projectedPath: [],
          inputFingerprint: fingerprintArguments(Array.from(u.arguments)),
        });
      }
    }
    return O.none;
  }
  if (ts.isPropertyAccessExpression(u)) {
    const base = traceExprBinding(u.expression, localBindings, helperMap, checker, graph);
    if (O.isSome(base)) {
      return O.some({
        ...base.value,
        projectedPath: [...base.value.projectedPath, u.name.text],
      });
    }
    return O.none;
  }
  if (ts.isElementAccessExpression(u) && ts.isStringLiteral(u.argumentExpression)) {
    const base = traceExprBinding(u.expression, localBindings, helperMap, checker, graph);
    if (O.isSome(base)) {
      return O.some({
        ...base.value,
        projectedPath: [...base.value.projectedPath, u.argumentExpression.text],
      });
    }
    return O.none;
  }
  if (ts.isIdentifier(u)) {
    const sym = checker.getSymbolAtLocation(u);
    if (sym) {
      const bound = localBindings.get(sym);
      if (bound) return O.some(bound);
    }
    return O.none;
  }
  // Callback wrapper: () => checkout("bad") for toThrow / assert.throws
  if (ts.isArrowFunction(u) || ts.isFunctionExpression(u)) {
    if (!ts.isBlock(u.body)) {
      return traceExprBinding(u.body, localBindings, helperMap, checker, graph);
    }
    for (const stmt of u.body.statements) {
      if (ts.isReturnStatement(stmt) && stmt.expression) {
        return traceExprBinding(stmt.expression, localBindings, helperMap, checker, graph);
      }
      if (ts.isExpressionStatement(stmt)) {
        const traced = traceExprBinding(stmt.expression, localBindings, helperMap, checker, graph);
        if (O.isSome(traced)) return traced;
      }
    }
  }
  return O.none;
};

const collectReferencedComponentsInExpr = (
  expr: ts.Node,
  localBindings: ReadonlyMap<ts.Symbol, LocalTestBinding>,
  helperMap: ReadonlyMap<ts.Symbol, ReadonlyArray<string>>,
  checker: ts.TypeChecker,
  graph: ProductionGraph,
): Readonly<{
  readonly components: ReadonlyArray<string>;
  readonly subjectFields: ReadonlyArray<string>;
}> => {
  const components = new Set<string>();
  const subjectFields = new Set<string>();

  for (const node of collectAllBodyNodes(expr)) {
    if (ts.isCallExpression(node)) {
      const cid = resolveExpressionToComponentId(node.expression, checker, graph.idBySymbol);
      if (O.isSome(cid)) {
        components.add(cid.value);
      } else if (ts.isIdentifier(node.expression)) {
        const sym = checker.getSymbolAtLocation(node.expression);
        if (sym) {
          for (const hc of helperMap.get(sym) ?? []) components.add(hc);
        }
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      const traced = traceExprBinding(node, localBindings, helperMap, checker, graph);
      if (O.isSome(traced)) {
        components.add(traced.value.componentId);
        if (traced.value.projectedPath.length > 0) {
          subjectFields.add(traced.value.projectedPath[0]!);
        }
      }
    } else if (ts.isIdentifier(node)) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym) {
        const bound = localBindings.get(sym);
        if (bound) {
          components.add(bound.componentId);
          if (bound.projectedPath.length > 0) {
            subjectFields.add(bound.projectedPath[0]!);
          }
        }
      }
    }
  }

  return {
    components: Array.from(components).sort(),
    subjectFields: Array.from(subjectFields).sort(),
  };
};

type ParsedExpectChain = Readonly<{
  readonly expectArg: ts.Expression;
  readonly matcher: string;
  readonly expectedArg: ts.Expression | undefined;
  readonly isRejects: boolean;
}>;

const tryParseExpectAssertion = (node: ts.CallExpression): O.Option<ParsedExpectChain> => {
  if (!ts.isPropertyAccessExpression(node.expression)) return O.none;
  const matcher = node.expression.name.text;
  let curr: ts.Expression = node.expression.expression;
  let isRejects = false;

  while (ts.isPropertyAccessExpression(curr)) {
    const prop = curr.name.text;
    if (prop === "rejects") isRejects = true;
    if (prop === "not" || prop === "resolves" || prop === "rejects") {
      curr = curr.expression;
    } else {
      return O.none;
    }
  }

  if (
    ts.isCallExpression(curr) &&
    ts.isIdentifier(curr.expression) &&
    curr.expression.text === "expect" &&
    curr.arguments.length >= 1
  ) {
    return O.some({
      expectArg: curr.arguments[0]!,
      matcher,
      expectedArg: node.arguments[0],
      isRejects,
    });
  }
  return O.none;
};

const tryParseNodeAssert = (node: ts.CallExpression): O.Option<ParsedExpectChain> => {
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "assert" &&
    node.arguments.length >= 1
  ) {
    const matcher = node.expression.name.text;
    return O.some({
      expectArg: node.arguments[0]!,
      matcher,
      expectedArg: node.arguments[1],
      isRejects: matcher === "rejects",
    });
  }
  if (
    ts.isIdentifier(node.expression) &&
    node.expression.text === "assert" &&
    node.arguments.length >= 1
  ) {
    return O.some({
      expectArg: node.arguments[0]!,
      matcher: "ok",
      expectedArg: undefined,
      isRejects: false,
    });
  }
  return O.none;
};

const extractTestBodyAnalysis = (
  body: ts.Node,
  helperMap: ReadonlyMap<ts.Symbol, ReadonlyArray<string>>,
  checker: ts.TypeChecker,
  graph: ProductionGraph,
) => {
  const nodes = collectAllBodyNodes(body);
  const directTargets = new Set<string>();
  const localBindings = new Map<ts.Symbol, LocalTestBinding>();
  const dataflowEdges: Array<DataflowEdge> = [];
  const assertions: Array<ExtractedAssertion> = [];

  // Pass 1: direct production calls, local bindings, and dataflow edges
  for (const node of nodes) {
    if (ts.isCallExpression(node)) {
      const cid = resolveExpressionToComponentId(node.expression, checker, graph.idBySymbol);
      if (O.isSome(cid)) {
        directTargets.add(cid.value);
        // Check if any argument comes from another production component (dataflow composition!)
        for (const arg of node.arguments) {
          const argRefs = collectReferencedComponentsInExpr(
            arg,
            localBindings,
            helperMap,
            checker,
            graph,
          );
          for (const srcId of argRefs.components) {
            if (srcId !== cid.value) {
              dataflowEdges.push({ fromComponentId: srcId, toComponentId: cid.value });
            }
          }
        }
      } else if (ts.isIdentifier(node.expression)) {
        const hSym = checker.getSymbolAtLocation(node.expression);
        if (hSym) {
          for (const hc of helperMap.get(hSym) ?? []) directTargets.add(hc);
        }
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      const traced = traceExprBinding(node.initializer, localBindings, helperMap, checker, graph);
      if (O.isSome(traced)) {
        if (ts.isIdentifier(node.name)) {
          const sym = checker.getSymbolAtLocation(node.name);
          if (sym) localBindings.set(sym, traced.value);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            if (ts.isIdentifier(el.name)) {
              const propKey =
                el.propertyName &&
                (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName))
                  ? el.propertyName.text
                  : el.name.text;
              const sym = checker.getSymbolAtLocation(el.name);
              if (sym) {
                localBindings.set(sym, {
                  ...traced.value,
                  projectedPath: [...traced.value.projectedPath, propKey],
                });
              }
            }
          }
        }
      }
    }
  }

  // Pass 2: assertions
  for (const node of nodes) {
    if (!ts.isCallExpression(node)) continue;
    const parsed = pipe(
      tryParseExpectAssertion(node),
      O.alt(() => tryParseNodeAssert(node)),
    );
    if (O.isNone(parsed)) continue;

    const { expectArg, matcher, expectedArg, isRejects } = parsed.value;
    const baseCategory = isRejects ? "error" : classifyMatcher(matcher);
    const tracedSubject = traceExprBinding(expectArg, localBindings, helperMap, checker, graph);

    // Detect fp-ts Left/None error assertions: expect(E.isLeft(fn(x))).toBe(true) or expect(fn(x)._tag).toBe("Left")
    const isFpErrorCheck =
      O.isSome(tracedSubject) &&
      (tracedSubject.value.projectedPath.some((p) => FP_ERROR_CHECK_METHODS.has(p)) ||
        (tracedSubject.value.projectedPath[tracedSubject.value.projectedPath.length - 1] ===
          "_tag" &&
          expectedArg !== undefined &&
          ts.isStringLiteral(unwrapExpression(expectedArg)) &&
          ["Left", "None"].includes((unwrapExpression(expectedArg) as ts.StringLiteral).text)));

    const category: AssertionCategory = isFpErrorCheck ? "error" : baseCategory;
    const subjectRefs = collectReferencedComponentsInExpr(
      expectArg,
      localBindings,
      helperMap,
      checker,
      graph,
    );
    const expectedRefs = expectedArg
      ? collectReferencedComponentsInExpr(expectedArg, localBindings, helperMap, checker, graph)
      : { components: [] as ReadonlyArray<string>, subjectFields: [] as ReadonlyArray<string> };

    const referencedComponents = pipe(
      [
        ...(O.isSome(tracedSubject) ? [tracedSubject.value.componentId] : []),
        ...subjectRefs.components,
        ...expectedRefs.components,
      ],
      RA.uniq(S.Eq),
    );
    const referencedSubjectFields = pipe(
      [...subjectRefs.subjectFields, ...expectedRefs.subjectFields],
      RA.uniq(S.Eq),
    );

    const expectedFingerprint = expectedArg ? fingerprintLiteralExpr(expectedArg) : O.none;
    const expectedObjectKeys = extractExpectedObjectKeys(expectedArg);

    assertions.push({
      category,
      matcher,
      subjectComponentId: pipe(
        tracedSubject,
        O.map((t) => t.componentId),
      ),
      projectedPath: O.isSome(tracedSubject) ? tracedSubject.value.projectedPath : [],
      inputFingerprint: O.isSome(tracedSubject) ? tracedSubject.value.inputFingerprint : O.none,
      expectedFingerprint,
      expectedObjectKeys,
      referencedComponents,
      referencedSubjectFields,
    });
  }

  return {
    directTargets: Array.from(directTargets).sort(),
    dataflowEdges,
    assertions,
  };
};

type TestRegistration = Readonly<{
  readonly callNode: ts.CallExpression;
  readonly name: string;
  readonly callback: ts.FunctionLikeDeclaration;
  readonly eachCount: number;
}>;

const extractStringArg = (expr: ts.Expression | undefined): O.Option<string> => {
  if (!expr) return O.none;
  const u = unwrapExpression(expr);
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) {
    return O.some(u.text);
  }
  return O.none;
};

const tryParseTestCall = (node: ts.CallExpression): O.Option<TestRegistration> => {
  const callee = node.expression;

  // it("name", fn) / test("name", fn)
  if (ts.isIdentifier(callee) && TEST_FN_NAMES.has(callee.text) && node.arguments.length >= 2) {
    const name = extractStringArg(node.arguments[0]);
    const cb = unwrapExpression(node.arguments[1]!);
    if (O.isSome(name) && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
      return O.some({ callNode: node, name: name.value, callback: cb, eachCount: 1 });
    }
  }

  // it.only("name", fn) / it.skip / it.concurrent / test.only ...
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    TEST_FN_NAMES.has(callee.expression.text) &&
    node.arguments.length >= 2
  ) {
    const name = extractStringArg(node.arguments[0]);
    const cb = unwrapExpression(node.arguments[1]!);
    if (O.isSome(name) && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
      return O.some({ callNode: node, name: name.value, callback: cb, eachCount: 1 });
    }
  }

  // it.each([...])("name", fn) / test.each([...])("name", fn)
  if (
    ts.isCallExpression(callee) &&
    ts.isPropertyAccessExpression(callee.expression) &&
    ts.isIdentifier(callee.expression.expression) &&
    TEST_FN_NAMES.has(callee.expression.expression.text) &&
    callee.expression.name.text === "each" &&
    node.arguments.length >= 2
  ) {
    const name = extractStringArg(node.arguments[0]);
    const cb = unwrapExpression(node.arguments[1]!);
    const casesArg = callee.arguments[0] ? unwrapExpression(callee.arguments[0]) : undefined;
    const eachCount =
      casesArg && ts.isArrayLiteralExpression(casesArg)
        ? Math.max(1, casesArg.elements.length)
        : 2;
    if (O.isSome(name) && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
      return O.some({ callNode: node, name: name.value, callback: cb, eachCount });
    }
  }

  return O.none;
};

const tryParseDescribeCall = (
  node: ts.CallExpression,
): O.Option<Readonly<{ readonly title: string; readonly body: ts.Node }>> => {
  const callee = node.expression;
  const isDescribe =
    (ts.isIdentifier(callee) && DESCRIBE_FN_NAMES.has(callee.text)) ||
    (ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      DESCRIBE_FN_NAMES.has(callee.expression.text));
  if (!isDescribe || node.arguments.length < 2) return O.none;
  const title = extractStringArg(node.arguments[0]);
  const cb = unwrapExpression(node.arguments[1]!);
  if (O.isSome(title) && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.body) {
    return O.some({ title: title.value, body: cb.body });
  }
  return O.none;
};

const extractTestCasesFromFile = (
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  graph: ProductionGraph,
): ReadonlyArray<ExtractedTestCase> => {
  const fileName = normalizeFilePath(sf.fileName);
  const helperMap = buildSameFileHelperMap(sf, checker, graph);
  const fileNodes = collectOwnBodyNodes(sf);
  const fileMocks = resolveMockedComponentsInNodes(fileNodes, sf, checker, graph);
  const tests: Array<ExtractedTestCase> = [];

  const visitScope = (
    root: ts.Node,
    describeStack: ReadonlyArray<string>,
    inheritedMocks: ReadonlySet<string>,
  ) => {
    const scopeOwnNodes = collectOwnBodyNodes(root);
    const scopeMocks = new Set<string>([
      ...inheritedMocks,
      ...resolveMockedComponentsInNodes(scopeOwnNodes, sf, checker, graph),
    ]);

    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const desc = tryParseDescribeCall(node);
        if (O.isSome(desc)) {
          visitScope(desc.value.body, [...describeStack, desc.value.title], scopeMocks);
          return;
        }

        const testReg = tryParseTestCall(node);
        if (O.isSome(testReg)) {
          const { callNode, name, callback, eachCount } = testReg.value;
          const body = callback.body;
          if (body) {
            const bodyNodes = collectAllBodyNodes(body);
            const testMocks = new Set<string>([
              ...scopeMocks,
              ...resolveMockedComponentsInNodes(bodyNodes, sf, checker, graph),
            ]);
            const extracted = extractTestBodyAnalysis(body, helperMap, checker, graph);
            const loc = getTsNodeLocation(callNode, sf);
            const fullName =
              describeStack.length > 0 ? `${describeStack.join(" > ")} > ${name}` : name;
            tests.push({
              id: `${fileName}@${String(callNode.getStart(sf))}`,
              name,
              fullName,
              fileName,
              line: loc.line,
              locationKey: makeLocationKey(loc),
              eachCount,
              directTargets: extracted.directTargets,
              mockedTargets: Array.from(testMocks).sort(),
              assertions: extracted.assertions,
              dataflowEdges: extracted.dataflowEdges,
            });
          }
          return;
        }
      }
      ts.forEachChild(node, walk);
    };

    ts.forEachChild(root, walk);
  };

  visitScope(sf, [], fileMocks);
  return tests;
};

// ---------------------------------------------------------------------------
// Stage 2: Property Analyzer & Test Classification
// ---------------------------------------------------------------------------

type DirectErrorSignature = Readonly<{
  readonly inputFp: O.Option<string>;
  readonly expectedFp: O.Option<string>;
}>;

type DirectComponentIndex = Readonly<{
  readonly testsByComponent: Readonly<Record<string, ReadonlyArray<ExtractedTestCase>>>;
  readonly errorSigsByComponent: Readonly<Record<string, ReadonlyArray<DirectErrorSignature>>>;
  readonly valuePairsByComponent: Readonly<Record<string, ReadonlySet<string>>>;
}>;

const makeValuePairKey = (inputFp: string, expectedFp: string) => `${inputFp}=>${expectedFp}`;

const buildDirectComponentIndex = (
  tests: ReadonlyArray<ExtractedTestCase>,
  graph: ProductionGraph,
): DirectComponentIndex => {
  const testsMap = new Map<string, Array<ExtractedTestCase>>();
  const errorMap = new Map<string, Array<DirectErrorSignature>>();
  const valueMap = new Map<string, Set<string>>();

  for (const test of tests) {
    const assertedTargets = new Set<string>();
    for (const a of test.assertions) {
      if (O.isSome(a.subjectComponentId)) {
        assertedTargets.add(a.subjectComponentId.value);
      }
    }

    for (const targetId of assertedTargets) {
      const comp = graph.componentsById[targetId];
      if (!comp) continue;
      // Only count as a direct component test for targetId if it directly calls targetId
      if (!test.directTargets.includes(targetId)) continue;

      const list = testsMap.get(targetId) ?? [];
      list.push(test);
      testsMap.set(targetId, list);

      for (const a of test.assertions) {
        if (O.isNone(a.subjectComponentId) || a.subjectComponentId.value !== targetId) continue;
        if (a.category === "error") {
          const errs = errorMap.get(targetId) ?? [];
          errs.push({ inputFp: a.inputFingerprint, expectedFp: a.expectedFingerprint });
          errorMap.set(targetId, errs);
        }
        if (O.isSome(a.inputFingerprint) && O.isSome(a.expectedFingerprint)) {
          const set = valueMap.get(targetId) ?? new Set<string>();
          set.add(makeValuePairKey(a.inputFingerprint.value, a.expectedFingerprint.value));
          valueMap.set(targetId, set);
        }
      }
    }
  }

  const testsByComponent: Record<string, ReadonlyArray<ExtractedTestCase>> = {};
  for (const [k, v] of testsMap.entries()) testsByComponent[k] = v;

  const errorSigsByComponent: Record<string, ReadonlyArray<DirectErrorSignature>> = {};
  for (const [k, v] of errorMap.entries()) errorSigsByComponent[k] = v;

  const valuePairsByComponent: Record<string, ReadonlySet<string>> = {};
  for (const [k, v] of valueMap.entries()) valuePairsByComponent[k] = v;

  return { testsByComponent, errorSigsByComponent, valuePairsByComponent };
};

const inferAssertionProperty = (
  assertion: ExtractedAssertion,
  mockedSet: ReadonlySet<string>,
  graph: ProductionGraph,
  directIndex: DirectComponentIndex,
): O.Option<InferredProperty> => {
  if (assertion.category === "spy-interaction") {
    const targetId = O.isSome(assertion.subjectComponentId)
      ? assertion.subjectComponentId.value
      : (assertion.referencedComponents[0] ?? "<spy>");
    return O.some({
      kind: "interaction",
      directTargetId: targetId,
      ownerComponentId: targetId,
      label: "interaction wiring",
      assertion,
    });
  }

  if (O.isNone(assertion.subjectComponentId)) {
    return O.none;
  }

  const directId = assertion.subjectComponentId.value;
  const comp = graph.componentsById[directId];
  if (!comp) return O.none;

  // Multi-component assertion -> system invariant
  if (assertion.referencedComponents.length >= 2) {
    return O.some({
      kind: "system-invariant",
      directTargetId: directId,
      ownerComponentId: directId,
      label: `${comp.name} system invariant`,
      assertion,
    });
  }

  // Multi-field invariant on composite return (e.g. expect(res.total).toBeGreaterThanOrEqual(res.price))
  if (assertion.referencedSubjectFields.length >= 2) {
    const distinctOwners = new Set<string>();
    for (const field of assertion.referencedSubjectFields) {
      for (const prov of comp.returnFieldProvenance[field] ?? []) {
        if (!mockedSet.has(prov)) distinctOwners.add(prov);
      }
    }
    if (distinctOwners.size >= 2) {
      return O.some({
        kind: "system-invariant",
        directTargetId: directId,
        ownerComponentId: directId,
        label: `${comp.name} cross-field invariant`,
        assertion,
      });
    }
  }

  // Whole-object equality spanning >= 2 distinct unmocked dependencies -> composition!
  if (assertion.projectedPath.length === 0 && assertion.expectedObjectKeys.length >= 2) {
    const distinctOwners = new Set<string>();
    for (const key of assertion.expectedObjectKeys) {
      for (const prov of comp.returnFieldProvenance[key] ?? []) {
        if (!mockedSet.has(prov)) distinctOwners.add(prov);
      }
    }
    if (distinctOwners.size >= 2) {
      return O.some({
        kind: "composition",
        directTargetId: directId,
        ownerComponentId: directId,
        label: `${comp.name} composition`,
        assertion,
      });
    }
  }

  // Projected field provenance: e.g. checkout("$10").price -> parsePrice
  if (assertion.projectedPath.length >= 1) {
    const headField = assertion.projectedPath[0]!;
    const rawProvenance = comp.returnFieldProvenance[headField] ?? [];
    const unmockedProvenance = rawProvenance.filter((id) => !mockedSet.has(id) && id !== directId);
    if (unmockedProvenance.length === 1 && rawProvenance.length === 1) {
      const lowerId = unmockedProvenance[0]!;
      const lowerComp = graph.componentsById[lowerId];
      return O.some({
        kind: "projected-output",
        directTargetId: directId,
        ownerComponentId: lowerId,
        label: `${lowerComp?.name ?? lowerId} (.${assertion.projectedPath.join(".")})`,
        assertion,
      });
    }
  }

  // Delegated error assertion: e.g. expect(() => checkout("bad")).toThrow("Invalid price")
  if (assertion.category === "error") {
    const unmockedErrorDeps = comp.errorProvenance.filter(
      (id) => !mockedSet.has(id) && id !== directId,
    );
    for (const lowerId of unmockedErrorDeps) {
      const lowerErrSigs = directIndex.errorSigsByComponent[lowerId] ?? [];
      const matchesDirectErr = lowerErrSigs.some(
        (sig) =>
          (O.isSome(sig.expectedFp) &&
            O.isSome(assertion.expectedFingerprint) &&
            sig.expectedFp.value === assertion.expectedFingerprint.value) ||
          (O.isSome(sig.inputFp) &&
            O.isSome(assertion.inputFingerprint) &&
            sig.inputFp.value === assertion.inputFingerprint.value),
      );
      if (matchesDirectErr) {
        const lowerComp = graph.componentsById[lowerId];
        return O.some({
          kind: "delegated-error",
          directTargetId: directId,
          ownerComponentId: lowerId,
          label: `${lowerComp?.name ?? lowerId} error handling`,
          assertion,
        });
      }
    }
  }

  // Direct pass-through return: H directly returns L(...) and matches L's direct test I/O
  if (
    assertion.projectedPath.length === 0 &&
    comp.directReturnProvenance.length === 1 &&
    O.isSome(assertion.inputFingerprint) &&
    O.isSome(assertion.expectedFingerprint)
  ) {
    const lowerId = comp.directReturnProvenance[0]!;
    if (!mockedSet.has(lowerId) && lowerId !== directId) {
      const pairKey = makeValuePairKey(
        assertion.inputFingerprint.value,
        assertion.expectedFingerprint.value,
      );
      if (directIndex.valuePairsByComponent[lowerId]?.has(pairKey)) {
        const lowerComp = graph.componentsById[lowerId];
        return O.some({
          kind: "direct-passthrough",
          directTargetId: directId,
          ownerComponentId: lowerId,
          label: `${lowerComp?.name ?? lowerId} behavior`,
          assertion,
        });
      }
    }
  }

  return O.some({
    kind: "component-behavior",
    directTargetId: directId,
    ownerComponentId: directId,
    label: `${comp.name} behavior`,
    assertion,
  });
};

const isDelegatedKind = (kind: InferredPropertyKind) =>
  kind === "projected-output" || kind === "delegated-error" || kind === "direct-passthrough";

const classifyTestCase = (
  test: ExtractedTestCase,
  graph: ProductionGraph,
  directIndex: DirectComponentIndex,
): ClassifiedTestCase => {
  const mockedSet = new Set(test.mockedTargets);
  const properties = pipe(
    test.assertions,
    RA.filterMap((a) => inferAssertionProperty(a, mockedSet, graph, directIndex)),
  );

  if (properties.some((p) => p.kind === "system-invariant")) {
    return { test, properties, classification: "system-invariant" };
  }

  const hasInteractionOrComposition = properties.some(
    (p) => p.kind === "interaction" || p.kind === "composition",
  );
  if (hasInteractionOrComposition || test.dataflowEdges.length > 0) {
    return { test, properties, classification: "composition" };
  }

  // Check if ALL properties are delegated to a SINGLE lower-level dependency
  const allDelegated =
    properties.length > 0 && properties.every((p) => isDelegatedKind(p.kind));
  if (allDelegated) {
    const distinctOwners = pipe(
      properties,
      RA.map((p) => p.ownerComponentId),
      RA.uniq(S.Eq),
    );
    if (distinctOwners.length === 1) {
      const lowerId = distinctOwners[0]!;
      const hasDirectTests = (directIndex.testsByComponent[lowerId]?.length ?? 0) > 0;
      return {
        test,
        properties,
        classification: hasDirectTests ? "potentially-redundant" : "composition",
      };
    }
    // Asserting properties from 2+ distinct dependencies -> genuine composition!
    return { test, properties, classification: "composition" };
  }

  // If targeting a higher-level orchestrator with unmocked dependencies & asserting its own behavior
  const targetsHigherLevel = test.directTargets.some((tid) => {
    const comp = graph.componentsById[tid];
    if (!comp) return false;
    return comp.directCallees.some((dep) => !mockedSet.has(dep));
  });

  if (targetsHigherLevel && properties.length > 0) {
    return { test, properties, classification: "composition" };
  }

  return { test, properties, classification: "component" };
};

// ---------------------------------------------------------------------------
// Stage 3: Rule Engines (Redundancy, Lowest-Level, Single Responsibility)
// ---------------------------------------------------------------------------

const makeEdgeKey = (higherId: string, lowerId: string) => `${higherId}->${lowerId}`;

const detectRedundancies = (
  classifiedTests: ReadonlyArray<ClassifiedTestCase>,
  graph: ProductionGraph,
  directIndex: DirectComponentIndex,
  options: TestScopeOptions,
): ReadonlyArray<RedundantTestFinding> => {
  const findings: Array<RedundantTestFinding> = [];

  // 1. Determine which (H -> L) unmocked edges already have non-delegated composition/invariant coverage
  const compositionCoveredEdges = new Set<string>();
  for (const ct of classifiedTests) {
    if (ct.classification !== "composition" && ct.classification !== "system-invariant") continue;
    const allDelegatedSingleLower =
      ct.properties.length > 0 &&
      ct.properties.every((p) => isDelegatedKind(p.kind)) &&
      pipe(
        ct.properties,
        RA.map((p) => p.ownerComponentId),
        RA.uniq(S.Eq),
      ).length === 1;
    if (allDelegatedSingleLower) continue;

    const mockedSet = new Set(ct.test.mockedTargets);
    for (const hId of ct.test.directTargets) {
      const hComp = graph.componentsById[hId];
      if (!hComp) continue;
      for (const lId of hComp.transitiveCallees) {
        if (!mockedSet.has(lId)) {
          compositionCoveredEdges.add(makeEdgeKey(hId, lId));
        }
      }
    }
  }

  // 2. Collect cross-level delegated-only candidates grouped by (H -> L)
  type DelegatedCandidate = Readonly<{
    readonly ct: ClassifiedTestCase;
    readonly higherId: string;
    readonly lowerId: string;
    readonly propertyLabel: string;
    readonly effectiveCaseCount: number;
  }>;

  const candidatesByEdge = new Map<string, Array<DelegatedCandidate>>();
  for (const ct of classifiedTests) {
    if (ct.properties.length === 0) continue;
    if (!ct.properties.every((p) => isDelegatedKind(p.kind))) continue;
    const distinctHigher = pipe(
      ct.properties,
      RA.map((p) => p.directTargetId),
      RA.uniq(S.Eq),
    );
    const distinctLower = pipe(
      ct.properties,
      RA.map((p) => p.ownerComponentId),
      RA.uniq(S.Eq),
    );
    if (distinctHigher.length !== 1 || distinctLower.length !== 1) continue;

    const higherId = distinctHigher[0]!;
    const lowerId = distinctLower[0]!;
    const lowerDirectTests = directIndex.testsByComponent[lowerId] ?? [];
    if (lowerDirectTests.length === 0) continue;

    const edgeKey = makeEdgeKey(higherId, lowerId);
    const list = candidatesByEdge.get(edgeKey) ?? [];
    list.push({
      ct,
      higherId,
      lowerId,
      propertyLabel: ct.properties[0]!.label,
      effectiveCaseCount: ct.properties.length * ct.test.eachCount,
    });
    candidatesByEdge.set(edgeKey, list);
  }

  for (const [edgeKey, candidates] of candidatesByEdge.entries()) {
    const hasExistingCompositionTest = compositionCoveredEdges.has(edgeKey);
    candidates.forEach((cand, idx) => {
      // Safety guard: if NO separate composition test covers H -> L, keep the first
      // single-case test as minimal integration wiring coverage!
      const isSoleWiringTest =
        !hasExistingCompositionTest &&
        idx === 0 &&
        cand.effectiveCaseCount < options.minRepeatedCases;
      if (isSoleWiringTest) return;

      const higherComp = graph.componentsById[cand.higherId];
      const lowerComp = graph.componentsById[cand.lowerId];
      const existingTests = pipe(
        directIndex.testsByComponent[cand.lowerId] ?? [],
        RA.map((t) => t.fullName),
        RA.uniq(S.Eq),
      );
      findings.push({
        kind: "redundantCrossLevelTest",
        testName: cand.ct.test.fullName,
        fileName: cand.ct.test.fileName,
        line: cand.ct.test.line,
        locationKey: cand.ct.test.locationKey,
        property: cand.propertyLabel,
        higherComponent: higherComp?.name ?? cand.higherId,
        lowerComponent: lowerComp?.name ?? cand.lowerId,
        existingTests,
        confidence: hasExistingCompositionTest ? "high" : "medium",
      });
    });
  }

  // 3. Same-level duplicate test detection
  if (options.checkSameLevelDuplicates === "enabled") {
    type ConcreteTestEntry = Readonly<{
      readonly test: ExtractedTestCase;
      readonly signatures: ReadonlySet<string>;
      readonly targetLabel: string;
    }>;

    const seenByBucket = new Map<string, Array<ConcreteTestEntry>>();

    for (const ct of classifiedTests) {
      const { test } = ct;
      if (test.directTargets.length === 0 || test.assertions.length === 0) continue;

      const sigs: Array<string> = [];
      let allConcrete = true;
      for (const a of test.assertions) {
        if (
          O.isNone(a.subjectComponentId) ||
          O.isNone(a.inputFingerprint) ||
          O.isNone(a.expectedFingerprint)
        ) {
          allConcrete = false;
          break;
        }
        sigs.push(
          [
            a.subjectComponentId.value,
            a.projectedPath.join("."),
            a.category,
            a.matcher,
            a.inputFingerprint.value,
            a.expectedFingerprint.value,
          ].join("|"),
        );
      }
      if (!allConcrete || sigs.length === 0) continue;

      const sigSet = new Set(sigs);
      const bucketKey = `${test.directTargets.join(",")}::mocks=${test.mockedTargets.join(",")}`;
      const existing = seenByBucket.get(bucketKey) ?? [];

      const duplicateOf = existing.find((prev) => {
        for (const s of sigSet) {
          if (!prev.signatures.has(s)) return false;
        }
        return true;
      });

      const targetLabel = test.directTargets
        .map((id) => graph.componentsById[id]?.name ?? id)
        .join(", ");

      if (duplicateOf) {
        findings.push({
          kind: "duplicateSameLevelTest",
          testName: test.fullName,
          fileName: test.fileName,
          line: test.line,
          locationKey: test.locationKey,
          targetComponent: targetLabel,
          primaryTest: duplicateOf.test.fullName,
        });
      } else {
        existing.push({ test, signatures: sigSet, targetLabel });
        seenByBucket.set(bucketKey, existing);
      }
    }
  }

  return findings;
};

const detectLowestLevelViolations = (
  classifiedTests: ReadonlyArray<ClassifiedTestCase>,
  graph: ProductionGraph,
  directIndex: DirectComponentIndex,
  options: TestScopeOptions,
): ReadonlyArray<LowestLevelFinding> => {
  type DelegatedEntry = Readonly<{
    readonly ct: ClassifiedTestCase;
    readonly higherId: string;
    readonly lowerId: string;
    readonly propertyLabel: string;
    readonly caseCount: number;
  }>;

  const byEdge = new Map<string, Array<DelegatedEntry>>();

  for (const ct of classifiedTests) {
    if (ct.properties.length === 0) continue;
    if (!ct.properties.every((p) => isDelegatedKind(p.kind))) continue;

    const distinctHigher = pipe(
      ct.properties,
      RA.map((p) => p.directTargetId),
      RA.uniq(S.Eq),
    );
    const distinctLower = pipe(
      ct.properties,
      RA.map((p) => p.ownerComponentId),
      RA.uniq(S.Eq),
    );
    if (distinctHigher.length !== 1 || distinctLower.length !== 1) continue;

    const higherId = distinctHigher[0]!;
    const lowerId = distinctLower[0]!;
    const higherComp = graph.componentsById[higherId];
    const lowerComp = graph.componentsById[lowerId];
    if (!higherComp || !lowerComp) continue;

    // Encapsulation deadlock guard: only suggest direct tests for EXPORTED components
    if (!lowerComp.isExported) continue;
    // Only flag when lower component has ZERO direct unit tests (otherwise handled by no-redundant-test-scope)
    if ((directIndex.testsByComponent[lowerId]?.length ?? 0) > 0) continue;
    // Higher component must genuinely compose/orchestrate (>= 2 dependencies) rather than be a trivial alias
    if (higherComp.transitiveCallees.length < 2) continue;

    const edgeKey = makeEdgeKey(higherId, lowerId);
    const list = byEdge.get(edgeKey) ?? [];
    list.push({
      ct,
      higherId,
      lowerId,
      propertyLabel: ct.properties[0]!.label,
      caseCount: ct.properties.length * ct.test.eachCount,
    });
    byEdge.set(edgeKey, list);
  }

  const findings: Array<LowestLevelFinding> = [];
  for (const entries of byEdge.values()) {
    const totalCases = entries.reduce((acc, e) => acc + e.caseCount, 0);
    if (totalCases < options.minDelegatedCases) continue;

    for (const entry of entries) {
      const higherComp = graph.componentsById[entry.higherId];
      const lowerComp = graph.componentsById[entry.lowerId];
      findings.push({
        testName: entry.ct.test.fullName,
        fileName: entry.ct.test.fileName,
        line: entry.ct.test.line,
        locationKey: entry.ct.test.locationKey,
        property: entry.propertyLabel,
        higherComponent: higherComp?.name ?? entry.higherId,
        lowerComponent: lowerComp?.name ?? entry.lowerId,
        caseCount: totalCases,
      });
    }
  }

  return findings;
};

const areComponentsRelated = (
  aId: string,
  bId: string,
  test: ExtractedTestCase,
  graph: ProductionGraph,
): boolean => {
  if (aId === bId) return true;
  const a = graph.componentsById[aId];
  const b = graph.componentsById[bId];
  if (!a || !b) return false;

  // Same production module (cohesive unit / round-trip pair like encode + decode)
  if (a.fileName === b.fileName) return true;
  // Direct or transitive call hierarchy
  if (a.transitiveCallees.includes(bId) || b.transitiveCallees.includes(aId)) return true;
  // Dataflow edge inside the test (e.g. calculateTotal([parsePrice("$10")]))
  if (
    test.dataflowEdges.some(
      (e) =>
        (e.fromComponentId === aId && e.toComponentId === bId) ||
        (e.fromComponentId === bId && e.toComponentId === aId),
    )
  ) {
    return true;
  }
  // Jointly asserted in a single assertion (system invariant)
  if (
    test.assertions.some(
      (assertion) =>
        assertion.referencedComponents.includes(aId) &&
        assertion.referencedComponents.includes(bId),
    )
  ) {
    return true;
  }
  return false;
};

const computeResponsibilityClusters = (
  assertedIds: ReadonlyArray<string>,
  test: ExtractedTestCase,
  graph: ProductionGraph,
): ReadonlyArray<ReadonlyArray<string>> => {
  const visited = new Set<string>();
  const clusters: Array<ReadonlyArray<string>> = [];

  for (const start of assertedIds) {
    if (visited.has(start)) continue;
    const queue = [start];
    const cluster: Array<string> = [];
    visited.add(start);

    while (queue.length > 0) {
      const curr = queue.shift()!;
      cluster.push(curr);
      for (const other of assertedIds) {
        if (!visited.has(other) && areComponentsRelated(curr, other, test, graph)) {
          visited.add(other);
          queue.push(other);
        }
      }
    }

    clusters.push(cluster.map((id) => graph.componentsById[id]?.name ?? id).sort());
  }

  return clusters;
};

const detectSingleResponsibilityViolations = (
  classifiedTests: ReadonlyArray<ClassifiedTestCase>,
  graph: ProductionGraph,
  options: TestScopeOptions,
): ReadonlyArray<SingleResponsibilityFinding> => {
  const findings: Array<SingleResponsibilityFinding> = [];

  for (const ct of classifiedTests) {
    const { test } = ct;
    const assertedIds = pipe(
      test.assertions,
      RA.flatMap((a) => [
        ...(O.isSome(a.subjectComponentId) ? [a.subjectComponentId.value] : []),
        ...a.referencedComponents,
      ]),
      RA.filter((id) => graph.componentsById[id] !== undefined),
      RA.uniq(S.Eq),
    );

    if (assertedIds.length < options.minUnrelatedComponents) continue;

    const clusters = computeResponsibilityClusters(assertedIds, test, graph);
    if (clusters.length >= options.minUnrelatedComponents) {
      findings.push({
        testName: test.fullName,
        fileName: test.fileName,
        line: test.line,
        locationKey: test.locationKey,
        groups: clusters,
      });
    }
  }

  return findings;
};

// ---------------------------------------------------------------------------
// Public Entrypoint (Memoized by Program & Options)
// ---------------------------------------------------------------------------

const indexByFile = <T extends Readonly<Record<"fileName", string>>>(
  items: ReadonlyArray<T>,
): Readonly<Record<string, ReadonlyArray<T>>> => {
  const map: Record<string, Array<T>> = {};
  for (const item of items) {
    const existing = map[item.fileName] ?? [];
    existing.push(item);
    map[item.fileName] = existing;
  }
  return map;
};

const computeTestScopeAnalysis = (
  program: ts.Program,
  options: TestScopeOptions,
): TestScopeAnalysis => {
  const checker = program.getTypeChecker();
  const graph = buildProductionGraph(program, options.testPatterns);
  const sourceFiles = getProjectSourceFiles(program);

  const extractedTests: Array<ExtractedTestCase> = [];
  for (const sf of sourceFiles) {
    const fileName = normalizeFilePath(sf.fileName);
    if (!isMatchingAnyPattern(fileName, options.testPatterns)) continue;
    extractedTests.push(...extractTestCasesFromFile(sf, checker, graph));
  }

  const directIndex = buildDirectComponentIndex(extractedTests, graph);
  const classifiedTests = extractedTests.map((t) => classifyTestCase(t, graph, directIndex));

  const redundancyFindings = detectRedundancies(classifiedTests, graph, directIndex, options);
  const lowestLevelFindings = detectLowestLevelViolations(
    classifiedTests,
    graph,
    directIndex,
    options,
  );
  const responsibilityFindings = detectSingleResponsibilityViolations(
    classifiedTests,
    graph,
    options,
  );

  const tests: ReadonlyArray<TestCaseSummary> = classifiedTests.map((ct) => ({
    id: ct.test.id,
    name: ct.test.name,
    fullName: ct.test.fullName,
    fileName: ct.test.fileName,
    line: ct.test.line,
    locationKey: ct.test.locationKey,
    classification: ct.classification,
    directTargets: ct.test.directTargets.map((id) => graph.componentsById[id]?.name ?? id),
    mockedTargets: ct.test.mockedTargets.map((id) => graph.componentsById[id]?.name ?? id),
  }));

  return {
    tests,
    redundancyByFile: indexByFile(redundancyFindings),
    lowestLevelByFile: indexByFile(lowestLevelFindings),
    responsibilityByFile: indexByFile(responsibilityFindings),
  };
};

const analysisCache = new WeakMap<ts.Program, Readonly<Record<string, TestScopeAnalysis>>>();

export const analyzeTestScope = (
  program: ts.Program,
  options: TestScopeOptions = DEFAULT_TEST_SCOPE_OPTIONS,
): TestScopeAnalysis => {
  const key = JSON.stringify({
    testPatterns: [...options.testPatterns].sort(),
    minRepeatedCases: options.minRepeatedCases,
    minDelegatedCases: options.minDelegatedCases,
    minUnrelatedComponents: options.minUnrelatedComponents,
    checkSameLevelDuplicates: options.checkSameLevelDuplicates,
  });
  return memoizeByProgramAndKey(program, key, analysisCache, (p) =>
    computeTestScopeAnalysis(p, options),
  );
};
