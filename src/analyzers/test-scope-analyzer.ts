import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import * as S from "fp-ts/lib/string.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { memoizeByProgramAndKey } from "../lib/program-memo.js";
import { collectProjectSourceFiles, isMatchingAnyPattern, normalizeFilePath } from "../lib/source-paths.js";
import { makeLocationKey, resolveTsNodeLocation } from "../lib/ts-node-location.js";
import { collectTsNodes } from "../lib/ts-node-traversal.js";
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

export type TestScopeOptions = Readonly<
  Record<"minRepeatedCases" | "minDelegatedCases" | "minUnrelatedComponents", number> & {
    readonly testPatterns: ReadonlyArray<string>;
    readonly checkSameLevelDuplicates: "enabled" | "disabled";
  }
>;

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
// Internal Domain Models
// ---------------------------------------------------------------------------

type ExportVisibility = "exported" | "private";
type ExpectRejectionMode = "rejects" | "standard";
type CompositionCoverage = "covered" | "uncovered";

type SubjectTarget =
  | Readonly<Record<"tag", "component"> & Record<"componentId", string>>
  | Readonly<Record<"tag", "untracked">>;

type FingerprintValue =
  | Readonly<Record<"tag", "literal"> & Record<"value", string>>
  | Readonly<Record<"tag", "dynamic">>;

type ExpectedArgPresence =
  | Readonly<Record<"tag", "present"> & { readonly expression: ts.Expression }>
  | Readonly<Record<"tag", "absent">>;

type AssertionCategory =
  | "equality"
  | "error"
  | "spy-interaction"
  | "predicate"
  | "containment"
  | "shape"
  | "other";

type RawProductionFn = Readonly<
  Record<"id" | "name" | "fileName", string> &
    Record<"line", number> & {
      readonly visibility: ExportVisibility;
      readonly symbol: O.Option<ts.Symbol>;
      readonly fnNode: ts.FunctionLikeDeclaration;
    }
>;

type BodyProvenance = Readonly<{
  readonly directCallees: ReadonlyArray<string>;
  readonly returnFieldProvenance: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly directReturnProvenance: ReadonlyArray<string>;
  readonly errorProvenance: ReadonlyArray<string>;
}>;

type AnalyzedProductionFn = Readonly<
  BodyProvenance & {
    readonly raw: RawProductionFn;
  }
>;

type ProductionComponent = Readonly<
  Record<"id" | "name" | "fileName", string> &
    Record<"line", number> &
    BodyProvenance & {
      readonly visibility: ExportVisibility;
      readonly symbol: O.Option<ts.Symbol>;
      readonly fnNode: ts.FunctionLikeDeclaration;
      readonly transitiveCallees: ReadonlyArray<string>;
    }
>;

type ComponentMap = Readonly<Record<string, ProductionComponent>>;

type ProductionGraph = Readonly<{
  readonly componentsById: ComponentMap;
  readonly idBySymbol: ReadonlyMap<ts.Symbol, string>;
  readonly idsByFile: Readonly<Record<string, ReadonlyArray<string>>>;
}>;

type SymbolLookup = Readonly<{
  readonly checker: ts.TypeChecker;
  readonly idBySymbol: ReadonlyMap<ts.Symbol, string>;
}>;

type OriginEnv = Readonly<{
  readonly lookup: SymbolLookup;
  readonly localVarOrigins: ReadonlyMap<ts.Symbol, ReadonlyArray<string>>;
}>;

type FnBodySpec = Readonly<
  Record<"selfId", string> & {
    readonly body: ts.ConciseBody;
    readonly sf: ts.SourceFile;
  }
>;

type FileExportScope = Readonly<
  Record<"fileName", string> & {
    readonly sf: ts.SourceFile;
    readonly checker: ts.TypeChecker;
    readonly exportedDecls: ReadonlySet<ts.Node>;
    readonly exportedSyms: ReadonlySet<ts.Symbol>;
  }
>;

type ExtractedAssertion = Readonly<
  Record<"matcher", string> & {
    readonly category: AssertionCategory;
    readonly subjectTarget: SubjectTarget;
    readonly projectedPath: ReadonlyArray<string>;
    readonly inputFingerprint: FingerprintValue;
    readonly expectedFingerprint: FingerprintValue;
    readonly expectedObjectKeys: ReadonlyArray<string>;
    readonly referencedComponents: ReadonlyArray<string>;
    readonly referencedSubjectFields: ReadonlyArray<string>;
  }
>;

type DataflowEdge = Readonly<Record<"fromComponentId" | "toComponentId", string>>;

type ExtractedTestCase = Readonly<
  Record<"id" | "name" | "fullName" | "fileName" | "locationKey", string> &
    Record<"line" | "eachCount", number> & {
      readonly directTargets: ReadonlyArray<string>;
      readonly mockedTargets: ReadonlyArray<string>;
      readonly assertions: ReadonlyArray<ExtractedAssertion>;
      readonly dataflowEdges: ReadonlyArray<DataflowEdge>;
    }
>;

type LocalTestBinding = Readonly<
  Record<"componentId", string> & {
    readonly projectedPath: ReadonlyArray<string>;
    readonly inputFingerprint: FingerprintValue;
  }
>;

type LocalWrapperEntry = Readonly<{
  readonly symbol: ts.Symbol;
  readonly body: ts.ConciseBody;
}>;

type TestFileEnv = Readonly<
  Record<"fileName", string> & {
    readonly sf: ts.SourceFile;
    readonly checker: ts.TypeChecker;
    readonly graph: ProductionGraph;
    readonly localWrapperMap: ReadonlyMap<ts.Symbol, ReadonlyArray<string>>;
  }
>;

type TestTraceEnv = Readonly<{
  readonly checker: ts.TypeChecker;
  readonly idBySymbol: ReadonlyMap<ts.Symbol, string>;
  readonly localBindings: ReadonlyMap<ts.Symbol, LocalTestBinding>;
  readonly localWrapperMap: ReadonlyMap<ts.Symbol, ReadonlyArray<string>>;
}>;

type ScopeWalkContext = Readonly<{
  readonly describeStack: ReadonlyArray<string>;
  readonly scopeMocks: ReadonlySet<string>;
  readonly fileEnv: TestFileEnv;
}>;

type ParsedExpectChain = Readonly<
  Record<"matcher", string> & {
    readonly expectArg: ts.Expression;
    readonly expectedArg: ExpectedArgPresence;
    readonly rejectionMode: ExpectRejectionMode;
  }
>;

type TestRegistration = Readonly<
  Record<"name", string> &
    Record<"eachCount", number> & {
      readonly callNode: ts.CallExpression;
      readonly callback: ts.FunctionLikeDeclaration;
    }
>;

type DescribeRegistration = Readonly<
  Record<"title", string> & {
    readonly body: ts.Node;
  }
>;

type ExprReferenceContribution = Readonly<{
  readonly components: ReadonlyArray<string>;
  readonly subjectFields: ReadonlyArray<string>;
}>;

type TestPass1State = Readonly<{
  readonly directTargets: ReadonlyArray<string>;
  readonly localBindings: ReadonlyMap<ts.Symbol, LocalTestBinding>;
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

type InferredProperty = Readonly<
  Record<"directTargetId" | "ownerComponentId" | "label", string> & {
    readonly kind: InferredPropertyKind;
    readonly assertion: ExtractedAssertion;
  }
>;

type ClassifiedTestCase = Readonly<{
  readonly test: ExtractedTestCase;
  readonly properties: ReadonlyArray<InferredProperty>;
  readonly classification: TestClassification;
}>;

type DirectErrorSignature = Readonly<{
  readonly inputFp: FingerprintValue;
  readonly expectedFp: FingerprintValue;
}>;

type DirectComponentIndex = Readonly<{
  readonly testsByComponent: Readonly<Record<string, ReadonlyArray<ExtractedTestCase>>>;
  readonly errorSigsByComponent: Readonly<Record<string, ReadonlyArray<DirectErrorSignature>>>;
  readonly valuePairsByComponent: Readonly<Record<string, ReadonlySet<string>>>;
}>;

type ScopeIndexContext = Readonly<{
  readonly components: ComponentMap;
  readonly directIndex: DirectComponentIndex;
}>;

type AssertionEvalEnv = Readonly<{
  readonly mockedSet: ReadonlySet<string>;
  readonly components: ComponentMap;
  readonly directIndex: DirectComponentIndex;
}>;

type ComponentFilterEnv = Readonly<{
  readonly mockedSet: ReadonlySet<string>;
  readonly components: ComponentMap;
}>;

type TrackedAssertionInput = Readonly<
  Record<"directId", string> & {
    readonly assertion: ExtractedAssertion;
    readonly component: ProductionComponent;
    readonly evalEnv: AssertionEvalEnv;
  }
>;

type TestPropertyBundle = Readonly<{
  readonly test: ExtractedTestCase;
  readonly properties: ReadonlyArray<InferredProperty>;
}>;

type TestComponentContext = Readonly<{
  readonly test: ExtractedTestCase;
  readonly components: ComponentMap;
}>;

type ClassifiedTestSuite = Readonly<{
  readonly classifiedTests: ReadonlyArray<ClassifiedTestCase>;
  readonly components: ComponentMap;
}>;

type SingleEdgeDelegation = Readonly<
  Record<"higherId" | "lowerId" | "propertyLabel", string> &
    Record<"caseCount", number> & {
      readonly ct: ClassifiedTestCase;
    }
>;

type ConcreteTestEntry = Readonly<
  Record<"targetLabel", string> & {
    readonly test: ExtractedTestCase;
    readonly signatures: ReadonlySet<string>;
  }
>;

type DuplicateScanState = Readonly<{
  readonly seenByBucket: Readonly<Record<string, ReadonlyArray<ConcreteTestEntry>>>;
  readonly findings: ReadonlyArray<DuplicateSameLevelFinding>;
}>;

type RuleEvaluationContext = Readonly<{
  readonly classifiedTests: ReadonlyArray<ClassifiedTestCase>;
  readonly scopeContext: ScopeIndexContext;
  readonly options: TestScopeOptions;
}>;

type FrontierState = Readonly<{
  readonly frontier: ReadonlyArray<string>;
  readonly visited: ReadonlySet<string>;
}>;

type TransitiveWalkInput = Readonly<
  Record<"startId", string> & {
    readonly directById: Readonly<Record<string, ReadonlyArray<string>>>;
  }
>;

type ComponentPair = Readonly<Record<"leftId" | "rightId", string>>;

type ClusterFrontierState = Readonly<{
  readonly frontier: ReadonlyArray<string>;
  readonly visited: ReadonlySet<string>;
  readonly members: ReadonlyArray<string>;
}>;

type ClusterWalkContext = Readonly<{
  readonly assertedIds: ReadonlyArray<string>;
  readonly subject: TestComponentContext;
}>;

type ClusterAccum = Readonly<{
  readonly visited: ReadonlySet<string>;
  readonly clusters: ReadonlyArray<ReadonlyArray<string>>;
}>;

type TargetTestPair = Readonly<
  Record<"targetId", string> & {
    readonly test: ExtractedTestCase;
  }
>;

// ---------------------------------------------------------------------------
// Token Sets, Empty Sentinels & Leaf Formatters
// ---------------------------------------------------------------------------

const TEST_FN_NAMES: ReadonlySet<string> = new Set(["it", "test"]);
const DESCRIBE_FN_NAMES: ReadonlySet<string> = new Set(["describe", "suite"]);
const MOCK_RUNNER_NAMES: ReadonlySet<string> = new Set(["vi", "jest"]);
const PIPE_FN_NAMES: ReadonlySet<string> = new Set(["pipe"]);
const UNDEFINED_IDENT_NAMES: ReadonlySet<string> = new Set(["undefined"]);
const MOCK_METHOD_NAMES: ReadonlySet<string> = new Set(["mock"]);
const SPY_ON_METHOD_NAMES: ReadonlySet<string> = new Set(["spyOn"]);
const REJECTS_PROP_NAMES: ReadonlySet<string> = new Set(["rejects"]);
const EXPECT_CHAIN_MODIFIERS: ReadonlySet<string> = new Set(["not", "resolves", "rejects"]);
const EXPECT_FN_NAMES: ReadonlySet<string> = new Set(["expect"]);
const ASSERT_FN_NAMES: ReadonlySet<string> = new Set(["assert"]);
const EACH_METHOD_NAMES: ReadonlySet<string> = new Set(["each"]);
const TAG_PROP_NAMES: ReadonlySet<string> = new Set(["_tag"]);
const FP_ERROR_TAGS: ReadonlySet<string> = new Set(["Left", "None"]);
const FP_ERROR_CHECK_METHODS: ReadonlySet<string> = new Set(["isLeft", "isNone"]);

const SPY_MATCHERS: ReadonlySet<string> = new Set([
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

const EQUALITY_MATCHERS: ReadonlySet<string> = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toBeCloseTo",
  "equal",
  "strictEqual",
  "deepEqual",
  "deepStrictEqual",
]);

const ERROR_MATCHERS: ReadonlySet<string> = new Set([
  "toThrow",
  "toThrowError",
  "toThrowErrorMatchingSnapshot",
  "toThrowErrorMatchingInlineSnapshot",
  "throws",
  "rejects",
]);

const PREDICATE_MATCHERS: ReadonlySet<string> = new Set([
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

const CONTAINMENT_MATCHERS: ReadonlySet<string> = new Set([
  "toContain",
  "toContainEqual",
  "toMatch",
  "toHaveLength",
  "match",
]);

const SHAPE_MATCHERS: ReadonlySet<string> = new Set([
  "toMatchObject",
  "toHaveProperty",
  "toBeInstanceOf",
]);

const MOCK_IMPL_METHODS: ReadonlySet<string> = new Set([
  "mockReturnValue",
  "mockReturnValueOnce",
  "mockResolvedValue",
  "mockResolvedValueOnce",
  "mockRejectedValue",
  "mockRejectedValueOnce",
  "mockImplementation",
  "mockImplementationOnce",
]);

const TRAILING_SEGMENT_RE = /\/[^/]+$/;
const SCRIPT_EXT_RE = /\.(?:js|mjs|cjs|ts|tsx)$/;
const TS_EXT_RE = /\.(?:ts|tsx)$/;
const LEADING_DOT_SLASH_RE = /^\.\//;

const EMPTY_STRINGS: ReadonlyArray<string> = [];
const EMPTY_SYMBOLS: ReadonlyArray<ts.Symbol> = [];
const EMPTY_RAW_FNS: ReadonlyArray<RawProductionFn> = [];
const EMPTY_LOCAL_WRAPPERS: ReadonlyArray<LocalWrapperEntry> = [];
const EMPTY_FIELD_ORIGINS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [];
const EMPTY_BINDING_ENTRIES: ReadonlyArray<readonly [ts.Symbol, LocalTestBinding]> = [];
const EMPTY_SYMBOL_ID_ENTRIES: ReadonlyArray<readonly [ts.Symbol, string]> = [];
const EMPTY_LOWEST_FINDINGS: ReadonlyArray<LowestLevelFinding> = [];
const DYNAMIC_FINGERPRINT: FingerprintValue = { tag: "dynamic" };
const ABSENT_EXPECTED_ARG: ExpectedArgPresence = { tag: "absent" };
const EMPTY_REF_CONTRIBUTION: ExprReferenceContribution = {
  components: EMPTY_STRINGS,
  subjectFields: EMPTY_STRINGS,
};
const EMPTY_BODY_PROVENANCE: BodyProvenance = {
  directCallees: EMPTY_STRINGS,
  returnFieldProvenance: {},
  directReturnProvenance: EMPTY_STRINGS,
  errorProvenance: EMPTY_STRINGS,
};

const makeComponentId = (fileName: string, name: string) => `${fileName}#${name}`;
const makeEdgeKey = (higherId: string, lowerId: string) => `${higherId}->${lowerId}`;
const makeValuePairKey = (inputFp: string, expectedFp: string) => `${inputFp}=>${expectedFp}`;
const formatMethodName = (className: string, memberName: string) => `${className}.${memberName}`;
const formatDefaultPropName = (propName: string) => `default.${propName}`;
const formatStrFingerprint = (jsonText: string) => `str:${jsonText}`;
const formatBracketList = (joined: string) => `[${joined}]`;
const formatBraceList = (joined: string) => `{${joined}}`;
const formatParenList = (joined: string) => `(${joined})`;
const formatQualifiedTestName = (prefix: string, name: string) => `${prefix} > ${name}`;
const formatTestId = (fileName: string, startText: string) => `${fileName}@${startText}`;
const formatInvariantLabel = (name: string) => `${name} system invariant`;
const formatCrossFieldLabel = (name: string) => `${name} cross-field invariant`;
const formatCompositionLabel = (name: string) => `${name} composition`;
const formatProjectedLabel = (name: string, pathText: string) => `${name} (.${pathText})`;
const formatErrorLabel = (name: string) => `${name} error handling`;
const formatBehaviorLabel = (name: string) => `${name} behavior`;
const formatBucketKeyParts = (targets: string, mocks: string) => `${targets}::mocks=${mocks}`;
const joinComma = (items: ReadonlyArray<string>) => items.join(",");
const joinCommaSpace = (items: ReadonlyArray<string>) => items.join(", ");
const joinDot = (items: ReadonlyArray<string>) => items.join(".");
const joinPipe = (items: ReadonlyArray<string>) => items.join("|");
const joinDescribeStack = (items: ReadonlyArray<string>) => items.join(" > ");
const formatInt = (value: number) => String(value);
const formatJsonString = (text: string) => JSON.stringify(text);
const stringifyOptionsPayload = (payload: TestScopeOptions) => JSON.stringify(payload);
const clampMinOne = (count: number) => Math.max(1, count);
const extractParentDir = (filePath: string) => filePath.replace(TRAILING_SEGMENT_RE, "");
const stripScriptExt = (spec: string) => spec.replace(SCRIPT_EXT_RE, "");
const stripLeadingDotSlash = (spec: string) => spec.replace(LEADING_DOT_SLASH_RE, "");
const stripTsExt = (filePath: string) => filePath.replace(TS_EXT_RE, "");
const hasSlashSuffix = (candidate: string, suffix: string) => candidate.endsWith(`/${suffix}`);
const hasExactFilePath = (candidate: string, dir: string, spec: string) =>
  candidate === `${dir}/${spec}`;
const normalizeMockSpecifier = flow(stripScriptExt, stripLeadingDotSlash);
const resolveSourceDir = flow(
  (sf: ts.SourceFile) => sf.fileName,
  normalizeFilePath,
  extractParentDir,
);
const dedupeSortedStrings = flow(RA.uniq(S.Eq), RA.sort(S.Ord));
const sortStringSet = flow((items: ReadonlySet<string>) => [...items], RA.sort(S.Ord));
const toReadonlySet = (items: ReadonlyArray<string>) => new Set<string>(items);
const toLookupMap = <K, V>(entries: ReadonlyArray<readonly [K, V]>) =>
  new Map(entries) as ReadonlyMap<K, V>;
const extendLookupMap = <K, V>(
  base: ReadonlyMap<K, V>,
  extras: ReadonlyArray<readonly [K, V]>,
) => new Map([...base.entries(), ...extras]) as ReadonlyMap<K, V>;
const toReadonlyRecord = RR.fromEntries;
const hasStringMember = (items: ReadonlyArray<string>, target: string) =>
  RA.some((item: string) => item === target)(items);
const hasBody = (node: ts.MethodDeclaration | ts.FunctionDeclaration) => Boolean(node.body);
const hasName = (node: ts.FunctionDeclaration) => Boolean(node.name);
const hasInitializer = (node: ts.VariableDeclaration) => Boolean(node.initializer);
const formatNodeStart = (node: ts.Node, sf: ts.SourceFile) => formatInt(node.getStart(sf));

const lookupRecordList = <T>(
  key: string,
  rec: Readonly<Record<string, ReadonlyArray<T>>>,
) =>
  flow(
    (table: Readonly<Record<string, ReadonlyArray<T>>>) => RR.lookup(key)(table),
    O.getOrElse(() => [] as ReadonlyArray<T>),
  )(rec);

const lookupMapOption = <K, V>(key: K, map: ReadonlyMap<K, V>) => O.fromNullable(map.get(key));

const lookupMapList = <K, T>(key: K, map: ReadonlyMap<K, ReadonlyArray<T>>) =>
  flow(
    (table: ReadonlyMap<K, ReadonlyArray<T>>) => lookupMapOption(key, table),
    O.getOrElse(() => [] as ReadonlyArray<T>),
  )(map);

const resolveNodeSymbol = (node: ts.Node, checker: ts.TypeChecker) =>
  O.fromNullable(checker.getSymbolAtLocation(node));

const resolveShorthandSymbol = (
  node: ts.ShorthandPropertyAssignment,
  checker: ts.TypeChecker,
) => O.fromNullable(checker.getShorthandAssignmentValueSymbol(node));

const resolveNodeParent = (node: ts.Node) => O.fromNullable(node.parent);
const resolveDeclFilePath = (decl: ts.Declaration) => normalizeFilePath(decl.getSourceFile().fileName);

const toFingerprintValue = O.match<string, FingerprintValue>(
  () => DYNAMIC_FINGERPRINT,
  (value) => ({ tag: "literal", value }),
);

const toSubjectTarget = O.match<string, SubjectTarget>(
  () => ({ tag: "untracked" }),
  (componentId) => ({ tag: "component", componentId }),
);

const toExpectedArgPresence = O.match<ts.Expression, ExpectedArgPresence>(
  () => ABSENT_EXPECTED_ARG,
  (expression) => ({ tag: "present", expression }),
);

const appendGroupedItem = <T>(
  acc: Readonly<Record<string, ReadonlyArray<T>>>,
  key: string,
  item: T,
) =>
  ({
    ...acc,
    [key]: [...lookupRecordList(key, acc), item],
  }) satisfies Readonly<Record<string, ReadonlyArray<T>>>;

const groupItemsByKey = <T>(items: ReadonlyArray<T>, selectKey: (item: T) => string) =>
  RA.reduce<T, Readonly<Record<string, ReadonlyArray<T>>>>({}, (acc, item) =>
    appendGroupedItem(acc, selectKey(item), item),
  )(items);

const lookupComponent = (id: string, components: ComponentMap) => RR.lookup(id)(components);
const hasComponent = (id: string, components: ComponentMap) => RR.has(id, components);

const resolveComponentName = (id: string, components: ComponentMap) =>
  flow(
    (cid: string) => lookupComponent(cid, components),
    O.map((comp) => comp.name),
    O.getOrElse(() => id),
  )(id);

const isSourceFileMatchingPatterns = (sf: ts.SourceFile, patterns: ReadonlyArray<string>) =>
  isMatchingAnyPattern(normalizeFilePath(sf.fileName), patterns);

// ---------------------------------------------------------------------------
// Shared AST Predicates & Symbol Resolution
// ---------------------------------------------------------------------------

const isNamedPropertyKey = (name: ts.PropertyName): name is ts.Identifier | ts.StringLiteral =>
  ts.isIdentifier(name) || ts.isStringLiteral(name);

const isFunctionValueExpr = (
  expr: ts.Expression,
): expr is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(expr) || ts.isFunctionExpression(expr);

const isStringLikeLiteral = (
  expr: ts.Expression,
): expr is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr);

const isResolvableSymbolExpr = (
  expr: ts.Expression,
): expr is ts.Identifier | ts.PropertyAccessExpression =>
  ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr);

const isNamedPropertyAssignment = (
  prop: ts.ObjectLiteralElementLike,
): prop is ts.PropertyAssignment & Readonly<{ readonly name: ts.Identifier | ts.StringLiteral }> =>
  ts.isPropertyAssignment(prop) && isNamedPropertyKey(prop.name);

const isNamedMethodWithBody = (
  member: ts.ClassElement | ts.ObjectLiteralElementLike,
): member is ts.MethodDeclaration &
  Readonly<{ readonly name: ts.Identifier | ts.StringLiteral; readonly body: ts.Block }> =>
  ts.isMethodDeclaration(member) && hasBody(member) && isNamedPropertyKey(member.name);

const isInitializedIdentVar = (
  decl: ts.VariableDeclaration,
): decl is ts.VariableDeclaration &
  Readonly<{ readonly name: ts.Identifier; readonly initializer: ts.Expression }> =>
  ts.isIdentifier(decl.name) && hasInitializer(decl);

const isIdentBasedPropertyAccess = (
  expr: ts.Expression,
): expr is ts.PropertyAccessExpression & Readonly<{ readonly expression: ts.Identifier }> =>
  ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression);

const isPipeCallExpression = (call: ts.CallExpression) =>
  ts.isIdentifier(call.expression) && PIPE_FN_NAMES.has(call.expression.text);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive ancestor check
const isOwnBodyNode = (node: ts.Node, boundary: ts.Node): boolean =>
  ts.isFunctionLike(node)
    ? false
    : node === boundary ||
      flow(
        resolveNodeParent,
        O.exists((parent) => isOwnBodyNode(parent, boundary)),
      )(node);

const collectOwnBodyNodes = (body: ts.Node, sf: ts.SourceFile) =>
  RA.filter((node: ts.Node) => isOwnBodyNode(node, body))(collectTsNodes(body, sf));

const lookupComponentIdBySymbol = (
  targetSym: ts.Symbol,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
) =>
  flow(
    (s: ts.Symbol) => resolveCanonicalSymbol(s, checker),
    (canonical) => lookupMapOption(canonical, idBySymbol),
    O.alt(() => lookupMapOption(targetSym, idBySymbol)),
  )(targetSym);

const resolveSymbolOptionToComponentId = (
  symOpt: O.Option<ts.Symbol>,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
) => O.flatMap((s: ts.Symbol) => lookupComponentIdBySymbol(s, checker, idBySymbol))(symOpt);

const resolveExpressionToComponentId = (
  expr: ts.Expression,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
) =>
  flow(
    unwrapExpression,
    O.fromPredicate(isResolvableSymbolExpr),
    O.flatMap((node) => resolveNodeSymbol(node, checker)),
    O.flatMap((sym) => lookupComponentIdBySymbol(sym, checker, idBySymbol)),
  )(expr);

const hasRethrowInBlock = (block: ts.Block, sf: ts.SourceFile) =>
  RA.some(ts.isThrowStatement)(collectOwnBodyNodes(block, sf));

const isSwallowingTryNode = (node: ts.Node, sf: ts.SourceFile) =>
  ts.isTryStatement(node) &&
  flow(
    (stmt: ts.TryStatement) => O.fromNullable(stmt.catchClause),
    O.exists((clause) => !hasRethrowInBlock(clause.block, sf)),
  )(node);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive parent walk
const isInsideSwallowingTryCatch = (node: ts.Node, boundary: ts.Node, sf: ts.SourceFile): boolean =>
  flow(
    resolveNodeParent,
    O.filter((parent) => parent !== boundary),
    O.exists(
      (parent) =>
        isSwallowingTryNode(parent, sf) || isInsideSwallowingTryCatch(parent, boundary, sf),
    ),
  )(node);

// ---------------------------------------------------------------------------
// Stage 1A: Production Component Graph & Return/Error Provenance
// ---------------------------------------------------------------------------

const isCanonicalExported = (sym: ts.Symbol, ctx: FileExportScope) =>
  ctx.exportedSyms.has(resolveCanonicalSymbol(sym, ctx.checker));

const EXPORTED_VISIBILITY: ExportVisibility = "exported";
const PRIVATE_VISIBILITY: ExportVisibility = "private";

const resolveExportVisibility = (
  node: ts.Node,
  sym: O.Option<ts.Symbol>,
  ctx: FileExportScope,
) =>
  ctx.exportedDecls.has(node) || O.exists((s: ts.Symbol) => isCanonicalExported(s, ctx))(sym)
    ? EXPORTED_VISIBILITY
    : PRIVATE_VISIBILITY;

const resolveNodeVisibility = (node: ts.Node, nameNode: ts.Identifier, ctx: FileExportScope) =>
  resolveExportVisibility(node, resolveNodeSymbol(nameNode, ctx.checker), ctx);

const makeRawProductionFn = (
  name: string,
  fn: ts.FunctionLikeDeclaration,
  reportNode: ts.Node,
  sym: O.Option<ts.Symbol>,
  visibility: ExportVisibility,
  ctx: FileExportScope,
) =>
  ({
    id: makeComponentId(ctx.fileName, name),
    name,
    fileName: ctx.fileName,
    line: resolveTsNodeLocation(reportNode, ctx.sf).line,
    visibility,
    symbol: sym,
    fnNode: fn,
  }) satisfies RawProductionFn;

const buildNamedFnDeclRecord = (
  node: ts.FunctionDeclaration,
  nameNode: ts.Identifier,
  ctx: FileExportScope,
) => {
  const sym = resolveNodeSymbol(nameNode, ctx.checker);
  return makeRawProductionFn(
    nameNode.text,
    node,
    node,
    sym,
    resolveExportVisibility(node, sym, ctx),
    ctx,
  );
};

const extractFnDeclRecord = (node: ts.FunctionDeclaration, ctx: FileExportScope) =>
  node.body && node.name ? [buildNamedFnDeclRecord(node, node.name, ctx)] : EMPTY_RAW_FNS;

const buildVarFnRecord = (
  node: ts.VariableDeclaration,
  nameIdent: ts.Identifier,
  init: ts.ArrowFunction | ts.FunctionExpression,
  ctx: FileExportScope,
) => {
  const sym = resolveNodeSymbol(nameIdent, ctx.checker);
  return makeRawProductionFn(
    nameIdent.text,
    init,
    node,
    sym,
    resolveExportVisibility(node, sym, ctx),
    ctx,
  );
};

const extractVarDeclRecord = (node: ts.VariableDeclaration, ctx: FileExportScope) =>
  isInitializedIdentVar(node)
    ? flow(
        unwrapExpression,
        O.fromPredicate(isFunctionValueExpr),
        O.map((init) => buildVarFnRecord(node, node.name, init, ctx)),
      )(node.initializer)
    : O.none;

const buildMethodRecord = (
  member: ts.MethodDeclaration &
    Readonly<{ readonly name: ts.Identifier | ts.StringLiteral; readonly body: ts.Block }>,
  className: string,
  visibility: ExportVisibility,
  ctx: FileExportScope,
) =>
  makeRawProductionFn(
    formatMethodName(className, member.name.text),
    member,
    member,
    resolveNodeSymbol(member.name, ctx.checker),
    visibility,
    ctx,
  );

const filterClassMethodRecords = (
  members: ReadonlyArray<ts.ClassElement>,
  registerMember: (
    member: ts.MethodDeclaration &
      Readonly<{ readonly name: ts.Identifier | ts.StringLiteral; readonly body: ts.Block }>,
  ) => RawProductionFn,
) =>
  RA.filterMap((member: ts.ClassElement) =>
    isNamedMethodWithBody(member) ? O.some(registerMember(member)) : O.none,
  )(members);

const extractClassDeclRecords = (node: ts.ClassDeclaration, ctx: FileExportScope) =>
  node.name
    ? flow(
        (nameNode: ts.Identifier) => ({
          className: nameNode.text,
          visibility: resolveNodeVisibility(node, nameNode, ctx),
        }),
        ({ className, visibility }) =>
          filterClassMethodRecords(node.members, (member) =>
            buildMethodRecord(member, className, visibility, ctx),
          ),
      )(node.name)
    : EMPTY_RAW_FNS;

const buildDefaultPropInitRecord = (
  init: ts.ArrowFunction | ts.FunctionExpression,
  pa: ts.PropertyAssignment & Readonly<{ readonly name: ts.Identifier | ts.StringLiteral }>,
  registerExport: (
    name: string,
    fn: ts.FunctionLikeDeclaration,
    reportNode: ts.Node,
    symNode: ts.Node,
  ) => RawProductionFn,
) => registerExport(formatDefaultPropName(pa.name.text), init, pa, pa.name);

const buildDefaultMethodOption = (
  method: ts.MethodDeclaration &
    Readonly<{ readonly name: ts.Identifier | ts.StringLiteral; readonly body: ts.Block }>,
  registerExport: (
    name: string,
    fn: ts.FunctionLikeDeclaration,
    reportNode: ts.Node,
    symNode: ts.Node,
  ) => RawProductionFn,
) =>
  flow(
    formatDefaultPropName,
    (name) => registerExport(name, method, method, method.name),
    O.some,
  )(method.name.text);

const extractDefaultObjPropRecord = (
  prop: ts.ObjectLiteralElementLike,
  registerExport: (
    name: string,
    fn: ts.FunctionLikeDeclaration,
    reportNode: ts.Node,
    symNode: ts.Node,
  ) => RawProductionFn,
) =>
  match(prop)
    .when(isNamedPropertyAssignment, (pa) =>
      flow(
        unwrapExpression,
        O.fromPredicate(isFunctionValueExpr),
        O.map((init) => buildDefaultPropInitRecord(init, pa, registerExport)),
      )(pa.initializer),
    )
    .when(isNamedMethodWithBody, (method) => buildDefaultMethodOption(method, registerExport))
    .with(P._, () => O.none)
    .exhaustive();

const extractDefaultExportExprRecords = (
  node: ts.ExportAssignment,
  registerExport: (
    name: string,
    fn: ts.FunctionLikeDeclaration,
    reportNode: ts.Node,
    symNode: ts.Node,
  ) => RawProductionFn,
) =>
  match(unwrapExpression(node.expression))
    .when(isFunctionValueExpr, (fnExpr) => [registerExport("default", fnExpr, node, node)])
    .when(ts.isObjectLiteralExpression, (obj) =>
      RA.filterMap((prop: ts.ObjectLiteralElementLike) =>
        extractDefaultObjPropRecord(prop, registerExport),
      )(obj.properties),
    )
    .otherwise(() => EMPTY_RAW_FNS);

const extractExportAssignmentRecords = (node: ts.ExportAssignment, ctx: FileExportScope) =>
  node.isExportEquals
    ? EMPTY_RAW_FNS
    : extractDefaultExportExprRecords(node, (name, fn, reportNode, symNode) =>
        makeRawProductionFn(
          name,
          fn,
          reportNode,
          resolveNodeSymbol(symNode, ctx.checker),
          "exported",
          ctx,
        ),
      );

const extractStatementProductionFns = (node: ts.Statement, ctx: FileExportScope) =>
  match(node)
    .when(ts.isFunctionDeclaration, (decl) => extractFnDeclRecord(decl, ctx))
    .when(ts.isVariableStatement, (vs) =>
      RA.filterMap((decl: ts.VariableDeclaration) => extractVarDeclRecord(decl, ctx))(
        vs.declarationList.declarations,
      ),
    )
    .when(ts.isClassDeclaration, (cls) => extractClassDeclRecords(cls, ctx))
    .when(ts.isExportAssignment, (exp) => extractExportAssignmentRecords(exp, ctx))
    .otherwise(() => EMPTY_RAW_FNS);

const dedupeRawFnsById = RA.reduce<RawProductionFn, ReadonlyArray<RawProductionFn>>(
  EMPTY_RAW_FNS,
  (acc, fn) =>
    RA.some((existing: RawProductionFn) => existing.id === fn.id)(acc) ? acc : [...acc, fn],
);

const collectExportedCanonicalSyms = (
  runtimeExports: ReturnType<typeof extractFileRuntimeExports>,
  checker: ts.TypeChecker,
) =>
  new Set(
    flow(
      RA.filterMap((e: (typeof runtimeExports)[number]) => e.symbol),
      RA.map((s) => resolveCanonicalSymbol(s, checker)),
    )(runtimeExports),
  );

const buildFileExportScope = (sf: ts.SourceFile, checker: ts.TypeChecker) => {
  const runtimeExports = extractFileRuntimeExports(sf, checker);
  return {
    sf,
    fileName: normalizeFilePath(sf.fileName),
    checker,
    exportedDecls: new Set(
      RA.map((e: (typeof runtimeExports)[number]) => e.declaration)(runtimeExports),
    ),
    exportedSyms: collectExportedCanonicalSyms(runtimeExports, checker),
  } satisfies FileExportScope;
};

const collectFileProductionFns = (sf: ts.SourceFile, checker: ts.TypeChecker) =>
  isBarrelFile(sf)
    ? EMPTY_RAW_FNS
    : flow(
        (file: ts.SourceFile) => buildFileExportScope(file, checker),
        (ctx) =>
          RA.flatMap((node: ts.Statement) => extractStatementProductionFns(node, ctx))(
            sf.statements,
          ),
        dedupeRawFnsById,
      )(sf);

const resolveCallReceiverOrigins = (call: ts.CallExpression, ctx: OriginEnv) =>
  ts.isPropertyAccessExpression(call.expression)
    ? collectExprComponentOrigins(call.expression.expression, ctx)
    : EMPTY_STRINGS;

const resolveCallArgOrigins = (call: ts.CallExpression, ctx: OriginEnv) =>
  RA.flatMap((arg: ts.Expression) => collectExprComponentOrigins(arg, ctx))(call.arguments);

const resolveCallComponentOrigins = (call: ts.CallExpression, ctx: OriginEnv) =>
  flow(
    (expr: ts.Expression) =>
      resolveExpressionToComponentId(expr, ctx.lookup.checker, ctx.lookup.idBySymbol),
    O.match(
      () =>
        isPipeCallExpression(call)
          ? RA.uniq(S.Eq)(resolveCallArgOrigins(call, ctx))
          : RA.uniq(S.Eq)([
              ...resolveCallReceiverOrigins(call, ctx),
              ...resolveCallArgOrigins(call, ctx),
            ]),
      (id) => [id],
    ),
  )(call.expression);

const resolveSymbolOrigins = (targetSym: ts.Symbol, ctx: OriginEnv) =>
  flow(
    (s: ts.Symbol) => lookupMapOption(s, ctx.localVarOrigins),
    O.alt(() =>
      O.map((id: string) => [id] as ReadonlyArray<string>)(
        lookupComponentIdBySymbol(targetSym, ctx.lookup.checker, ctx.lookup.idBySymbol),
      ),
    ),
  )(targetSym);

const resolveIdentComponentOrigins = (ident: ts.Identifier, ctx: OriginEnv) =>
  flow(
    (node: ts.Identifier) => resolveNodeSymbol(node, ctx.lookup.checker),
    O.flatMap((sym) => resolveSymbolOrigins(sym, ctx)),
    O.getOrElse(() => EMPTY_STRINGS),
  )(ident);

const resolvePropAccessComponentOrigins = (prop: ts.PropertyAccessExpression, ctx: OriginEnv) =>
  flow(
    (expr: ts.Expression) =>
      resolveExpressionToComponentId(expr, ctx.lookup.checker, ctx.lookup.idBySymbol),
    O.match(
      () => collectExprComponentOrigins(prop.expression, ctx),
      (id) => [id],
    ),
  )(prop);

const collectBranchOrigins = (
  firstExpr: ts.Expression,
  secondExpr: ts.Expression,
  ctx: OriginEnv,
) =>
  RA.uniq(S.Eq)([
    ...collectExprComponentOrigins(firstExpr, ctx),
    ...collectExprComponentOrigins(secondExpr, ctx),
  ]);

const collectExprComponentOrigins = (
  expr: ts.Expression,
  ctx: OriginEnv,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for mutually recursive expression origin walk
): ReadonlyArray<string> =>
  match(unwrapExpression(expr))
    .when(ts.isCallExpression, (call) => resolveCallComponentOrigins(call, ctx))
    .when(ts.isAwaitExpression, (aw) => collectExprComponentOrigins(aw.expression, ctx))
    .when(ts.isIdentifier, (ident) => resolveIdentComponentOrigins(ident, ctx))
    .when(ts.isPropertyAccessExpression, (prop) => resolvePropAccessComponentOrigins(prop, ctx))
    .when(ts.isBinaryExpression, (bin) => collectBranchOrigins(bin.left, bin.right, ctx))
    .when(ts.isConditionalExpression, (cond) =>
      collectBranchOrigins(cond.whenTrue, cond.whenFalse, ctx),
    )
    .otherwise(() => EMPTY_STRINGS);

const collectCallCalleeIds = (
  call: ts.CallExpression,
  selfId: string,
  resolveExpr: (expr: ts.Expression) => O.Option<string>,
) =>
  flow(
    RA.filterMap(resolveExpr),
    RA.filter((id) => id !== selfId),
  )([call.expression, ...call.arguments]);

const collectCallNodeProvenance = (
  call: ts.CallExpression,
  spec: FnBodySpec,
  resolveExpr: (expr: ts.Expression) => O.Option<string>,
) => {
  const callees = collectCallCalleeIds(call, spec.selfId, resolveExpr);
  return {
    callees,
    errorCallees: isInsideSwallowingTryCatch(call, spec.body, spec.sf) ? EMPTY_STRINGS : callees,
  };
};

const extractBindingElementSymbol = (el: ts.BindingElement, checker: ts.TypeChecker) =>
  ts.isIdentifier(el.name) ? resolveNodeSymbol(el.name, checker) : O.none;

const extractIdentSymbols = (id: ts.Identifier, checker: ts.TypeChecker) =>
  flow((node: ts.Identifier) => resolveNodeSymbol(node, checker), RA.fromOption)(id);

const extractBindingNameSymbols = (name: ts.BindingName, checker: ts.TypeChecker) =>
  match(name)
    .when(ts.isIdentifier, (id) => extractIdentSymbols(id, checker))
    .when(ts.isObjectBindingPattern, (pat) =>
      RA.filterMap((el: ts.BindingElement) => extractBindingElementSymbol(el, checker))(pat.elements),
    )
    .with(P._, () => EMPTY_SYMBOLS)
    .exhaustive();

const mergeOriginEntries = (
  acc: ReadonlyMap<ts.Symbol, ReadonlyArray<string>>,
  symbols: ReadonlyArray<ts.Symbol>,
  origins: ReadonlyArray<string>,
) =>
  origins.length > 0
    ? extendLookupMap(
        acc,
        RA.map((sym: ts.Symbol) => [sym, origins] as const)(symbols),
      )
    : acc;

const applyOriginBinding = (
  acc: ReadonlyMap<ts.Symbol, ReadonlyArray<string>>,
  name: ts.BindingName,
  origins: ReadonlyArray<string>,
  checker: ts.TypeChecker,
) => mergeOriginEntries(acc, extractBindingNameSymbols(name, checker), origins);

const extendVarOriginMap = (
  acc: ReadonlyMap<ts.Symbol, ReadonlyArray<string>>,
  node: ts.VariableDeclaration,
  selfId: string,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
) =>
  node.initializer
    ? flow(
        (init: ts.Expression) =>
          collectExprComponentOrigins(init, {
            lookup: { checker, idBySymbol },
            localVarOrigins: acc,
          }),
        RA.filter((id) => id !== selfId),
        (origins) => applyOriginBinding(acc, node.name, origins, checker),
      )(node.initializer)
    : acc;

const collectLocalVarOrigins = (
  bodyNodes: ReadonlyArray<ts.Node>,
  selfId: string,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
) =>
  flow(
    RA.filter(ts.isVariableDeclaration),
    RA.reduce<ts.VariableDeclaration, ReadonlyMap<ts.Symbol, ReadonlyArray<string>>>(
      new Map(),
      (acc, decl) => extendVarOriginMap(acc, decl, selfId, checker, idBySymbol),
    ),
  )(bodyNodes);

const collectReturnExpressions = (body: ts.ConciseBody, bodyNodes: ReadonlyArray<ts.Node>) =>
  ts.isBlock(body)
    ? flow(
        RA.filter(ts.isReturnStatement),
        RA.filterMap((stmt) => O.fromNullable(stmt.expression)),
      )(bodyNodes)
    : [body];

const extractShorthandFieldOrigin = (
  sp: ts.ShorthandPropertyAssignment,
  lookupShorthand: (node: ts.ShorthandPropertyAssignment) => O.Option<ReadonlyArray<string>>,
) =>
  flow(
    lookupShorthand,
    O.filter((origins) => origins.length > 0),
    O.map((origins) => [sp.name.text, origins] as const),
    RA.fromOption,
  )(sp);

const extractPropertyAssignmentFieldOrigin = (
  pa: ts.PropertyAssignment & Readonly<{ readonly name: ts.Identifier | ts.StringLiteral }>,
  selfId: string,
  resolveOrigins: (expr: ts.Expression) => ReadonlyArray<string>,
) =>
  flow(
    resolveOrigins,
    RA.filter((id) => id !== selfId),
    O.fromPredicate((origins) => origins.length > 0),
    O.map((origins) => [pa.name.text, origins] as const),
    RA.fromOption,
  )(pa.initializer);

const extractObjectPropFieldProvenance = (
  prop: ts.ObjectLiteralElementLike,
  selfId: string,
  lookupShorthand: (node: ts.ShorthandPropertyAssignment) => O.Option<ReadonlyArray<string>>,
  resolveOrigins: (expr: ts.Expression) => ReadonlyArray<string>,
) =>
  match(prop)
    .when(ts.isShorthandPropertyAssignment, (sp) =>
      extractShorthandFieldOrigin(sp, lookupShorthand),
    )
    .when(isNamedPropertyAssignment, (pa) =>
      extractPropertyAssignmentFieldOrigin(pa, selfId, resolveOrigins),
    )
    .with(P._, () => EMPTY_FIELD_ORIGINS)
    .exhaustive();

const mergeFieldOriginEntries = RA.reduce<
  readonly [string, ReadonlyArray<string>],
  Readonly<Record<string, ReadonlyArray<string>>>
>({}, (acc, [field, origins]) => ({
  ...acc,
  [field]: dedupeSortedStrings([...lookupRecordList(field, acc), ...origins]),
}));

const collectReturnFieldProvenance = (
  unwrappedReturns: ReadonlyArray<ts.Expression>,
  selfId: string,
  lookupShorthand: (node: ts.ShorthandPropertyAssignment) => O.Option<ReadonlyArray<string>>,
  resolveOrigins: (expr: ts.Expression) => ReadonlyArray<string>,
) =>
  flow(
    RA.filter(ts.isObjectLiteralExpression),
    RA.flatMap((obj) => obj.properties),
    RA.flatMap((prop) =>
      extractObjectPropFieldProvenance(prop, selfId, lookupShorthand, resolveOrigins),
    ),
    mergeFieldOriginEntries,
  )(unwrappedReturns);

const collectDirectReturnProvenance = (
  unwrappedReturns: ReadonlyArray<ts.Expression>,
  selfId: string,
  resolveOrigins: (expr: ts.Expression) => ReadonlyArray<string>,
) =>
  flow(
    RA.filter((expr: ts.Expression) => !ts.isObjectLiteralExpression(expr)),
    RA.flatMap(resolveOrigins),
    RA.filter((id) => id !== selfId),
    dedupeSortedStrings,
  )(unwrappedReturns);

const lookupShorthandOriginsInEnv = (node: ts.ShorthandPropertyAssignment, ctx: OriginEnv) =>
  flow(
    (sp: ts.ShorthandPropertyAssignment) => resolveShorthandSymbol(sp, ctx.lookup.checker),
    O.flatMap((sym) => lookupMapOption(sym, ctx.localVarOrigins)),
  )(node);

const extractReturnProvenance = (
  returnExprs: ReadonlyArray<ts.Expression>,
  selfId: string,
  ctx: OriginEnv,
) => {
  const unwrappedReturns = RA.map(unwrapExpression)(returnExprs);
  const resolveOrigins = (expr: ts.Expression) => collectExprComponentOrigins(expr, ctx);
  return {
    returnFieldProvenance: collectReturnFieldProvenance(
      unwrappedReturns,
      selfId,
      (sp) => lookupShorthandOriginsInEnv(sp, ctx),
      resolveOrigins,
    ),
    directReturnProvenance: collectDirectReturnProvenance(unwrappedReturns, selfId, resolveOrigins),
  };
};

const collectBodyCallSummary = (
  bodyNodes: ReadonlyArray<ts.Node>,
  spec: FnBodySpec,
  resolveExpr: (expr: ts.Expression) => O.Option<string>,
) => {
  const records = flow(
    RA.filter(ts.isCallExpression),
    RA.map((call) => collectCallNodeProvenance(call, spec, resolveExpr)),
  )(bodyNodes);
  return {
    directCallees: dedupeSortedStrings(
      RA.flatMap((r: (typeof records)[number]) => r.callees)(records),
    ),
    errorProvenance: dedupeSortedStrings(
      RA.flatMap((r: (typeof records)[number]) => r.errorCallees)(records),
    ),
  };
};

const analyzeConcreteFnBody = (
  spec: FnBodySpec,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
) => {
  const bodyNodes = collectOwnBodyNodes(spec.body, spec.sf);
  return {
    ...collectBodyCallSummary(bodyNodes, spec, (expr) =>
      resolveExpressionToComponentId(expr, checker, idBySymbol),
    ),
    ...extractReturnProvenance(collectReturnExpressions(spec.body, bodyNodes), spec.selfId, {
      lookup: { checker, idBySymbol },
      localVarOrigins: collectLocalVarOrigins(bodyNodes, spec.selfId, checker, idBySymbol),
    }),
  } satisfies BodyProvenance;
};

const analyzeProductionFnBody = (
  fn: RawProductionFn,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
) =>
  fn.fnNode.body
    ? analyzeConcreteFnBody(
        { selfId: fn.id, body: fn.fnNode.body, sf: fn.fnNode.getSourceFile() },
        checker,
        idBySymbol,
      )
    : EMPTY_BODY_PROVENANCE;

const collectUnvisitedDirectCallees = (
  curr: string,
  visited: ReadonlySet<string>,
  directById: Readonly<Record<string, ReadonlyArray<string>>>,
) => RA.filter((next: string) => !visited.has(next))(lookupRecordList(curr, directById));

const stepTransitiveNode = (
  curr: string,
  state: FrontierState,
  input: TransitiveWalkInput,
) => {
  const tail = RA.dropLeft(1)(state.frontier);
  return curr === input.startId || state.visited.has(curr)
    ? walkTransitiveFrontier({ frontier: tail, visited: state.visited }, input)
    : walkTransitiveFrontier(
        {
          frontier: [...tail, ...collectUnvisitedDirectCallees(curr, state.visited, input.directById)],
          visited: toReadonlySet([...state.visited, curr]),
        },
        input,
      );
};

const walkTransitiveFrontier = (
  state: FrontierState,
  input: TransitiveWalkInput,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for mutually recursive graph walk
): ReadonlySet<string> =>
  flow(
    RA.head<string>,
    O.match(
      () => state.visited,
      (curr) => stepTransitiveNode(curr, state, input),
    ),
  )(state.frontier);

const computeTransitiveCallees = (
  startId: string,
  directById: Readonly<Record<string, ReadonlyArray<string>>>,
) =>
  flow(
    (initial: ReadonlyArray<string>) =>
      walkTransitiveFrontier({ frontier: initial, visited: new Set() }, { startId, directById }),
    sortStringSet,
  )(lookupRecordList(startId, directById));

const buildSymbolIdEntries = (fn: RawProductionFn, checker: ts.TypeChecker) =>
  O.match(
    () => EMPTY_SYMBOL_ID_ENTRIES,
    (sym: ts.Symbol) =>
      [
        [resolveCanonicalSymbol(sym, checker), fn.id] as const,
        [sym, fn.id] as const,
      ] as ReadonlyArray<readonly [ts.Symbol, string]>,
  )(fn.symbol);

const toProductionComponent = (
  entry: AnalyzedProductionFn,
  directById: Readonly<Record<string, ReadonlyArray<string>>>,
) =>
  ({
    id: entry.raw.id,
    name: entry.raw.name,
    fileName: entry.raw.fileName,
    line: entry.raw.line,
    visibility: entry.raw.visibility,
    symbol: entry.raw.symbol,
    fnNode: entry.raw.fnNode,
    directCallees: entry.directCallees,
    transitiveCallees: computeTransitiveCallees(entry.raw.id, directById),
    returnFieldProvenance: entry.returnFieldProvenance,
    directReturnProvenance: entry.directReturnProvenance,
    errorProvenance: entry.errorProvenance,
  }) satisfies ProductionComponent;

const collectProductionRawFns = (
  program: ts.Program,
  checker: ts.TypeChecker,
  testPatterns: ReadonlyArray<string>,
) =>
  flow(
    collectProjectSourceFiles,
    RA.filter((sf) => !isSourceFileMatchingPatterns(sf, testPatterns)),
    RA.flatMap((sf) => collectFileProductionFns(sf, checker)),
  )(program);

const indexDirectCalleesById = flow(
  RA.map((entry: AnalyzedProductionFn) => [entry.raw.id, entry.directCallees] as const),
  toReadonlyRecord,
);

const assembleComponentsById = (
  analyzedEntries: ReadonlyArray<AnalyzedProductionFn>,
  directById: Readonly<Record<string, ReadonlyArray<string>>>,
) =>
  flow(
    RA.map(
      (entry: AnalyzedProductionFn) =>
        [entry.raw.id, toProductionComponent(entry, directById)] as const,
    ),
    toReadonlyRecord,
  )(analyzedEntries);

const analyzeRawProductionFns = (
  rawFns: ReadonlyArray<RawProductionFn>,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
) =>
  RA.map(
    (fn: RawProductionFn) =>
      ({
        raw: fn,
        ...analyzeProductionFnBody(fn, checker, idBySymbol),
      }) satisfies AnalyzedProductionFn,
  )(rawFns);

const buildProductionGraph = (program: ts.Program, testPatterns: ReadonlyArray<string>) => {
  const checker = program.getTypeChecker();
  const rawFns = collectProductionRawFns(program, checker, testPatterns);
  const idBySymbol = toLookupMap(
    RA.flatMap((fn: RawProductionFn) => buildSymbolIdEntries(fn, checker))(rawFns),
  );
  const analyzedEntries = analyzeRawProductionFns(rawFns, checker, idBySymbol);
  return {
    componentsById: assembleComponentsById(analyzedEntries, indexDirectCalleesById(analyzedEntries)),
    idBySymbol,
    idsByFile: RR.map(RA.map((fn: RawProductionFn) => fn.id))(
      groupItemsByKey(rawFns, (fn) => fn.fileName),
    ),
  } satisfies ProductionGraph;
};

// ---------------------------------------------------------------------------
// Stage 1B: Fingerprinting, Mocking & Test Case Extraction
// ---------------------------------------------------------------------------

const formatArrayFingerprint = flow(joinComma, formatBracketList);
const formatObjectFingerprint = flow(RA.sort(S.Ord), joinComma, formatBraceList);
const formatTupleFingerprint = flow(joinComma, formatParenList);

const isSignedNumericPrefix = (
  expr: ts.Expression,
): expr is ts.PrefixUnaryExpression & Readonly<{ readonly operand: ts.NumericLiteral }> =>
  ts.isPrefixUnaryExpression(expr) &&
  (expr.operator === ts.SyntaxKind.MinusToken || expr.operator === ts.SyntaxKind.PlusToken) &&
  ts.isNumericLiteral(expr.operand);

const isUndefinedIdentifier = (expr: ts.Expression): expr is ts.Identifier =>
  ts.isIdentifier(expr) && UNDEFINED_IDENT_NAMES.has(expr.text);

const fingerprintObjectProp = (prop: ts.ObjectLiteralElementLike) =>
  isNamedPropertyAssignment(prop)
    ? O.map((fp: string) => `${prop.name.text}:${fp}`)(fingerprintLiteralExpr(prop.initializer))
    : O.none;

const fingerprintStringNode = flow(
  (s: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral) => s.text,
  formatJsonString,
  formatStrFingerprint,
  O.some,
);

const fingerprintPrimitiveLiteral = (u: ts.Expression) =>
  match(u)
    .when(isStringLikeLiteral, fingerprintStringNode)
    .when(ts.isNumericLiteral, (n) => O.some(`num:${n.text}`))
    .with({ kind: ts.SyntaxKind.TrueKeyword }, () => O.some("bool:true"))
    .with({ kind: ts.SyntaxKind.FalseKeyword }, () => O.some("bool:false"))
    .with({ kind: ts.SyntaxKind.NullKeyword }, () => O.some("null"))
    .when(isUndefinedIdentifier, () => O.some("undef"))
    .when(ts.isRegularExpressionLiteral, (re) => O.some(`re:${re.text}`))
    .when(isSignedNumericPrefix, (p) =>
      O.some(`num:${p.operator === ts.SyntaxKind.MinusToken ? "-" : ""}${p.operand.text}`),
    )
    .otherwise(() => O.none);

const fingerprintArrayNode = (arr: ts.ArrayLiteralExpression) =>
  flow(
    RA.traverse(O.Applicative)(fingerprintLiteralExpr),
    O.map(formatArrayFingerprint),
  )(arr.elements);

const fingerprintObjectNode = (obj: ts.ObjectLiteralExpression) =>
  flow(
    RA.traverse(O.Applicative)(fingerprintObjectProp),
    O.map(formatObjectFingerprint),
  )(obj.properties);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive literal fingerprinting
const fingerprintLiteralExpr = (expr: ts.Expression): O.Option<string> =>
  match(unwrapExpression(expr))
    .when(ts.isArrayLiteralExpression, fingerprintArrayNode)
    .when(ts.isObjectLiteralExpression, fingerprintObjectNode)
    .otherwise(fingerprintPrimitiveLiteral);

const EMPTY_ARGS_FINGERPRINT: FingerprintValue = { tag: "literal", value: "()" };

const fingerprintArguments = (args: ReadonlyArray<ts.Expression>) =>
  args.length === 0
    ? EMPTY_ARGS_FINGERPRINT
    : flow(
        RA.traverse(O.Applicative)(fingerprintLiteralExpr),
        O.map(formatTupleFingerprint),
        toFingerprintValue,
      )(args);

const extractObjectPropKey = (prop: ts.ObjectLiteralElementLike) =>
  match(prop)
    .when(ts.isShorthandPropertyAssignment, (sp) => O.some(sp.name.text))
    .when(isNamedPropertyAssignment, (pa) => O.some(pa.name.text))
    .with(P._, () => O.none)
    .exhaustive();

const extractExpectedObjectKeys = (expectedArg: ExpectedArgPresence) =>
  match(expectedArg)
    .with({ tag: "absent" }, () => EMPTY_STRINGS)
    .with({ tag: "present" }, ({ expression }) =>
      flow(
        unwrapExpression,
        O.fromPredicate(ts.isObjectLiteralExpression),
        O.map((obj) => RA.filterMap(extractObjectPropKey)(obj.properties)),
        O.getOrElse(() => EMPTY_STRINGS),
      )(expression),
    )
    .exhaustive();

const classifyMatcher = (matcher: string) =>
  match(matcher)
    .when((m) => SPY_MATCHERS.has(m), () => "spy-interaction" as const)
    .when((m) => ERROR_MATCHERS.has(m), () => "error" as const)
    .when((m) => EQUALITY_MATCHERS.has(m), () => "equality" as const)
    .when((m) => PREDICATE_MATCHERS.has(m), () => "predicate" as const)
    .when((m) => CONTAINMENT_MATCHERS.has(m), () => "containment" as const)
    .when((m) => SHAPE_MATCHERS.has(m), () => "shape" as const)
    .otherwise(() => "other" as const);

const isMatchingMockedFile = (prodFile: string, sfDir: string, normalizedSpec: string) => {
  const prodNoExt = stripTsExt(prodFile);
  return (
    hasExactFilePath(prodNoExt, sfDir, normalizedSpec) || hasSlashSuffix(prodNoExt, normalizedSpec)
  );
};

type ModuleMockLookup = Readonly<
  Record<"sfDir", string> & {
    readonly idsByFile: Readonly<Record<string, ReadonlyArray<string>>>;
  }
>;

const filterMockedFilesBySpec = (normalizedSpec: string, mockLookup: ModuleMockLookup) =>
  flow(
    RR.toEntries<string, ReadonlyArray<string>>,
    RA.filter(([prodFile]) => isMatchingMockedFile(prodFile, mockLookup.sfDir, normalizedSpec)),
    RA.flatMap(([, cids]) => cids),
  )(mockLookup.idsByFile);

const resolveModuleMockTargetIds = (
  modArg: ts.StringLiteral,
  mockLookup: ModuleMockLookup,
  checker: ts.TypeChecker,
) =>
  flow(
    (arg: ts.StringLiteral) => resolveNodeSymbol(arg, checker),
    O.flatMap((sym) => O.fromNullable(sym.valueDeclaration)),
    O.map(resolveDeclFilePath),
    O.match(
      () => filterMockedFilesBySpec(normalizeMockSpecifier(modArg.text), mockLookup),
      (declFile) => lookupRecordList(declFile, mockLookup.idsByFile),
    ),
  )(modArg);

const isRunnerMethodAccess = (expr: ts.Expression, methodNames: ReadonlySet<string>) =>
  isIdentBasedPropertyAccess(expr) &&
  MOCK_RUNNER_NAMES.has(expr.expression.text) &&
  methodNames.has(expr.name.text);

const extractModuleMockIds = (
  call: ts.CallExpression,
  mockLookup: ModuleMockLookup,
  checker: ts.TypeChecker,
) =>
  isRunnerMethodAccess(call.expression, MOCK_METHOD_NAMES)
    ? flow(
        RA.head<ts.Expression>,
        O.map(unwrapExpression),
        O.filter(ts.isStringLiteral),
        O.match(
          () => EMPTY_STRINGS,
          (modArg) => resolveModuleMockTargetIds(modArg, mockLookup, checker),
        ),
      )(call.arguments)
    : EMPTY_STRINGS;

const isSpyOnReceiverCall = (receiver: ts.Expression): receiver is ts.CallExpression =>
  ts.isCallExpression(receiver) && isRunnerMethodAccess(receiver.expression, SPY_ON_METHOD_NAMES);

const extractSpyOnFromProp = (callee: ts.PropertyAccessExpression) =>
  MOCK_IMPL_METHODS.has(callee.name.text) && isSpyOnReceiverCall(callee.expression)
    ? O.some(callee.expression)
    : O.none;

const extractSpyOnTargetCall = (call: ts.CallExpression) =>
  ts.isPropertyAccessExpression(call.expression) ? extractSpyOnFromProp(call.expression) : O.none;

const extractStringLiteralAt = (index: number, args: ReadonlyArray<ts.Expression>) =>
  flow(
    (items: ReadonlyArray<ts.Expression>) => RA.lookup(index)(items),
    O.map(unwrapExpression),
    O.filter(ts.isStringLiteral),
  )(args);

const lookupPropertySymbolOnExpr = (
  targetObj: ts.Expression,
  propName: string,
  checker: ts.TypeChecker,
) => O.fromNullable(checker.getTypeAtLocation(targetObj).getProperty(propName));

const resolveSpyMockComponentId = (
  spyCall: ts.CallExpression,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
) =>
  flow(
    () => O.Do,
    O.apS("targetObj", RA.head(spyCall.arguments)),
    O.apS("propArg", extractStringLiteralAt(1, spyCall.arguments)),
    O.flatMap(({ targetObj, propArg }) =>
      resolveSymbolOptionToComponentId(
        lookupPropertySymbolOnExpr(targetObj, propArg.text, checker),
        checker,
        idBySymbol,
      ),
    ),
  )();

const extractSpyMockIds = (
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
) =>
  flow(
    extractSpyOnTargetCall,
    O.flatMap((spyCall) => resolveSpyMockComponentId(spyCall, checker, idBySymbol)),
    RA.fromOption,
  )(call);

const collectMockIdsForDir = (
  nodes: ReadonlyArray<ts.Node>,
  sfDir: string,
  checker: ts.TypeChecker,
  graph: ProductionGraph,
) =>
  flow(
    RA.filter(ts.isCallExpression),
    RA.flatMap((call) => [
      ...extractModuleMockIds(call, { sfDir, idsByFile: graph.idsByFile }, checker),
      ...extractSpyMockIds(call, checker, graph.idBySymbol),
    ]),
    toReadonlySet,
  )(nodes);

const resolveMockedComponentsInNodes = (
  nodes: ReadonlyArray<ts.Node>,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  graph: ProductionGraph,
) => collectMockIdsForDir(nodes, resolveSourceDir(sf), checker, graph);

const buildLocalWrapperFromInit = (
  init: ts.ArrowFunction | ts.FunctionExpression,
  nameIdent: ts.Identifier,
  checker: ts.TypeChecker,
) =>
  flow(
    (ident: ts.Identifier) => resolveNodeSymbol(ident, checker),
    O.map((symbol) => ({ symbol, body: init.body }) satisfies LocalWrapperEntry),
  )(nameIdent);

const extractLocalWrapperVarEntry = (decl: ts.VariableDeclaration, checker: ts.TypeChecker) =>
  isInitializedIdentVar(decl)
    ? flow(
        unwrapExpression,
        O.fromPredicate(isFunctionValueExpr),
        O.flatMap((init) => buildLocalWrapperFromInit(init, decl.name, checker)),
      )(decl.initializer)
    : O.none;

const isNamedFnDeclWithBody = (
  node: ts.Statement,
): node is ts.FunctionDeclaration &
  Readonly<{ readonly name: ts.Identifier; readonly body: ts.Block }> =>
  ts.isFunctionDeclaration(node) && hasName(node) && hasBody(node);

const extractStatementLocalWrappers = (node: ts.Statement, checker: ts.TypeChecker) =>
  match(node)
    .when(isNamedFnDeclWithBody, (fn) =>
      flow(
        (nameNode: ts.Identifier) => resolveNodeSymbol(nameNode, checker),
        O.map((symbol) => ({ symbol, body: fn.body }) satisfies LocalWrapperEntry),
        RA.fromOption,
      )(fn.name),
    )
    .when(ts.isVariableStatement, (vs) =>
      RA.filterMap((decl: ts.VariableDeclaration) => extractLocalWrapperVarEntry(decl, checker))(
        vs.declarationList.declarations,
      ),
    )
    .otherwise(() => EMPTY_LOCAL_WRAPPERS);

const collectWrapperDirectCalls = (
  body: ts.ConciseBody,
  sf: ts.SourceFile,
  resolveExpr: (expr: ts.Expression) => O.Option<string>,
) =>
  flow(
    RA.filter(ts.isCallExpression),
    RA.filterMap((call) => resolveExpr(call.expression)),
    RA.uniq(S.Eq),
  )(collectTsNodes(body, sf));

const collectSecondHopWrapperCalls = (
  body: ts.ConciseBody,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  directByWrapper: ReadonlyMap<ts.Symbol, ReadonlyArray<string>>,
) =>
  flow(
    RA.filter(ts.isCallExpression),
    RA.map((call) => call.expression),
    RA.filter(ts.isIdentifier),
    RA.filterMap((ident) => resolveNodeSymbol(ident, checker)),
    RA.flatMap((sym) => lookupMapList(sym, directByWrapper)),
  )(collectTsNodes(body, sf));

const expandWrapperCallTargets = (
  entry: LocalWrapperEntry,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  directByWrapper: ReadonlyMap<ts.Symbol, ReadonlyArray<string>>,
) =>
  [
    entry.symbol,
    RA.uniq(S.Eq)([
      ...lookupMapList(entry.symbol, directByWrapper),
      ...collectSecondHopWrapperCalls(entry.body, sf, checker, directByWrapper),
    ]),
  ] as const;

const indexDirectWrapperCalls = (
  wrapperEntries: ReadonlyArray<LocalWrapperEntry>,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
) =>
  toLookupMap(
    RA.map(
      (entry: LocalWrapperEntry) =>
        [
          entry.symbol,
          collectWrapperDirectCalls(entry.body, sf, (expr) =>
            resolveExpressionToComponentId(expr, checker, idBySymbol),
          ),
        ] as const,
    )(wrapperEntries),
  );

const expandAllWrapperCalls = (
  wrapperEntries: ReadonlyArray<LocalWrapperEntry>,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  directByWrapper: ReadonlyMap<ts.Symbol, ReadonlyArray<string>>,
) =>
  toLookupMap(
    RA.map((entry: LocalWrapperEntry) =>
      expandWrapperCallTargets(entry, sf, checker, directByWrapper),
    )(wrapperEntries),
  );

const buildLocalWrapperMap = (
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
) => {
  const wrapperEntries = RA.flatMap((node: ts.Statement) =>
    extractStatementLocalWrappers(node, checker),
  )(sf.statements);
  return expandAllWrapperCalls(
    wrapperEntries,
    sf,
    checker,
    indexDirectWrapperCalls(wrapperEntries, sf, checker, idBySymbol),
  );
};

const appendProjectedSegment = (binding: LocalTestBinding, segment: string) =>
  ({
    ...binding,
    projectedPath: [...binding.projectedPath, segment] as ReadonlyArray<string>,
  }) as LocalTestBinding;

const isFpErrorCheckProp = (expr: ts.Expression): expr is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(expr) && FP_ERROR_CHECK_METHODS.has(expr.name.text);

const isFpErrorWrapperCall = (
  call: ts.CallExpression,
): call is ts.CallExpression & Readonly<{ readonly expression: ts.PropertyAccessExpression }> =>
  isFpErrorCheckProp(call.expression) && call.arguments.length === 1;

const traceFpErrorArgs = (
  args: ReadonlyArray<ts.Expression>,
  methodName: string,
  traceExpr: (expr: ts.Expression) => O.Option<LocalTestBinding>,
) =>
  flow(
    RA.head<ts.Expression>,
    O.flatMap(traceExpr),
    O.map((inner) => appendProjectedSegment(inner, methodName)),
  )(args);

const traceFpErrorProp = (
  prop: ts.PropertyAccessExpression,
  args: ReadonlyArray<ts.Expression>,
  traceExpr: (expr: ts.Expression) => O.Option<LocalTestBinding>,
) => traceFpErrorArgs(args, prop.name.text, traceExpr);

const traceFpErrorWrapperCall = (
  call: ts.CallExpression,
  traceExpr: (expr: ts.Expression) => O.Option<LocalTestBinding>,
) => (isFpErrorWrapperCall(call) ? traceFpErrorProp(call.expression, call.arguments, traceExpr) : O.none);

const makeCallBinding = (componentId: string, args: ReadonlyArray<ts.Expression>) =>
  ({
    componentId,
    projectedPath: EMPTY_STRINGS,
    inputFingerprint: fingerprintArguments(args),
  }) as LocalTestBinding;

const traceLocalWrapperCall = (
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  localWrapperMap: ReadonlyMap<ts.Symbol, ReadonlyArray<string>>,
) =>
  ts.isIdentifier(call.expression)
    ? flow(
        (ident: ts.Identifier) => resolveNodeSymbol(ident, checker),
        O.flatMap((sym) => lookupMapOption(sym, localWrapperMap)),
        O.filter((targets) => targets.length === 1),
        O.flatMap(RA.head),
        O.map((componentId) => makeCallBinding(componentId, call.arguments)),
      )(call.expression)
    : O.none;

const traceCallExprBinding = (
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  idBySymbol: ReadonlyMap<ts.Symbol, string>,
  localWrapperMap: ReadonlyMap<ts.Symbol, ReadonlyArray<string>>,
  traceExpr: (expr: ts.Expression) => O.Option<LocalTestBinding>,
) =>
  flow(
    (expr: ts.Expression) => resolveExpressionToComponentId(expr, checker, idBySymbol),
    O.map((componentId) => makeCallBinding(componentId, call.arguments)),
    O.alt(() => traceFpErrorWrapperCall(call, traceExpr)),
    O.alt(() => traceLocalWrapperCall(call, checker, localWrapperMap)),
  )(call.expression);

const traceReturnStatementExpr = (
  ret: ts.ReturnStatement,
  traceExpr: (expr: ts.Expression) => O.Option<LocalTestBinding>,
) => flow((stmt: ts.ReturnStatement) => O.fromNullable(stmt.expression), O.flatMap(traceExpr))(ret);

const traceCallbackStatementBinding = (
  node: ts.Statement,
  traceExpr: (expr: ts.Expression) => O.Option<LocalTestBinding>,
) =>
  match(node)
    .when(ts.isReturnStatement, (ret) => traceReturnStatementExpr(ret, traceExpr))
    .when(ts.isExpressionStatement, (es) => traceExpr(es.expression))
    .otherwise(() => O.none);

const traceFunctionWrapperBinding = (
  fn: ts.ArrowFunction | ts.FunctionExpression,
  traceExpr: (expr: ts.Expression) => O.Option<LocalTestBinding>,
) =>
  ts.isBlock(fn.body)
    ? RA.findFirstMap((node: ts.Statement) => traceCallbackStatementBinding(node, traceExpr))(
        fn.body.statements,
      )
    : traceExpr(fn.body);

const isStringElementAccess = (
  node: ts.Expression,
): node is ts.ElementAccessExpression &
  Readonly<{ readonly argumentExpression: ts.StringLiteral }> =>
  ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression);

const traceIdentBinding = (ident: ts.Identifier, ctx: TestTraceEnv) =>
  flow(
    (node: ts.Identifier) => resolveNodeSymbol(node, ctx.checker),
    O.flatMap((sym) => lookupMapOption(sym, ctx.localBindings)),
  )(ident);

const tracePropertyAccessBinding = (prop: ts.PropertyAccessExpression, ctx: TestTraceEnv) =>
  flow(
    (expr: ts.Expression) => traceExprBinding(expr, ctx),
    O.map((base) => appendProjectedSegment(base, prop.name.text)),
  )(prop.expression);

const traceStringElementBinding = (
  el: ts.ElementAccessExpression & Readonly<{ readonly argumentExpression: ts.StringLiteral }>,
  ctx: TestTraceEnv,
) =>
  flow(
    (expr: ts.Expression) => traceExprBinding(expr, ctx),
    O.map((base) => appendProjectedSegment(base, el.argumentExpression.text)),
  )(el.expression);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive expression binding trace
const traceExprBinding = (expr: ts.Expression, ctx: TestTraceEnv): O.Option<LocalTestBinding> =>
  match(unwrapExpression(expr))
    .when(ts.isAwaitExpression, (aw) => traceExprBinding(aw.expression, ctx))
    .when(ts.isCallExpression, (call) =>
      traceCallExprBinding(call, ctx.checker, ctx.idBySymbol, ctx.localWrapperMap, (inner) =>
        traceExprBinding(inner, ctx),
      ),
    )
    .when(ts.isPropertyAccessExpression, (prop) => tracePropertyAccessBinding(prop, ctx))
    .when(isStringElementAccess, (el) => traceStringElementBinding(el, ctx))
    .when(ts.isIdentifier, (ident) => traceIdentBinding(ident, ctx))
    .when(isFunctionValueExpr, (fn) =>
      traceFunctionWrapperBinding(fn, (inner) => traceExprBinding(inner, ctx)),
    )
    .otherwise(() => O.none);

const contributionFromBinding = (binding: LocalTestBinding) =>
  ({
    components: [binding.componentId],
    subjectFields: RA.fromOption(RA.head(binding.projectedPath)),
  }) satisfies ExprReferenceContribution;

const lookupIdentWrapperTargets = (
  ident: ts.Identifier,
  checker: ts.TypeChecker,
  localWrapperMap: ReadonlyMap<ts.Symbol, ReadonlyArray<string>>,
) =>
  flow(
    (node: ts.Identifier) => resolveNodeSymbol(node, checker),
    O.flatMap((sym) => lookupMapOption(sym, localWrapperMap)),
    O.getOrElse(() => EMPTY_STRINGS),
  )(ident);

const resolveCallFallbackContribution = (expr: ts.Expression, ctx: TestTraceEnv) =>
  ts.isIdentifier(expr)
    ? ({
        components: lookupIdentWrapperTargets(expr, ctx.checker, ctx.localWrapperMap),
        subjectFields: EMPTY_STRINGS,
      } satisfies ExprReferenceContribution)
    : EMPTY_REF_CONTRIBUTION;

const extractCallRefContribution = (call: ts.CallExpression, ctx: TestTraceEnv) =>
  flow(
    (expr: ts.Expression) => resolveExpressionToComponentId(expr, ctx.checker, ctx.idBySymbol),
    O.match(
      () => resolveCallFallbackContribution(call.expression, ctx),
      (cid) => ({ components: [cid], subjectFields: EMPTY_STRINGS }) satisfies ExprReferenceContribution,
    ),
  )(call.expression);

const resolveBindingContribution = O.match(() => EMPTY_REF_CONTRIBUTION, contributionFromBinding);

const extractPropRefContribution = (
  prop: ts.PropertyAccessExpression,
  traceExpr: (expr: ts.Expression) => O.Option<LocalTestBinding>,
) => flow(traceExpr, resolveBindingContribution)(prop);

const extractIdentRefContribution = (
  ident: ts.Identifier,
  traceIdent: (node: ts.Identifier) => O.Option<LocalTestBinding>,
) => flow(traceIdent, resolveBindingContribution)(ident);

const extractNodeRefContribution = (
  node: ts.Node,
  resolveCall: (call: ts.CallExpression) => ExprReferenceContribution,
  traceProp: (prop: ts.PropertyAccessExpression) => ExprReferenceContribution,
  traceIdent: (ident: ts.Identifier) => ExprReferenceContribution,
) =>
  match(node)
    .when(ts.isCallExpression, resolveCall)
    .when(ts.isPropertyAccessExpression, traceProp)
    .when(ts.isIdentifier, traceIdent)
    .otherwise(() => EMPTY_REF_CONTRIBUTION);

const mergeRefContributions = (contributions: ReadonlyArray<ExprReferenceContribution>) =>
  ({
    components: dedupeSortedStrings(
      RA.flatMap((c: ExprReferenceContribution) => c.components)(contributions),
    ),
    subjectFields: dedupeSortedStrings(
      RA.flatMap((c: ExprReferenceContribution) => c.subjectFields)(contributions),
    ),
  }) satisfies ExprReferenceContribution;

const collectReferencedComponentsInExpr = (expr: ts.Node, sf: ts.SourceFile, ctx: TestTraceEnv) =>
  flow(
    RA.map((node: ts.Node) =>
      extractNodeRefContribution(
        node,
        (call) => extractCallRefContribution(call, ctx),
        (prop) => extractPropRefContribution(prop, (e) => traceExprBinding(e, ctx)),
        (ident) => extractIdentRefContribution(ident, (n) => traceIdentBinding(n, ctx)),
      ),
    ),
    mergeRefContributions,
  )(collectTsNodes(expr, sf));

const stepExpectPropertyAccess = (
  prop: ts.PropertyAccessExpression,
  rejectionMode: ExpectRejectionMode,
) =>
  EXPECT_CHAIN_MODIFIERS.has(prop.name.text)
    ? unwrapExpectChainBase(
        prop.expression,
        REJECTS_PROP_NAMES.has(prop.name.text) ? "rejects" : rejectionMode,
      )
    : O.none;

const unwrapExpectChainBase = (
  expr: ts.Expression,
  rejectionMode: ExpectRejectionMode,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for mutually recursive expect modifier unwrap
): O.Option<Readonly<{ readonly base: ts.Expression; readonly rejectionMode: ExpectRejectionMode }>> =>
  ts.isPropertyAccessExpression(expr)
    ? stepExpectPropertyAccess(expr, rejectionMode)
    : O.some({ base: expr, rejectionMode });

const isExpectCallWithArg = (expr: ts.Expression): expr is ts.CallExpression =>
  ts.isCallExpression(expr) &&
  ts.isIdentifier(expr.expression) &&
  EXPECT_FN_NAMES.has(expr.expression.text) &&
  expr.arguments.length >= 1;

const buildExpectChainResult = (
  base: ts.Expression,
  rejectionMode: ExpectRejectionMode,
  matcher: string,
  nodeArgs: ReadonlyArray<ts.Expression>,
) =>
  isExpectCallWithArg(base)
    ? O.map((expectArg: ts.Expression) => ({
        expectArg,
        matcher,
        expectedArg: toExpectedArgPresence(RA.head(nodeArgs)),
        rejectionMode,
      }))(RA.head(base.arguments))
    : O.none;

const parseExpectPropCall = (
  callee: ts.PropertyAccessExpression,
  args: ReadonlyArray<ts.Expression>,
) =>
  flow(
    (prop: ts.PropertyAccessExpression) => unwrapExpectChainBase(prop.expression, "standard"),
    O.flatMap(({ base, rejectionMode }) =>
      buildExpectChainResult(base, rejectionMode, callee.name.text, args),
    ),
  )(callee);

const tryParseExpectAssertion = (node: ts.CallExpression) =>
  ts.isPropertyAccessExpression(node.expression)
    ? parseExpectPropCall(node.expression, node.arguments)
    : O.none;

const STANDARD_REJECTION_MODE: ExpectRejectionMode = "standard";

const buildMemberAssertChain = (
  expectArg: ts.Expression,
  matcher: string,
  nodeArgs: ReadonlyArray<ts.Expression>,
) => ({
  expectArg,
  matcher,
  expectedArg: toExpectedArgPresence(RA.lookup(1)(nodeArgs)),
  rejectionMode: REJECTS_PROP_NAMES.has(matcher) ? ("rejects" as const) : STANDARD_REJECTION_MODE,
});

const isAssertPropAccess = (expr: ts.Expression): expr is ts.PropertyAccessExpression =>
  isIdentBasedPropertyAccess(expr) && ASSERT_FN_NAMES.has(expr.expression.text);

const tryParseMemberNodeAssert = (node: ts.CallExpression) =>
  isAssertPropAccess(node.expression)
    ? O.map((expectArg: ts.Expression) =>
        buildMemberAssertChain(
          expectArg,
          (node.expression as ts.PropertyAccessExpression).name.text,
          node.arguments,
        ),
      )(RA.head(node.arguments))
    : O.none;

const tryParseDirectNodeAssert = (node: ts.CallExpression) =>
  ts.isIdentifier(node.expression) && ASSERT_FN_NAMES.has(node.expression.text)
    ? O.map((expectArg: ts.Expression) => ({
        expectArg,
        matcher: "ok",
        expectedArg: ABSENT_EXPECTED_ARG,
        rejectionMode: STANDARD_REJECTION_MODE,
      }))(RA.head(node.arguments))
    : O.none;

const parseTestAssertionCall = (node: ts.CallExpression) =>
  flow(
    tryParseExpectAssertion,
    O.altW(() => tryParseMemberNodeAssert(node)),
    O.altW(() => tryParseDirectNodeAssert(node)),
  )(node);

const makeTraceEnv = (
  fileEnv: TestFileEnv,
  localBindings: ReadonlyMap<ts.Symbol, LocalTestBinding>,
) =>
  ({
    checker: fileEnv.checker,
    idBySymbol: fileEnv.graph.idBySymbol,
    localBindings,
    localWrapperMap: fileEnv.localWrapperMap,
  }) satisfies TestTraceEnv;

const collectCallDataflowEdges = (
  call: ts.CallExpression,
  targetId: string,
  collectArgComponents: (arg: ts.Expression) => ReadonlyArray<string>,
) =>
  flow(
    RA.flatMap(collectArgComponents),
    RA.filterMap((srcId) =>
      srcId === targetId
        ? O.none
        : O.some({ fromComponentId: srcId, toComponentId: targetId } satisfies DataflowEdge),
    ),
  )(call.arguments);

const appendWrapperCallTargets = (
  state: TestPass1State,
  expr: ts.Expression,
  fileEnv: TestFileEnv,
) =>
  (ts.isIdentifier(expr)
    ? {
        ...state,
        directTargets: [
          ...state.directTargets,
          ...lookupIdentWrapperTargets(expr, fileEnv.checker, fileEnv.localWrapperMap),
        ],
      }
    : state) satisfies TestPass1State;

const collectArgComponentIds = (
  arg: ts.Expression,
  state: TestPass1State,
  fileEnv: TestFileEnv,
) =>
  collectReferencedComponentsInExpr(arg, fileEnv.sf, makeTraceEnv(fileEnv, state.localBindings))
    .components;

const appendComponentCallState = (
  state: TestPass1State,
  call: ts.CallExpression,
  cid: string,
  fileEnv: TestFileEnv,
) =>
  ({
    ...state,
    directTargets: [...state.directTargets, cid],
    dataflowEdges: [
      ...state.dataflowEdges,
      ...collectCallDataflowEdges(call, cid, (arg) => collectArgComponentIds(arg, state, fileEnv)),
    ],
  }) satisfies TestPass1State;

const stepPass1CallNode = (
  state: TestPass1State,
  call: ts.CallExpression,
  fileEnv: TestFileEnv,
) =>
  flow(
    (expr: ts.Expression) =>
      resolveExpressionToComponentId(expr, fileEnv.checker, fileEnv.graph.idBySymbol),
    O.match(
      () => appendWrapperCallTargets(state, call.expression, fileEnv),
      (cid) => appendComponentCallState(state, call, cid, fileEnv),
    ),
  )(call.expression);

const resolveBindingElementPropKey = (el: ts.BindingElement, nameIdent: ts.Identifier) =>
  el.propertyName && isNamedPropertyKey(el.propertyName) ? el.propertyName.text : nameIdent.text;

const extractObjectBindingElementEntry = (
  el: ts.BindingElement,
  traced: LocalTestBinding,
  checker: ts.TypeChecker,
) =>
  ts.isIdentifier(el.name)
    ? flow(
        (ident: ts.Identifier) => resolveNodeSymbol(ident, checker),
        O.map(
          (sym) =>
            [
              sym,
              appendProjectedSegment(
                traced,
                resolveBindingElementPropKey(el, el.name as ts.Identifier),
              ),
            ] as const,
        ),
      )(el.name)
    : O.none;

const extractLocalBindingEntries = (
  name: ts.BindingName,
  traced: LocalTestBinding,
  checker: ts.TypeChecker,
) =>
  match(name)
    .when(ts.isIdentifier, (id) =>
      flow(
        (node: ts.Identifier) => resolveNodeSymbol(node, checker),
        O.map((sym) => [sym, traced] as const),
        RA.fromOption,
      )(id),
    )
    .when(ts.isObjectBindingPattern, (pat) =>
      RA.filterMap((el: ts.BindingElement) =>
        extractObjectBindingElementEntry(el, traced, checker),
      )(pat.elements),
    )
    .with(P._, () => EMPTY_BINDING_ENTRIES)
    .exhaustive();

const mergePass1Binding = (
  state: TestPass1State,
  name: ts.BindingName,
  traced: LocalTestBinding,
  checker: ts.TypeChecker,
) =>
  ({
    ...state,
    localBindings: extendLookupMap(
      state.localBindings,
      extractLocalBindingEntries(name, traced, checker),
    ),
  }) satisfies TestPass1State;

const traceInitInState = (
  init: ts.Expression,
  state: TestPass1State,
  fileEnv: TestFileEnv,
) => traceExprBinding(init, makeTraceEnv(fileEnv, state.localBindings));

const stepPass1VarDeclNode = (
  state: TestPass1State,
  decl: ts.VariableDeclaration,
  fileEnv: TestFileEnv,
) =>
  decl.initializer
    ? flow(
        (init: ts.Expression) => traceInitInState(init, state, fileEnv),
        O.match(
          () => state,
          (traced) => mergePass1Binding(state, decl.name, traced, fileEnv.checker),
        ),
      )(decl.initializer)
    : state;

const stepPass1Node = (state: TestPass1State, node: ts.Node, fileEnv: TestFileEnv) =>
  match(node)
    .when(ts.isCallExpression, (call) => stepPass1CallNode(state, call, fileEnv))
    .when(ts.isVariableDeclaration, (decl) => stepPass1VarDeclNode(state, decl, fileEnv))
    .otherwise(() => state);

const isFpErrorExpectedTag = (expectedArg: ExpectedArgPresence) =>
  match(expectedArg)
    .with({ tag: "absent" }, () => false)
    .with({ tag: "present" }, ({ expression }) =>
      flow(
        unwrapExpression,
        O.fromPredicate(ts.isStringLiteral),
        O.exists((lit) => FP_ERROR_TAGS.has(lit.text)),
      )(expression),
    )
    .exhaustive();

const isFpErrorAssertion = (
  tracedSubject: O.Option<LocalTestBinding>,
  expectedArg: ExpectedArgPresence,
) =>
  O.exists(
    (subject: LocalTestBinding) =>
      RA.some((segment: string) => FP_ERROR_CHECK_METHODS.has(segment))(subject.projectedPath) ||
      (O.exists((tail: string) => TAG_PROP_NAMES.has(tail))(RA.last(subject.projectedPath)) &&
        isFpErrorExpectedTag(expectedArg)),
  )(tracedSubject);

const resolveExpectedRefs = (
  expectedArg: ExpectedArgPresence,
  collectRefs: (node: ts.Node) => ExprReferenceContribution,
) =>
  match(expectedArg)
    .with({ tag: "absent" }, () => EMPTY_REF_CONTRIBUTION)
    .with({ tag: "present" }, ({ expression }) => collectRefs(expression))
    .exhaustive();

const resolveExpectedFingerprint = (expectedArg: ExpectedArgPresence) =>
  expectedArg.tag === "present"
    ? toFingerprintValue(fingerprintLiteralExpr(expectedArg.expression))
    : DYNAMIC_FINGERPRINT;

const resolveAssertionCategory = (
  parsed: ParsedExpectChain,
  tracedSubject: O.Option<LocalTestBinding>,
) =>
  isFpErrorAssertion(tracedSubject, parsed.expectedArg) || parsed.rejectionMode === "rejects"
    ? ("error" as const)
    : classifyMatcher(parsed.matcher);

const resolveBindingProjectedPath = O.match(
  () => EMPTY_STRINGS,
  (t: LocalTestBinding) => t.projectedPath,
);

const resolveBindingInputFp = O.match(
  () => DYNAMIC_FINGERPRINT,
  (t: LocalTestBinding) => t.inputFingerprint,
);

const collectAssertionRefLists = (
  tracedSubject: O.Option<LocalTestBinding>,
  subjectRefs: ExprReferenceContribution,
  expectedRefs: ExprReferenceContribution,
) => ({
  referencedComponents: RA.uniq(S.Eq)([
    ...RA.fromOption(O.map((t: LocalTestBinding) => t.componentId)(tracedSubject)),
    ...subjectRefs.components,
    ...expectedRefs.components,
  ]),
  referencedSubjectFields: RA.uniq(S.Eq)([
    ...subjectRefs.subjectFields,
    ...expectedRefs.subjectFields,
  ]),
});

const assembleAssertionRecord = (
  parsed: ParsedExpectChain,
  tracedSubject: O.Option<LocalTestBinding>,
  subjectRefs: ExprReferenceContribution,
  expectedRefs: ExprReferenceContribution,
) =>
  ({
    category: resolveAssertionCategory(parsed, tracedSubject),
    matcher: parsed.matcher,
    subjectTarget: toSubjectTarget(O.map((t: LocalTestBinding) => t.componentId)(tracedSubject)),
    projectedPath: resolveBindingProjectedPath(tracedSubject),
    inputFingerprint: resolveBindingInputFp(tracedSubject),
    expectedFingerprint: resolveExpectedFingerprint(parsed.expectedArg),
    expectedObjectKeys: extractExpectedObjectKeys(parsed.expectedArg),
    ...collectAssertionRefLists(tracedSubject, subjectRefs, expectedRefs),
  }) satisfies ExtractedAssertion;

const buildExtractedAssertion = (
  parsed: ParsedExpectChain,
  traceExpr: (expr: ts.Expression) => O.Option<LocalTestBinding>,
  collectRefs: (node: ts.Node) => ExprReferenceContribution,
) =>
  assembleAssertionRecord(
    parsed,
    traceExpr(parsed.expectArg),
    collectRefs(parsed.expectArg),
    resolveExpectedRefs(parsed.expectedArg, collectRefs),
  );

const extractBodyAssertions = (
  nodes: ReadonlyArray<ts.Node>,
  sf: ts.SourceFile,
  ctx: TestTraceEnv,
) =>
  flow(
    RA.filter(ts.isCallExpression),
    RA.filterMap(parseTestAssertionCall),
    RA.map((parsed) =>
      buildExtractedAssertion(
        parsed,
        (expr) => traceExprBinding(expr, ctx),
        (node) => collectReferencedComponentsInExpr(node, sf, ctx),
      ),
    ),
  )(nodes);

const extractTestBodyAnalysis = (body: ts.Node, fileEnv: TestFileEnv) => {
  const nodes = collectTsNodes(body, fileEnv.sf);
  const pass1 = RA.reduce<ts.Node, TestPass1State>(
    { directTargets: EMPTY_STRINGS, localBindings: new Map(), dataflowEdges: [] },
    (acc, node) => stepPass1Node(acc, node, fileEnv),
  )(nodes);
  return {
    directTargets: dedupeSortedStrings(pass1.directTargets),
    dataflowEdges: pass1.dataflowEdges,
    assertions: extractBodyAssertions(nodes, fileEnv.sf, makeTraceEnv(fileEnv, pass1.localBindings)),
  };
};

const extractStringArg = flow(
  O.map(unwrapExpression),
  O.filter(isStringLikeLiteral),
  O.map((lit) => lit.text),
);

const extractCallbackArg = (args: ReadonlyArray<ts.Expression>) =>
  flow(
    (items: ReadonlyArray<ts.Expression>) => RA.lookup(1)(items),
    O.map(unwrapExpression),
    O.filter(isFunctionValueExpr),
  )(args);

const extractFirstStringArg = flow(RA.head<ts.Expression>, extractStringArg);

const buildTestRegistration = (callNode: ts.CallExpression, eachCount: number) =>
  flow(
    () => O.Do,
    O.apS("name", extractFirstStringArg(callNode.arguments)),
    O.apS("callback", extractCallbackArg(callNode.arguments)),
    O.map(({ name, callback }) => ({ callNode, name, callback, eachCount }) satisfies TestRegistration),
  )();

const isDirectOrModifierTestCallee = (callee: ts.Expression) =>
  (ts.isIdentifier(callee) && TEST_FN_NAMES.has(callee.text)) ||
  (isIdentBasedPropertyAccess(callee) && TEST_FN_NAMES.has(callee.expression.text));

const isEachMethodAccess = (expr: ts.Expression) =>
  isIdentBasedPropertyAccess(expr) &&
  TEST_FN_NAMES.has(expr.expression.text) &&
  EACH_METHOD_NAMES.has(expr.name.text);

const isTestEachCallee = (callee: ts.Expression): callee is ts.CallExpression =>
  ts.isCallExpression(callee) && isEachMethodAccess(callee.expression);

const resolveEachCaseCount = (eachCall: ts.CallExpression) =>
  flow(
    RA.head<ts.Expression>,
    O.map(unwrapExpression),
    O.filter(ts.isArrayLiteralExpression),
    O.map((arr) => clampMinOne(arr.elements.length)),
    O.getOrElse(() => 2),
  )(eachCall.arguments);

const buildEachTestRegistration = (node: ts.CallExpression, eachCall: ts.CallExpression) =>
  flow(resolveEachCaseCount, (count) => buildTestRegistration(node, count))(eachCall);

const tryParseTestCall = (node: ts.CallExpression) =>
  match(node.expression)
    .when(isDirectOrModifierTestCallee, () => buildTestRegistration(node, 1))
    .when(isTestEachCallee, (eachCall) => buildEachTestRegistration(node, eachCall))
    .otherwise(() => O.none);

const isDescribeCallee = (callee: ts.Expression) =>
  (ts.isIdentifier(callee) && DESCRIBE_FN_NAMES.has(callee.text)) ||
  (isIdentBasedPropertyAccess(callee) && DESCRIBE_FN_NAMES.has(callee.expression.text));

const tryParseDescribeCall = (node: ts.CallExpression) =>
  isDescribeCallee(node.expression)
    ? flow(
        () => O.Do,
        O.apS("title", extractFirstStringArg(node.arguments)),
        O.apS("callback", extractCallbackArg(node.arguments)),
        O.map(({ title, callback }) => ({ title, body: callback.body }) satisfies DescribeRegistration),
      )()
    : O.none;

const formatTestFullName = (describeStack: ReadonlyArray<string>, name: string) =>
  describeStack.length > 0 ? formatQualifiedTestName(joinDescribeStack(describeStack), name) : name;

const resolveCombinedTestMocks = (
  body: ts.ConciseBody,
  { scopeMocks, fileEnv }: ScopeWalkContext,
) =>
  sortStringSet(
    toReadonlySet([
      ...scopeMocks,
      ...resolveMockedComponentsInNodes(
        collectTsNodes(body, fileEnv.sf),
        fileEnv.sf,
        fileEnv.checker,
        fileEnv.graph,
      ),
    ]),
  );

const assembleExtractedTestCase = (
  { callNode, name, eachCount }: TestRegistration,
  body: ts.ConciseBody,
  walkCtx: ScopeWalkContext,
) => {
  const { fileEnv, describeStack } = walkCtx;
  const loc = resolveTsNodeLocation(callNode, fileEnv.sf);
  return {
    id: formatTestId(fileEnv.fileName, formatNodeStart(callNode, fileEnv.sf)),
    name,
    fullName: formatTestFullName(describeStack, name),
    fileName: fileEnv.fileName,
    line: loc.line,
    locationKey: makeLocationKey(loc),
    eachCount,
    mockedTargets: resolveCombinedTestMocks(body, walkCtx),
    ...extractTestBodyAnalysis(body, fileEnv),
  } satisfies ExtractedTestCase;
};

const extractTestCaseFromReg = (reg: TestRegistration, walkCtx: ScopeWalkContext) =>
  flow(
    (fn: ts.FunctionLikeDeclaration) => O.fromNullable(fn.body),
    O.map((body) => assembleExtractedTestCase(reg, body, walkCtx)),
  )(reg.callback);

const extractDirectTestCase = (call: ts.CallExpression, walkCtx: ScopeWalkContext) =>
  flow(
    tryParseTestCall,
    O.flatMap((reg) => extractTestCaseFromReg(reg, walkCtx)),
    RA.fromOption,
  )(call);

const collectScopedTestsFromCall = (
  call: ts.CallExpression,
  walkCtx: ScopeWalkContext,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for mutually recursive describe scope walk
): ReadonlyArray<ExtractedTestCase> =>
  flow(
    tryParseDescribeCall,
    O.match(
      () => extractDirectTestCase(call, walkCtx),
      (desc) =>
        collectTestsInScope(desc.body, {
          ...walkCtx,
          describeStack: [...walkCtx.describeStack, desc.title],
        }),
    ),
  )(call);

const collectTestsFromScopeNodes = (
  scopeOwnNodes: ReadonlyArray<ts.Node>,
  walkCtx: ScopeWalkContext,
) =>
  flow(
    RA.filter(ts.isCallExpression),
    RA.flatMap((call) => collectScopedTestsFromCall(call, walkCtx)),
  )(scopeOwnNodes);

const collectTestsInScope = (
  root: ts.Node,
  walkCtx: ScopeWalkContext,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for mutually recursive scope traversal
): ReadonlyArray<ExtractedTestCase> => {
  const scopeOwnNodes = collectOwnBodyNodes(root, walkCtx.fileEnv.sf);
  return collectTestsFromScopeNodes(scopeOwnNodes, {
    ...walkCtx,
    scopeMocks: toReadonlySet([
      ...walkCtx.scopeMocks,
      ...resolveMockedComponentsInNodes(
        scopeOwnNodes,
        walkCtx.fileEnv.sf,
        walkCtx.fileEnv.checker,
        walkCtx.fileEnv.graph,
      ),
    ]),
  });
};

const extractTestCasesFromFile = (
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  graph: ProductionGraph,
) =>
  collectTestsInScope(sf, {
    describeStack: EMPTY_STRINGS,
    scopeMocks: new Set(),
    fileEnv: {
      sf,
      fileName: normalizeFilePath(sf.fileName),
      checker,
      graph,
      localWrapperMap: buildLocalWrapperMap(sf, checker, graph.idBySymbol),
    },
  });

// ---------------------------------------------------------------------------
// Stage 2: Property Analyzer & Test Classification
// ---------------------------------------------------------------------------

const extractSubjectComponentId = (subjectTarget: SubjectTarget) =>
  match(subjectTarget)
    .with({ tag: "component" }, ({ componentId }) => O.some(componentId))
    .with({ tag: "untracked" }, () => O.none)
    .exhaustive();

const extractDirectAssertedTargets = ({ test, components }: TestComponentContext) =>
  flow(
    RA.filterMap((a: ExtractedAssertion) => extractSubjectComponentId(a.subjectTarget)),
    RA.uniq(S.Eq),
    RA.filter(
      (targetId) => hasComponent(targetId, components) && hasStringMember(test.directTargets, targetId),
    ),
  )(test.assertions);

const isTargetAssertion = (a: ExtractedAssertion, targetId: string) =>
  O.exists((id: string) => id === targetId)(extractSubjectComponentId(a.subjectTarget));

const extractTargetErrorSignatures = (test: ExtractedTestCase, targetId: string) =>
  RA.filterMap((a: ExtractedAssertion) =>
    a.category === "error" && isTargetAssertion(a, targetId)
      ? O.some({
          inputFp: a.inputFingerprint,
          expectedFp: a.expectedFingerprint,
        } satisfies DirectErrorSignature)
      : O.none,
  )(test.assertions);

const extractLiteralPairKey = ({ inputFingerprint, expectedFingerprint }: ExtractedAssertion) =>
  inputFingerprint.tag === "literal" && expectedFingerprint.tag === "literal"
    ? O.some(makeValuePairKey(inputFingerprint.value, expectedFingerprint.value))
    : O.none;

const extractTargetValuePairs = (test: ExtractedTestCase, targetId: string) =>
  RA.filterMap((a: ExtractedAssertion) =>
    isTargetAssertion(a, targetId) ? extractLiteralPairKey(a) : O.none,
  )(test.assertions);

const expandTestTargetPairs = (test: ExtractedTestCase, components: ComponentMap) =>
  RA.map((targetId: string) => ({ targetId, test }) satisfies TargetTestPair)(
    extractDirectAssertedTargets({ test, components }),
  );

const buildTestsByComponent = (tests: ReadonlyArray<ExtractedTestCase>, components: ComponentMap) =>
  flow(
    RA.flatMap((test: ExtractedTestCase) => expandTestTargetPairs(test, components)),
    (pairs) => groupItemsByKey(pairs, (pair) => pair.targetId),
    RR.map(RA.map((pair: TargetTestPair) => pair.test)),
  )(tests);

const buildErrorSigsByComponent = flow(
  RA.map(([targetId, compTests]: readonly [string, ReadonlyArray<ExtractedTestCase>]) =>
    [
      targetId,
      RA.flatMap((t: ExtractedTestCase) => extractTargetErrorSignatures(t, targetId))(compTests),
    ] as const,
  ),
  toReadonlyRecord,
);

const buildValuePairsByComponent = flow(
  RA.map(([targetId, compTests]: readonly [string, ReadonlyArray<ExtractedTestCase>]) =>
    [
      targetId,
      toReadonlySet(
        RA.flatMap((t: ExtractedTestCase) => extractTargetValuePairs(t, targetId))(compTests),
      ),
    ] as const,
  ),
  toReadonlyRecord,
);

const buildDirectComponentIndex = (
  tests: ReadonlyArray<ExtractedTestCase>,
  components: ComponentMap,
) => {
  const testsByComponent = buildTestsByComponent(tests, components);
  const componentEntries = RR.toEntries(testsByComponent);
  return {
    testsByComponent,
    errorSigsByComponent: buildErrorSigsByComponent(componentEntries),
    valuePairsByComponent: buildValuePairsByComponent(componentEntries),
  } satisfies DirectComponentIndex;
};

const collectDistinctUnmockedFieldOwners = (
  fields: ReadonlyArray<string>,
  component: ProductionComponent,
  mockedSet: ReadonlySet<string>,
) =>
  toReadonlySet(
    flow(
      RA.flatMap((field: string) => lookupRecordList(field, component.returnFieldProvenance)),
      RA.filter((prov) => !mockedSet.has(prov)),
    )(fields),
  );

const isUnmockedLowerDep = (id: string, directId: string, mockedSet: ReadonlySet<string>) =>
  !mockedSet.has(id) && id !== directId;

const inferMultiComponentInvariant = ({ assertion, component, directId }: TrackedAssertionInput) =>
  assertion.referencedComponents.length >= 2
    ? O.some<InferredProperty>({
        kind: "system-invariant",
        directTargetId: directId,
        ownerComponentId: directId,
        label: formatInvariantLabel(component.name),
        assertion,
      })
    : O.none;

const inferCrossFieldInvariant = ({
  assertion,
  component,
  directId,
  evalEnv,
}: TrackedAssertionInput) =>
  assertion.referencedSubjectFields.length >= 2 &&
  collectDistinctUnmockedFieldOwners(
    assertion.referencedSubjectFields,
    component,
    evalEnv.mockedSet,
  ).size >= 2
    ? O.some<InferredProperty>({
        kind: "system-invariant",
        directTargetId: directId,
        ownerComponentId: directId,
        label: formatCrossFieldLabel(component.name),
        assertion,
      })
    : O.none;

const inferWholeObjectComposition = ({
  assertion,
  component,
  directId,
  evalEnv,
}: TrackedAssertionInput) =>
  assertion.projectedPath.length === 0 &&
  assertion.expectedObjectKeys.length >= 2 &&
  collectDistinctUnmockedFieldOwners(assertion.expectedObjectKeys, component, evalEnv.mockedSet)
    .size >= 2
    ? O.some<InferredProperty>({
        kind: "composition",
        directTargetId: directId,
        ownerComponentId: directId,
        label: formatCompositionLabel(component.name),
        assertion,
      })
    : O.none;

const makeProjectedOutputProp = (
  lowerId: string,
  { assertion, directId, evalEnv }: TrackedAssertionInput,
) =>
  ({
    kind: "projected-output",
    directTargetId: directId,
    ownerComponentId: lowerId,
    label: formatProjectedLabel(
      resolveComponentName(lowerId, evalEnv.components),
      joinDot(assertion.projectedPath),
    ),
    assertion,
  }) as InferredProperty;

const inferProjectedOutput = (input: TrackedAssertionInput) => {
  const { assertion, component, directId, evalEnv } = input;
  return flow(
    RA.head<string>,
    O.flatMap((headField) => RR.lookup(headField)(component.returnFieldProvenance)),
    O.filter((rawProv) => rawProv.length === 1),
    O.flatMap(RA.head),
    O.filter((lowerId) => isUnmockedLowerDep(lowerId, directId, evalEnv.mockedSet)),
    O.map((lowerId) => makeProjectedOutputProp(lowerId, input)),
  )(assertion.projectedPath);
};

const isMatchingFingerprint = (left: FingerprintValue, right: FingerprintValue) =>
  left.tag === "literal" && right.tag === "literal" && left.value === right.value;

const hasMatchingDirectErrorSig = (
  id: string,
  assertion: ExtractedAssertion,
  directIndex: DirectComponentIndex,
) =>
  O.exists(
    RA.some(
      (sig: DirectErrorSignature) =>
        isMatchingFingerprint(sig.expectedFp, assertion.expectedFingerprint) ||
        isMatchingFingerprint(sig.inputFp, assertion.inputFingerprint),
    ),
  )(RR.lookup(id)(directIndex.errorSigsByComponent));

const makeDelegatedErrorProp = (
  lowerId: string,
  { assertion, directId, evalEnv }: TrackedAssertionInput,
) =>
  ({
    kind: "delegated-error",
    directTargetId: directId,
    ownerComponentId: lowerId,
    label: formatErrorLabel(resolveComponentName(lowerId, evalEnv.components)),
    assertion,
  }) as InferredProperty;

const inferDelegatedError = (input: TrackedAssertionInput) => {
  const { assertion, component, directId, evalEnv } = input;
  return assertion.category === "error"
    ? flow(
        RA.filter((id: string) => isUnmockedLowerDep(id, directId, evalEnv.mockedSet)),
        RA.findFirst((lowerId) =>
          hasMatchingDirectErrorSig(lowerId, assertion, evalEnv.directIndex),
        ),
        O.map((lowerId) => makeDelegatedErrorProp(lowerId, input)),
      )(component.errorProvenance)
    : O.none;
};

const hasDirectValuePairMatch = (
  id: string,
  pairKey: string,
  directIndex: DirectComponentIndex,
) =>
  O.exists((pairs: ReadonlySet<string>) => pairs.has(pairKey))(
    RR.lookup(id)(directIndex.valuePairsByComponent),
  );

const makeDirectPassthroughProp = (
  lowerId: string,
  { assertion, directId, evalEnv }: TrackedAssertionInput,
) =>
  ({
    kind: "direct-passthrough",
    directTargetId: directId,
    ownerComponentId: lowerId,
    label: formatBehaviorLabel(resolveComponentName(lowerId, evalEnv.components)),
    assertion,
  }) as InferredProperty;

const inferDirectPassthrough = (input: TrackedAssertionInput) => {
  const { assertion, component, directId, evalEnv } = input;
  return assertion.projectedPath.length === 0 && component.directReturnProvenance.length === 1
    ? flow(
        () => O.Do,
        O.apS("lowerId", RA.head(component.directReturnProvenance)),
        O.apS("pairKey", extractLiteralPairKey(assertion)),
        O.filter(({ lowerId }) => isUnmockedLowerDep(lowerId, directId, evalEnv.mockedSet)),
        O.filter(({ lowerId, pairKey }) =>
          hasDirectValuePairMatch(lowerId, pairKey, evalEnv.directIndex),
        ),
        O.map(({ lowerId }) => makeDirectPassthroughProp(lowerId, input)),
      )()
    : O.none;
};

const makeComponentBehaviorProperty = ({ assertion, component, directId }: TrackedAssertionInput) =>
  ({
    kind: "component-behavior",
    directTargetId: directId,
    ownerComponentId: directId,
    label: formatBehaviorLabel(component.name),
    assertion,
  }) as InferredProperty;

const inferTrackedAssertionProperty = (input: TrackedAssertionInput) =>
  flow(
    inferMultiComponentInvariant,
    O.alt(() => inferCrossFieldInvariant(input)),
    O.alt(() => inferWholeObjectComposition(input)),
    O.alt(() => inferProjectedOutput(input)),
    O.alt(() => inferDelegatedError(input)),
    O.alt(() => inferDirectPassthrough(input)),
    O.getOrElse(() => makeComponentBehaviorProperty(input)),
  )(input);

const inferSpyInteractionProperty = (assertion: ExtractedAssertion) => {
  const targetId = flow(
    extractSubjectComponentId,
    O.alt(() => RA.head(assertion.referencedComponents)),
    O.getOrElse(() => "<spy>"),
  )(assertion.subjectTarget);
  return {
    kind: "interaction",
    directTargetId: targetId,
    ownerComponentId: targetId,
    label: "interaction wiring",
    assertion,
  } as InferredProperty;
};

const inferTrackedSubjectProperty = (
  directId: string,
  assertion: ExtractedAssertion,
  ctx: AssertionEvalEnv,
) =>
  flow(
    (id: string) => lookupComponent(id, ctx.components),
    O.map((component) =>
      inferTrackedAssertionProperty({ directId, assertion, component, evalEnv: ctx }),
    ),
  )(directId);

const inferAssertionProperty = (assertion: ExtractedAssertion, ctx: AssertionEvalEnv) =>
  assertion.category === "spy-interaction"
    ? O.some(inferSpyInteractionProperty(assertion))
    : flow(
        extractSubjectComponentId,
        O.flatMap((directId) => inferTrackedSubjectProperty(directId, assertion, ctx)),
      )(assertion.subjectTarget);

const isDelegatedKind = (kind: InferredPropertyKind) =>
  kind === "projected-output" || kind === "delegated-error" || kind === "direct-passthrough";

const isDelegatedProperty = (prop: InferredProperty) => isDelegatedKind(prop.kind);

const isDelegatedOnlyProperties = (properties: ReadonlyArray<InferredProperty>) =>
  properties.length > 0 && RA.every(isDelegatedProperty)(properties);

const hasDirectTestsForComponent = (componentId: string, directIndex: DirectComponentIndex) =>
  O.exists((list: ReadonlyArray<ExtractedTestCase>) => list.length > 0)(
    RR.lookup(componentId)(directIndex.testsByComponent),
  );

const hasUnmockedDirectCallee = (tid: string, filterEnv: ComponentFilterEnv) =>
  O.exists((comp: ProductionComponent) =>
    RA.some((dep: string) => !filterEnv.mockedSet.has(dep))(comp.directCallees),
  )(lookupComponent(tid, filterEnv.components));

const isTargetingHigherLevel = (test: ExtractedTestCase, filterEnv: ComponentFilterEnv) =>
  RA.some((tid: string) => hasUnmockedDirectCallee(tid, filterEnv))(test.directTargets);

const classifyDelegatedProperties = (
  properties: ReadonlyArray<InferredProperty>,
  directIndex: DirectComponentIndex,
) =>
  flow(
    RA.map((p: InferredProperty) => p.ownerComponentId),
    RA.uniq(S.Eq),
    (owners) =>
      (owners.length === 1 &&
      O.exists((lowerId: string) => hasDirectTestsForComponent(lowerId, directIndex))(
        RA.head(owners),
      )
        ? "potentially-redundant"
        : "composition") satisfies TestClassification,
  )(properties);

const buildClassificationSignals = (
  { test, properties }: TestPropertyBundle,
  ctx: AssertionEvalEnv,
) => ({
  hasInvariant: RA.some((p: InferredProperty) => p.kind === "system-invariant")(properties),
  hasComposition:
    RA.some((p: InferredProperty) => p.kind === "interaction" || p.kind === "composition")(
      properties,
    ) || test.dataflowEdges.length > 0,
  allDelegated: isDelegatedOnlyProperties(properties),
  higherLevelOwnBehavior:
    properties.length > 0 &&
    isTargetingHigherLevel(test, { mockedSet: ctx.mockedSet, components: ctx.components }),
});

const resolveTestClassification = (bundle: TestPropertyBundle, ctx: AssertionEvalEnv) =>
  match(buildClassificationSignals(bundle, ctx))
    .with({ hasInvariant: true }, () => "system-invariant" as const)
    .with({ hasComposition: true }, () => "composition" as const)
    .with({ allDelegated: true }, () =>
      classifyDelegatedProperties(bundle.properties, ctx.directIndex),
    )
    .with({ higherLevelOwnBehavior: true }, () => "composition" as const)
    .otherwise(() => "component" as const) satisfies TestClassification;

const classifyTestCase = (test: ExtractedTestCase, scopeContext: ScopeIndexContext) => {
  const ctx: AssertionEvalEnv = {
    mockedSet: toReadonlySet(test.mockedTargets),
    components: scopeContext.components,
    directIndex: scopeContext.directIndex,
  };
  const properties = RA.filterMap((a: ExtractedAssertion) => inferAssertionProperty(a, ctx))(
    test.assertions,
  );
  return {
    test,
    properties,
    classification: resolveTestClassification({ test, properties }, ctx),
  } satisfies ClassifiedTestCase;
};

// ---------------------------------------------------------------------------
// Stage 3: Rule Engines (Redundancy, Lowest-Level, Single Responsibility)
// ---------------------------------------------------------------------------

const extractUniquePropField = (
  properties: ReadonlyArray<InferredProperty>,
  selectField: (p: InferredProperty) => string,
) =>
  flow(
    RA.map(selectField),
    RA.uniq(S.Eq),
    O.fromPredicate((ids) => ids.length === 1),
    O.flatMap(RA.head),
  )(properties);

const extractUniqueDelegatedPair = (properties: ReadonlyArray<InferredProperty>) =>
  flow(
    () => O.Do,
    O.apS("higherId", extractUniquePropField(properties, (p) => p.directTargetId)),
    O.apS("lowerId", extractUniquePropField(properties, (p) => p.ownerComponentId)),
    O.apS("firstProp", RA.head(properties)),
  )();

const extractSingleEdgeDelegation = (ct: ClassifiedTestCase) =>
  isDelegatedOnlyProperties(ct.properties)
    ? flow(
        extractUniqueDelegatedPair,
        O.map(
          ({ higherId, lowerId, firstProp }) =>
            ({
              ct,
              higherId,
              lowerId,
              propertyLabel: firstProp.label,
              caseCount: ct.properties.length * ct.test.eachCount,
            }) satisfies SingleEdgeDelegation,
        ),
      )(ct.properties)
    : O.none;

const isSingleEdgeDelegatedTest = flow(
  extractSingleEdgeDelegation,
  O.exists(() => true),
);

const isNonDelegatedCompositionTest = (ct: ClassifiedTestCase) =>
  (ct.classification === "composition" || ct.classification === "system-invariant") &&
  !isSingleEdgeDelegatedTest(ct);

const collectUnmockedEdgeKeys = (
  hId: string,
  hComp: ProductionComponent,
  mockedSet: ReadonlySet<string>,
) =>
  RA.filterMap((lId: string) =>
    mockedSet.has(lId) ? O.none : O.some(makeEdgeKey(hId, lId)),
  )(hComp.transitiveCallees);

const collectTargetCoveredEdges = (hId: string, filterEnv: ComponentFilterEnv) =>
  O.match(
    () => EMPTY_STRINGS,
    (hComp: ProductionComponent) => collectUnmockedEdgeKeys(hId, hComp, filterEnv.mockedSet),
  )(lookupComponent(hId, filterEnv.components));

const collectTargetsCoveredEdges = (
  directTargets: ReadonlyArray<string>,
  filterEnv: ComponentFilterEnv,
) => RA.flatMap((hId: string) => collectTargetCoveredEdges(hId, filterEnv))(directTargets);

const collectTestCoveredEdges = ({ test }: ClassifiedTestCase, components: ComponentMap) =>
  collectTargetsCoveredEdges(test.directTargets, {
    mockedSet: toReadonlySet(test.mockedTargets),
    components,
  });

const collectCompositionCoveredEdges = ({ classifiedTests, components }: ClassifiedTestSuite) =>
  toReadonlySet(
    flow(
      RA.filter(isNonDelegatedCompositionTest),
      RA.flatMap((ct) => collectTestCoveredEdges(ct, components)),
    )(classifiedTests),
  );

const evaluateDelegatedEdgeGroups = <F>(
  classifiedTests: ReadonlyArray<ClassifiedTestCase>,
  isEligible: (cand: SingleEdgeDelegation) => boolean,
  evaluateGroup: (edgeKey: string, group: ReadonlyArray<SingleEdgeDelegation>) => ReadonlyArray<F>,
) =>
  flow(
    RA.filterMap(extractSingleEdgeDelegation),
    RA.filter(isEligible),
    (items) => groupItemsByKey(items, (c) => makeEdgeKey(c.higherId, c.lowerId)),
    RR.toEntries,
    RA.flatMap(([edgeKey, group]) => evaluateGroup(edgeKey, group)),
  )(classifiedTests);

const isSoleWiringGuardActive = (
  coverage: CompositionCoverage,
  idx: number,
  caseCount: number,
  minRepeatedCases: number,
) => coverage === "uncovered" && idx === 0 && caseCount < minRepeatedCases;

const collectExistingLowerTestNames = (id: string, directIndex: DirectComponentIndex) =>
  flow(
    (cid: string) => lookupRecordList(cid, directIndex.testsByComponent),
    RA.map((t) => t.fullName),
    RA.uniq(S.Eq),
  )(id);

const toCrossLevelFinding = (
  cand: SingleEdgeDelegation,
  coverage: CompositionCoverage,
  { components, directIndex }: ScopeIndexContext,
) => {
  const { fullName, fileName, line, locationKey } = cand.ct.test;
  return {
    kind: "redundantCrossLevelTest",
    testName: fullName,
    fileName,
    line,
    locationKey,
    property: cand.propertyLabel,
    higherComponent: resolveComponentName(cand.higherId, components),
    lowerComponent: resolveComponentName(cand.lowerId, components),
    existingTests: collectExistingLowerTestNames(cand.lowerId, directIndex),
    confidence: coverage === "covered" ? "high" : "medium",
  } satisfies RedundantCrossLevelFinding;
};

const evaluateEdgeRedundancyGroup = (
  edgeKey: string,
  candidates: ReadonlyArray<SingleEdgeDelegation>,
  coveredEdges: ReadonlySet<string>,
  scopeContext: ScopeIndexContext,
  minRepeatedCases: number,
) => {
  const coverage: CompositionCoverage = coveredEdges.has(edgeKey) ? "covered" : "uncovered";
  return RA.filterMapWithIndex((idx: number, cand: SingleEdgeDelegation) =>
    isSoleWiringGuardActive(coverage, idx, cand.caseCount, minRepeatedCases)
      ? O.none
      : O.some(toCrossLevelFinding(cand, coverage, scopeContext)),
  )(candidates);
};

const detectCrossLevelRedundancies = ({
  classifiedTests,
  scopeContext,
  options,
}: RuleEvaluationContext) =>
  evaluateDelegatedEdgeGroups(
    classifiedTests,
    (cand) => hasDirectTestsForComponent(cand.lowerId, scopeContext.directIndex),
    (edgeKey, group) =>
      evaluateEdgeRedundancyGroup(
        edgeKey,
        group,
        collectCompositionCoveredEdges({ classifiedTests, components: scopeContext.components }),
        scopeContext,
        options.minRepeatedCases,
      ),
  );

const formatConcreteAssertionSig = ({
  subjectTarget,
  inputFingerprint,
  expectedFingerprint,
  projectedPath,
  category,
  matcher,
}: ExtractedAssertion) =>
  subjectTarget.tag === "component" &&
  inputFingerprint.tag === "literal" &&
  expectedFingerprint.tag === "literal"
    ? O.some(
        joinPipe([
          subjectTarget.componentId,
          joinDot(projectedPath),
          category,
          matcher,
          inputFingerprint.value,
          expectedFingerprint.value,
        ]),
      )
    : O.none;

const extractConcreteTestSigSet = (test: ExtractedTestCase) =>
  test.directTargets.length > 0 && test.assertions.length > 0
    ? flow(
        RA.traverse(O.Applicative)(formatConcreteAssertionSig),
        O.map(toReadonlySet),
      )(test.assertions)
    : O.none;

const isSubsetSignatures = (subset: ReadonlySet<string>, superset: ReadonlySet<string>) =>
  RA.every((sig: string) => superset.has(sig))([...subset]);

const formatTestBucketKey = (
  targets: ReadonlyArray<string>,
  mocks: ReadonlyArray<string>,
) => formatBucketKeyParts(joinComma(targets), joinComma(mocks));

const formatDirectTargetLabel = (
  test: ExtractedTestCase,
  resolveName: (id: string) => string,
) => joinCommaSpace(RA.map(resolveName)(test.directTargets));

const makeDuplicateFinding = (
  test: ExtractedTestCase,
  targetLabel: string,
  primaryTest: string,
) =>
  ({
    kind: "duplicateSameLevelTest",
    testName: test.fullName,
    fileName: test.fileName,
    line: test.line,
    locationKey: test.locationKey,
    targetComponent: targetLabel,
    primaryTest,
  }) satisfies DuplicateSameLevelFinding;

const appendSeenConcreteEntry = (
  state: DuplicateScanState,
  bucketKey: string,
  entry: ConcreteTestEntry,
) =>
  ({
    seenByBucket: appendGroupedItem(state.seenByBucket, bucketKey, entry),
    findings: state.findings,
  }) satisfies DuplicateScanState;

const recordDuplicateMatch = (
  state: DuplicateScanState,
  test: ExtractedTestCase,
  targetLabel: string,
  primaryTest: string,
) =>
  ({
    seenByBucket: state.seenByBucket,
    findings: [...state.findings, makeDuplicateFinding(test, targetLabel, primaryTest)],
  }) satisfies DuplicateScanState;

const recordOrReportDuplicate = (
  sigSet: ReadonlySet<string>,
  state: DuplicateScanState,
  test: ExtractedTestCase,
  resolveName: (id: string) => string,
) => {
  const bucketKey = formatTestBucketKey(test.directTargets, test.mockedTargets);
  const targetLabel = formatDirectTargetLabel(test, resolveName);
  return flow(
    RA.findFirst((prev: ConcreteTestEntry) => isSubsetSignatures(sigSet, prev.signatures)),
    O.match(
      () => appendSeenConcreteEntry(state, bucketKey, { test, signatures: sigSet, targetLabel }),
      (dup) => recordDuplicateMatch(state, test, targetLabel, dup.test.fullName),
    ),
  )(lookupRecordList(bucketKey, state.seenByBucket));
};

const stepDuplicateScan = (
  state: DuplicateScanState,
  test: ExtractedTestCase,
  resolveName: (id: string) => string,
) =>
  O.match(
    () => state,
    (sigSet: ReadonlySet<string>) => recordOrReportDuplicate(sigSet, state, test, resolveName),
  )(extractConcreteTestSigSet(test));

const detectSameLevelDuplicates = ({ classifiedTests, components }: ClassifiedTestSuite) =>
  RA.reduce<ClassifiedTestCase, DuplicateScanState>(
    { seenByBucket: {}, findings: [] },
    (acc, ct) => stepDuplicateScan(acc, ct.test, (id) => resolveComponentName(id, components)),
  )(classifiedTests).findings;

const detectRedundancies = (input: RuleEvaluationContext) => {
  const { classifiedTests, scopeContext, options } = input;
  return [
    ...detectCrossLevelRedundancies(input),
    ...(options.checkSameLevelDuplicates === "enabled"
      ? detectSameLevelDuplicates({ classifiedTests, components: scopeContext.components })
      : []),
  ] satisfies ReadonlyArray<RedundantTestFinding>;
};

const isEligibleLowestLevelCandidate = (
  cand: SingleEdgeDelegation,
  { components, directIndex }: ScopeIndexContext,
) =>
  flow(
    () => O.Do,
    O.apS("higherComp", lookupComponent(cand.higherId, components)),
    O.apS("lowerComp", lookupComponent(cand.lowerId, components)),
    O.exists(
      ({ higherComp, lowerComp }) =>
        lowerComp.visibility === "exported" &&
        !hasDirectTestsForComponent(cand.lowerId, directIndex) &&
        higherComp.transitiveCallees.length >= 2,
    ),
  )();

const toLowestLevelFinding = (
  entry: SingleEdgeDelegation,
  totalCases: number,
  resolveName: (id: string) => string,
) => {
  const { fullName, fileName, line, locationKey } = entry.ct.test;
  return {
    testName: fullName,
    fileName,
    line,
    locationKey,
    property: entry.propertyLabel,
    higherComponent: resolveName(entry.higherId),
    lowerComponent: resolveName(entry.lowerId),
    caseCount: totalCases,
  } satisfies LowestLevelFinding;
};

const evaluateLowestLevelGroup = (
  entries: ReadonlyArray<SingleEdgeDelegation>,
  minDelegatedCases: number,
  resolveName: (id: string) => string,
) => {
  const totalCases = RA.reduce<SingleEdgeDelegation, number>(0, (acc, e) => acc + e.caseCount)(
    entries,
  );
  return totalCases < minDelegatedCases
    ? EMPTY_LOWEST_FINDINGS
    : RA.map((entry: SingleEdgeDelegation) => toLowestLevelFinding(entry, totalCases, resolveName))(
        entries,
      );
};

const detectLowestLevelViolations = ({
  classifiedTests,
  scopeContext,
  options,
}: RuleEvaluationContext) =>
  evaluateDelegatedEdgeGroups(
    classifiedTests,
    (cand) => isEligibleLowestLevelCandidate(cand, scopeContext),
    (_edgeKey, entries) =>
      evaluateLowestLevelGroup(entries, options.minDelegatedCases, (id) =>
        resolveComponentName(id, scopeContext.components),
      ),
  );

const hasDataflowLink = ({ leftId, rightId }: ComponentPair, edges: ReadonlyArray<DataflowEdge>) =>
  RA.some(
    (e: DataflowEdge) =>
      (e.fromComponentId === leftId && e.toComponentId === rightId) ||
      (e.fromComponentId === rightId && e.toComponentId === leftId),
  )(edges);

const hasJointAssertionLink = (
  { leftId, rightId }: ComponentPair,
  assertions: ReadonlyArray<ExtractedAssertion>,
) =>
  RA.some(
    (a: ExtractedAssertion) =>
      hasStringMember(a.referencedComponents, leftId) &&
      hasStringMember(a.referencedComponents, rightId),
  )(assertions);

const isComponentPairRelated = (pair: ComponentPair, { test, components }: TestComponentContext) =>
  pair.leftId === pair.rightId ||
  flow(
    () => O.Do,
    O.apS("a", lookupComponent(pair.leftId, components)),
    O.apS("b", lookupComponent(pair.rightId, components)),
    O.exists(
      ({ a, b }) =>
        a.fileName === b.fileName ||
        hasStringMember(a.transitiveCallees, pair.rightId) ||
        hasStringMember(b.transitiveCallees, pair.leftId) ||
        hasDataflowLink(pair, test.dataflowEdges) ||
        hasJointAssertionLink(pair, test.assertions),
    ),
  )();

const stepClusterFrontier = (
  curr: string,
  state: ClusterFrontierState,
  ctx: ClusterWalkContext,
) => {
  const neighbors = RA.filter(
    (other: string) =>
      !state.visited.has(other) &&
      isComponentPairRelated({ leftId: curr, rightId: other }, ctx.subject),
  )(ctx.assertedIds);
  return expandClusterFrontier(
    {
      frontier: [...RA.dropLeft(1)(state.frontier), ...neighbors],
      visited: toReadonlySet([...state.visited, ...neighbors]),
      members: [...state.members, curr],
    },
    ctx,
  );
};

const expandClusterFrontier = (
  state: ClusterFrontierState,
  ctx: ClusterWalkContext,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for mutually recursive BFS cluster walk
): Readonly<{ readonly visited: ReadonlySet<string>; readonly members: ReadonlyArray<string> }> =>
  flow(
    RA.head<string>,
    O.match(
      () => ({ visited: state.visited, members: state.members }),
      (curr) => stepClusterFrontier(curr, state, ctx),
    ),
  )(state.frontier);

const formatClusterNames = (memberIds: ReadonlyArray<string>, components: ComponentMap) =>
  flow(
    RA.map((id: string) => resolveComponentName(id, components)),
    RA.sort(S.Ord),
  )(memberIds);

const expandAndAppendCluster = (acc: ClusterAccum, start: string, ctx: ClusterWalkContext) => {
  const expanded = expandClusterFrontier(
    { frontier: [start], visited: toReadonlySet([...acc.visited, start]), members: EMPTY_STRINGS },
    ctx,
  );
  return {
    visited: expanded.visited,
    clusters: [...acc.clusters, formatClusterNames(expanded.members, ctx.subject.components)],
  } satisfies ClusterAccum;
};

const computeResponsibilityClusters = (
  assertedIds: ReadonlyArray<string>,
  subject: TestComponentContext,
) =>
  RA.reduce<string, ClusterAccum>(
    { visited: new Set(), clusters: [] },
    (acc, start) =>
      acc.visited.has(start)
        ? acc
        : expandAndAppendCluster(acc, start, { assertedIds, subject }),
  )(assertedIds).clusters;

const extractTestAssertedComponentIds = ({ test, components }: TestComponentContext) =>
  flow(
    RA.flatMap((a: ExtractedAssertion) => [
      ...RA.fromOption(extractSubjectComponentId(a.subjectTarget)),
      ...a.referencedComponents,
    ]),
    RA.filter((id) => hasComponent(id, components)),
    RA.uniq(S.Eq),
  )(test.assertions);

const makeResponsibilityFinding = (
  test: ExtractedTestCase,
  groups: ReadonlyArray<ReadonlyArray<string>>,
) =>
  ({
    testName: test.fullName,
    fileName: test.fileName,
    line: test.line,
    locationKey: test.locationKey,
    groups,
  }) satisfies SingleResponsibilityFinding;

const evaluateSingleResponsibilityTest = (
  subject: TestComponentContext,
  minUnrelatedComponents: number,
) =>
  flow(
    extractTestAssertedComponentIds,
    O.fromPredicate((ids) => ids.length >= minUnrelatedComponents),
    O.map((ids) => computeResponsibilityClusters(ids, subject)),
    O.filter((clusters) => clusters.length >= minUnrelatedComponents),
    O.map((groups) => makeResponsibilityFinding(subject.test, groups)),
  )(subject);

const detectSingleResponsibilityViolations = (
  { classifiedTests, components }: ClassifiedTestSuite,
  options: TestScopeOptions,
) =>
  RA.filterMap((ct: ClassifiedTestCase) =>
    evaluateSingleResponsibilityTest({ test: ct.test, components }, options.minUnrelatedComponents),
  )(classifiedTests);

// ---------------------------------------------------------------------------
// Public Entrypoint (Memoized by Program & Options)
// ---------------------------------------------------------------------------

const indexByFile = <T extends Readonly<Record<"fileName", string>>>(items: ReadonlyArray<T>) =>
  groupItemsByKey(items, (item) => item.fileName);

const toTestCaseSummary = (
  { test, classification }: ClassifiedTestCase,
  components: ComponentMap,
) =>
  ({
    id: test.id,
    name: test.name,
    fullName: test.fullName,
    fileName: test.fileName,
    line: test.line,
    locationKey: test.locationKey,
    classification,
    directTargets: RA.map((id: string) => resolveComponentName(id, components))(test.directTargets),
    mockedTargets: RA.map((id: string) => resolveComponentName(id, components))(test.mockedTargets),
  }) satisfies TestCaseSummary;

const extractFileTestsWithChecker = (
  sf: ts.SourceFile,
  program: ts.Program,
  graph: ProductionGraph,
) => extractTestCasesFromFile(sf, program.getTypeChecker(), graph);

const collectProjectExtractedTests = (
  program: ts.Program,
  graph: ProductionGraph,
  testPatterns: ReadonlyArray<string>,
) =>
  flow(
    collectProjectSourceFiles,
    RA.filter((sf) => isSourceFileMatchingPatterns(sf, testPatterns)),
    RA.flatMap((sf) => extractFileTestsWithChecker(sf, program, graph)),
  )(program);

const collectResponsibilityFindings = ({
  classifiedTests,
  scopeContext,
  options,
}: RuleEvaluationContext) =>
  indexByFile(
    detectSingleResponsibilityViolations(
      { classifiedTests, components: scopeContext.components },
      options,
    ),
  );

const evaluateTestScopeRules = (input: RuleEvaluationContext) =>
  ({
    tests: RA.map((ct: ClassifiedTestCase) =>
      toTestCaseSummary(ct, input.scopeContext.components),
    )(input.classifiedTests),
    redundancyByFile: indexByFile(detectRedundancies(input)),
    lowestLevelByFile: indexByFile(detectLowestLevelViolations(input)),
    responsibilityByFile: collectResponsibilityFindings(input),
  }) satisfies TestScopeAnalysis;

const computeTestScopeAnalysis = (program: ts.Program, options: TestScopeOptions) => {
  const graph = buildProductionGraph(program, options.testPatterns);
  const extractedTests = collectProjectExtractedTests(program, graph, options.testPatterns);
  const scopeContext: ScopeIndexContext = {
    components: graph.componentsById,
    directIndex: buildDirectComponentIndex(extractedTests, graph.componentsById),
  };
  return evaluateTestScopeRules({
    classifiedTests: RA.map((t: ExtractedTestCase) => classifyTestCase(t, scopeContext))(
      extractedTests,
    ),
    scopeContext,
    options,
  });
};

const serializeOptionsKey = (options: TestScopeOptions) =>
  stringifyOptionsPayload({
    testPatterns: RA.sort(S.Ord)(options.testPatterns),
    minRepeatedCases: options.minRepeatedCases,
    minDelegatedCases: options.minDelegatedCases,
    minUnrelatedComponents: options.minUnrelatedComponents,
    checkSameLevelDuplicates: options.checkSameLevelDuplicates,
  });

const analysisCache = new WeakMap<ts.Program, Readonly<Record<string, TestScopeAnalysis>>>();

export const analyzeTestScope = (
  program: ts.Program,
  options: TestScopeOptions = DEFAULT_TEST_SCOPE_OPTIONS,
) =>
  memoizeByProgramAndKey(program, serializeOptionsKey(options), analysisCache, (p) =>
    computeTestScopeAnalysis(p, options),
  );
