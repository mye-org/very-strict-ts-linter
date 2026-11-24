import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import * as S from "fp-ts/lib/string.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { memoizeByProgramAndKey } from "../lib/program-memo.js";
import { collectProjectSourceFiles, normalizeFilePath } from "../lib/source-paths.js";
import { makeLocationKey, resolveTsNodeLocation } from "../lib/ts-node-location.js";
import { collectTsNodesUntil } from "../lib/ts-node-traversal.js";
import {
  extractFileRuntimeExports,
  isBarrelFile,
  resolveCanonicalSymbol,
  unwrapExpression,
} from "./module-symbol-graph.js";

export type PurityStatus = "pure" | "impure";
export type ModulePurityStatus = "pure" | "impure" | "neutral";

export type PurityOptions = Readonly<
  Record<"effectTypes" | "impureModules" | "pureModules", ReadonlyArray<string>>
>;

export type FunctionPurityRecord = Readonly<
  Record<"id" | "name" | "fileName" | "locationKey", string> &
    Record<"line" | "complexity", number> &
    Record<"isExported" | "isNested", true | false> & {
      readonly node: ts.FunctionLikeDeclaration;
      readonly reportNode: ts.Node;
      readonly purity: PurityStatus;
      readonly reasons: ReadonlyArray<string>;
    }
>;

export type { FunctionPurityRecord as FunctionPurityInfo };

export type FilePuritySummary = Readonly<
  Record<"fileName", string> &
    Record<"isBarrel", true | false> & {
      readonly modulePurity: ModulePurityStatus;
      readonly functions: ReadonlyArray<FunctionPurityRecord>;
      readonly exportedFunctions: ReadonlyArray<FunctionPurityRecord>;
      readonly pureExportedFunctions: ReadonlyArray<FunctionPurityRecord>;
      readonly impureExportedFunctions: ReadonlyArray<FunctionPurityRecord>;
      readonly exportPurityByName: Readonly<Record<string, PurityStatus>>;
    }
>;

export type ProgramPurityAnalysis = Readonly<{
  readonly files: Readonly<Record<string, FilePuritySummary>>;
  readonly functionsByLocation: Readonly<Record<string, FunctionPurityRecord>>;
}>;

export const DEFAULT_EFFECT_TYPES = [
  "Promise",
  "Task",
  "TaskEither",
  "IO",
  "IOEither",
  "ReaderTaskEither",
  "Effect",
  "Observable",
] as const satisfies ReadonlyArray<string>;

export const DEFAULT_IMPURE_MODULES = [
  "node:fs",
  "fs",
  "node:child_process",
  "child_process",
  "node:http",
  "http",
  "node:https",
  "https",
  "node:net",
  "net",
  "prisma",
  "@prisma/",
  "pg",
  "mysql2",
  "typeorm",
  "drizzle-orm",
  "mongoose",
  "sequelize",
  "knex",
  "kysely",
  "axios",
  "node-fetch",
  "got",
  "undici",
  "express",
  "fastify",
  "koa",
  "hono",
] as const satisfies ReadonlyArray<string>;

const DEFAULT_PURITY_OPTIONS: PurityOptions = {
  effectTypes: DEFAULT_EFFECT_TYPES,
  impureModules: DEFAULT_IMPURE_MODULES,
  pureModules: [],
};

const ASSIGNMENT_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

const BRANCHING_SYNTAX_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
]);

const SHORT_CIRCUIT_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

const INCREMENT_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
]);

const MUTATING_ARRAY_OR_COLLECTION_METHODS: ReadonlySet<string> = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "add",
  "delete",
  "clear",
]);

const MUTATING_OBJECT_STATIC_METHODS: ReadonlySet<string> = new Set([
  "assign",
  "defineProperty",
  "defineProperties",
  "setPrototypeOf",
]);

const MUTATING_REFLECT_STATIC_METHODS: ReadonlySet<string> = new Set([
  "set",
  "deleteProperty",
  "defineProperty",
]);

const MUTABLE_COLLECTION_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Array",
  "Map",
  "WeakMap",
  "Set",
  "WeakSet",
]);

const OBJECT_GLOBAL_NAMES: ReadonlySet<string> = new Set(["Object"]);
const REFLECT_GLOBAL_NAMES: ReadonlySet<string> = new Set(["Reflect"]);
const CONSOLE_GLOBAL_NAMES: ReadonlySet<string> = new Set(["console"]);
const DATE_GLOBAL_NAMES: ReadonlySet<string> = new Set(["Date"]);
const PROCESS_GLOBAL_NAMES: ReadonlySet<string> = new Set(["process"]);

const IMPURE_DIRECT_GLOBALS: ReadonlySet<string> = new Set([
  "fetch",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "queueMicrotask",
  "alert",
  "confirm",
  "prompt",
]);

const DOM_IMPURE_GLOBALS: ReadonlySet<string> = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
  "location",
  "history",
]);

const IMPURE_MEMBER_CALLS = {
  Date: new Set(["now"]),
  Math: new Set(["random"]),
  crypto: new Set(["randomUUID", "getRandomValues"]),
  performance: new Set(["now"]),
} as const satisfies Readonly<Record<string, ReadonlySet<string>>>;

const IMPURE_PROCESS_PROPS: ReadonlySet<string> = new Set([
  "env",
  "exit",
  "argv",
  "cwd",
  "hrtime",
  "stdout",
  "stderr",
  "stdin",
]);

const POLYMORPHIC_HOF_NAMES: ReadonlySet<string> = new Set([
  "map",
  "filter",
  "reduce",
  "reduceRight",
  "flatMap",
  "every",
  "some",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "toSorted",
  "pipe",
  "flow",
  "filterMap",
  "chain",
  "match",
  "matchW",
  "with",
  "otherwise",
  "exhaustive",
  "fold",
  "foldW",
  "getOrElse",
  "getOrElseW",
  "alt",
  "altW",
  "bimap",
  "mapLeft",
  "tap",
  "exists",
  "bind",
  "apS",
  "findFirst",
  "findFirstMap",
]);

type ScopeLevel = "top-level" | "nested";
type ExportVisibility = "exported" | "internal";

type SymbolCallRef = Readonly<Record<"calleeText", string> & { readonly targetSym: ts.Symbol }>;

type HofInlineCallback = Readonly<
  Record<"hofName", string> & { readonly fn: ts.FunctionLikeDeclaration }
>;

type HofRefCallback = Readonly<
  Record<"callbackName" | "hofName", string> & { readonly targetSym: ts.Symbol }
>;

type FunctionPlacement = Readonly<{
  readonly reportNode: ts.Node;
  readonly exportStatus: ExportVisibility;
  readonly nesting: ScopeLevel;
}>;

type CollectedFunction = Readonly<
  Record<"id" | "name" | "filePath" | "locationKey", string> &
    Record<"line" | "complexity", number> & {
      readonly node: ts.FunctionLikeDeclaration;
      readonly placement: FunctionPlacement;
      readonly symbol: O.Option<ts.Symbol>;
      readonly directReasons: ReadonlyArray<string>;
      readonly callDeps: ReadonlyArray<SymbolCallRef>;
      readonly hofInlineCallbacks: ReadonlyArray<HofInlineCallback>;
      readonly hofRefCallbacks: ReadonlyArray<HofRefCallback>;
    }
>;

type FunctionRegistration = Readonly<
  Record<"name", string> & {
    readonly fn: ts.FunctionLikeDeclaration;
    readonly placement: FunctionPlacement;
    readonly symbol: O.Option<ts.Symbol>;
  }
>;

type MemberCallTarget = Readonly<Record<"objText" | "propName", string>>;

type InspectionContext = Readonly<{
  readonly sf: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly options: PurityOptions;
  readonly effectSet: ReadonlySet<string>;
}>;

type FileCollectionContext = Readonly<{
  readonly sf: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly options: PurityOptions;
  readonly effectSet: ReadonlySet<string>;
  readonly exportedDecls: ReadonlySet<ts.Node>;
  readonly exportedSyms: ReadonlySet<ts.Symbol>;
}>;

type CallInspectionResult = Readonly<{
  readonly reasons: ReadonlyArray<string>;
  readonly callDeps: ReadonlyArray<SymbolCallRef>;
  readonly hofInlineCallbacks: ReadonlyArray<HofInlineCallback>;
  readonly hofRefCallbacks: ReadonlyArray<HofRefCallback>;
}>;

type ReasonsMap = Readonly<Record<string, ReadonlyArray<string>>>;

type ProgramFunctionIndex = Readonly<{
  readonly recordByNode: ReadonlyMap<ts.Node, CollectedFunction>;
  readonly recordBySym: ReadonlyMap<ts.Symbol, CollectedFunction>;
}>;

type PropagationEnv = Readonly<{
  readonly index: ProgramFunctionIndex;
  readonly reasonsById: ReasonsMap;
}>;

type PropagationState = Readonly<
  Record<"remaining", number> & {
    readonly reasonsById: ReasonsMap;
  }
>;

const EMPTY_STRINGS: ReadonlyArray<string> = [];
const EMPTY_FUNCTIONS: ReadonlyArray<CollectedFunction> = [];

const fromStringEntries = <V>(entries: ReadonlyArray<readonly [string, V]>) =>
  Object.fromEntries(entries) satisfies Readonly<Record<string, V>>;

const hasNodeModulesSegment = (filePath: string) => filePath.includes("/node_modules/");
const hasTrailingSlash = (pattern: string) => pattern.endsWith("/");
const isMatchingSlashPrefix = (specifier: string, pattern: string) =>
  specifier === pattern || specifier.startsWith(`${pattern}/`);
const isMatchingExactPrefix = (specifier: string, pattern: string) =>
  specifier.startsWith(pattern);

const formatFnId = (filePath: string, offset: number) => `${filePath}@${String(offset)}`;
const formatDefaultMethodName = (propName: string) => `default.${propName}`;
const formatEffectReason = (name: string) => `returns ${name}`;
const formatObjectMutationReason = (methodName: string) => `mutates via Object.${methodName}()`;
const formatReflectMutationReason = (methodName: string) => `mutates via Reflect.${methodName}()`;
const formatCollectionMutationReason = (methodName: string) =>
  `calls mutating method .${methodName}()`;
const formatImpureModuleCallReason = (callee: string, modSpec: string) =>
  `calls '${callee}' from impure module '${modSpec}'`;
const formatImpureMemberModuleReason = (target: MemberCallTarget, modSpec: string) =>
  `calls '${target.objText}.${target.propName}' from impure module '${modSpec}'`;
const formatImpureGlobalReason = (callee: string) => `calls impure global ${callee}()`;
const formatConsoleCallReason = (prop: string) => `calls console.${prop}()`;
const formatImpureMemberCallReason = (target: MemberCallTarget) =>
  `calls ${target.objText}.${target.propName}()`;
const formatExternalEffectReason = (effectName: string) => `external call returns ${effectName}`;
const formatVoidExternalReason = (calleeName: string) =>
  `calls void external function '${calleeName}'`;
const formatProcessReadReason = (prop: string) => `reads process.${prop}`;
const formatDomGlobalReason = (ident: string) => `accesses DOM global '${ident}'`;
const formatMutableBindingReason = (ident: string) => `references mutable binding '${ident}'`;
const formatCallsImpureReason = (callee: string) => `calls impure '${callee}'`;
const formatInlineHofReason = (hofName: string) => `passes impure callback to '${hofName}'`;
const formatRefHofReason = (cbName: string, hofName: string) =>
  `passes impure callback '${cbName}' to '${hofName}'`;
const formatPurityCacheKey = (options: PurityOptions) =>
  [
    options.effectTypes.join(","),
    options.impureModules.join(","),
    options.pureModules.join(","),
  ].join("||");

const isMatchingSinglePattern = (specifier: string, pattern: string) =>
  hasTrailingSlash(pattern)
    ? isMatchingExactPrefix(specifier, pattern)
    : isMatchingSlashPrefix(specifier, pattern);

const isMatchingModulePattern = (specifier: string, patterns: ReadonlyArray<string>) =>
  RA.some((pattern: string) => isMatchingSinglePattern(specifier, pattern))(patterns);

const isImpureModuleSpecifier = (specifier: string, options: PurityOptions) =>
  !isMatchingModulePattern(specifier, options.pureModules) &&
  isMatchingModulePattern(specifier, options.impureModules);

const hasAsyncModifier = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  RA.some((m: ts.Modifier) => m.kind === ts.SyntaxKind.AsyncKeyword)(ts.getModifiers(node) ?? []);

const resolveTypeSymbolName = (type: ts.Type) =>
  O.fromNullable(type.aliasSymbol?.name ?? type.getSymbol()?.name);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive union effect check
const matchEffectType = (type: ts.Type, effectSet: ReadonlySet<string>): O.Option<string> =>
  type.isUnion()
    ? RA.findFirstMap((member: ts.Type) => matchEffectType(member, effectSet))(type.types)
    : O.filter((name: string) => effectSet.has(name))(resolveTypeSymbolName(type));

const hasVoidOrUndefinedFlag = (type: ts.Type) =>
  (type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0;

const isVoidOrUndefinedOnly = (type: ts.Type) =>
  hasVoidOrUndefinedFlag(type) ||
  (type.isUnion() && type.types.length > 0 && RA.every(hasVoidOrUndefinedFlag)(type.types));

const collectOwnBodyNodes = (node: ts.Node) => collectTsNodesUntil(node, ts.isFunctionLike);

const isComplexityIncrementNode = (node: ts.Node) =>
  BRANCHING_SYNTAX_KINDS.has(node.kind) ||
  (ts.isBinaryExpression(node) && SHORT_CIRCUIT_OPERATORS.has(node.operatorToken.kind));

const computeCyclomaticComplexity = (fn: ts.FunctionLikeDeclaration) =>
  fn.body
    ? 1 + RA.filter(isComplexityIncrementNode)(collectOwnBodyNodes(fn.body)).length
    : 1;

const ascendParent = (node: ts.Node) => node.parent;
const ascendGrandParent = (node: ts.ImportSpecifier) => node.parent.parent;

const resolveImportSpecifierParent = flow(ascendGrandParent, ascendParent, O.some);

const resolveImportDeclCandidate = (decl: ts.Declaration) =>
  match(decl)
    .when(ts.isImportSpecifier, resolveImportSpecifierParent)
    .when(ts.isImportClause, (d) => O.some(d.parent))
    .when(ts.isNamespaceImport, (d) => O.some(d.parent.parent))
    .otherwise(() => O.none);

const extractStringLiteralText = (expr: ts.Expression) =>
  ts.isStringLiteral(expr) ? O.some(expr.text) : O.none;

const extractImportDeclSpecifier = (node: ts.Node) =>
  ts.isImportDeclaration(node) ? extractStringLiteralText(node.moduleSpecifier) : O.none;

const resolveImportedDeclSpecifier = flow(
  resolveImportDeclCandidate,
  O.flatMap(extractImportDeclSpecifier),
);

const resolveImportedModuleSpecifier = (sym: ts.Symbol) =>
  RA.findFirstMap(resolveImportedDeclSpecifier)(sym.declarations ?? []);

const isNodeModulesPath = flow(normalizeFilePath, hasNodeModulesSegment);

const isProjectSourceFile = (sf: ts.SourceFile) =>
  sf.isDeclarationFile ? false : !isNodeModulesPath(sf.fileName);

const isDeclInProjectSource = flow(
  (decl: ts.Declaration) => decl.getSourceFile(),
  isProjectSourceFile,
);

const isDeclaredInProjectSource = (sym: ts.Symbol) =>
  RA.some(isDeclInProjectSource)(sym.declarations ?? []);

const isExternalSymbolOpt = (sym: O.Option<ts.Symbol>) =>
  !O.exists(isDeclaredInProjectSource)(sym);

const lookupNodeSymbol = (checker: ts.TypeChecker) =>
  flow((node: ts.Node) => checker.getSymbolAtLocation(node), O.fromNullable);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive ancestor walk
const isOutsideFunctionScope = (node: ts.Node, fnNode: ts.FunctionLikeDeclaration): boolean =>
  node === fnNode
    ? false
    : ts.isSourceFile(node) || isOutsideFunctionScope(node.parent, fnNode);

const isMutableVarDeclList = (parent: ts.Node) =>
  ts.isVariableDeclarationList(parent) && (parent.flags & ts.NodeFlags.Const) === 0;

const isNonConstProjectVarDecl = (decl: ts.Node): decl is ts.VariableDeclaration =>
  ts.isVariableDeclaration(decl) &&
  !decl.getSourceFile().isDeclarationFile &&
  isMutableVarDeclList(decl.parent);

const isMutableBindingOutsideFn = (
  fnNode: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
) =>
  flow(
    lookupNodeSymbol(checker),
    O.map((sym: ts.Symbol) => resolveCanonicalSymbol(sym, checker)),
    O.flatMap((canonical: ts.Symbol) => O.fromNullable(canonical.valueDeclaration)),
    O.filter(isNonConstProjectVarDecl),
    O.exists((decl: ts.VariableDeclaration) => isOutsideFunctionScope(decl.parent, fnNode)),
  );

const isMutableModuleLevelBinding = (
  ident: ts.Identifier,
  { fnNode, checker }: Readonly<{ fnNode: ts.FunctionLikeDeclaration; checker: ts.TypeChecker }>,
) => isMutableBindingOutsideFn(fnNode, checker)(ident);

const isMutableCollectionType = (objType: ts.Type, checker: ts.TypeChecker) =>
  checker.isArrayType(objType) ||
  checker.isTupleType(objType) ||
  O.exists((name: string) => MUTABLE_COLLECTION_TYPE_NAMES.has(name))(
    O.fromNullable(objType.getSymbol()?.name),
  );

const matchStaticMutatingMethod = (objExpr: ts.Expression, methodName: string) =>
  ts.isIdentifier(objExpr)
    ? match(objExpr.text)
        .when(
          (name) => OBJECT_GLOBAL_NAMES.has(name) && MUTATING_OBJECT_STATIC_METHODS.has(methodName),
          () => O.some(formatObjectMutationReason(methodName)),
        )
        .when(
          (name) =>
            REFLECT_GLOBAL_NAMES.has(name) && MUTATING_REFLECT_STATIC_METHODS.has(methodName),
          () => O.some(formatReflectMutationReason(methodName)),
        )
        .otherwise(() => O.none)
    : O.none;

const matchCollectionMutatingMethod = (
  propAccess: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
) =>
  MUTATING_ARRAY_OR_COLLECTION_METHODS.has(propAccess.name.text) &&
  isMutableCollectionType(checker.getTypeAtLocation(propAccess.expression), checker)
    ? O.some(formatCollectionMutationReason(propAccess.name.text))
    : O.none;

const inspectPropertyCallMutation = (
  propAccess: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
) =>
  O.alt(() => matchCollectionMutatingMethod(propAccess, checker))(
    matchStaticMutatingMethod(propAccess.expression, propAccess.name.text),
  );

const matchCalleeMutableMethod = (call: ts.CallExpression, checker: ts.TypeChecker) =>
  ts.isPropertyAccessExpression(call.expression)
    ? inspectPropertyCallMutation(call.expression, checker)
    : O.none;

const filterImpureModuleSpec = (options: PurityOptions) =>
  flow(
    O.flatMap(resolveImportedModuleSpecifier),
    O.filter((spec: string) => isImpureModuleSpecifier(spec, options)),
  );

const matchImpureModuleImport = (sym: O.Option<ts.Symbol>) => (options: PurityOptions) =>
  filterImpureModuleSpec(options)(sym);

const matchImpureDirectCallReason = (calleeText: string, sym: O.Option<ts.Symbol>) =>
  flow(
    matchImpureModuleImport(sym),
    O.map((modSpec: string) => formatImpureModuleCallReason(calleeText, modSpec)),
  );

const inspectIdentifierRuntimeCall =
  (callee: ts.Identifier, checker: ts.TypeChecker) => (options: PurityOptions) => {
    const sym = O.fromNullable(checker.getSymbolAtLocation(callee));
    return O.alt(() =>
      IMPURE_DIRECT_GLOBALS.has(callee.text) && isExternalSymbolOpt(sym)
        ? O.some(formatImpureGlobalReason(callee.text))
        : O.none,
    )(matchImpureDirectCallReason(callee.text, sym)(options));
  };

const lookupImpureMemberSet = (objText: string) => RR.lookup(objText, IMPURE_MEMBER_CALLS);

const isImpureMemberMethod = flow(
  (target: MemberCallTarget) => ({
    propName: target.propName,
    setOpt: lookupImpureMemberSet(target.objText),
  }),
  ({ propName, setOpt }) => O.exists((set: ReadonlySet<string>) => set.has(propName))(setOpt),
);

const matchImpureBuiltinMemberCall = (target: MemberCallTarget, objSym: O.Option<ts.Symbol>) =>
  isExternalSymbolOpt(objSym)
    ? match(target)
        .with(
          { objText: P.when((name) => CONSOLE_GLOBAL_NAMES.has(name)) },
          flow((t: MemberCallTarget) => t.propName, formatConsoleCallReason, O.some),
        )
        .when(isImpureMemberMethod, flow(formatImpureMemberCallReason, O.some))
        .otherwise(() => O.none)
    : O.none;

const matchImpureMemberImportReason = (target: MemberCallTarget, objSym: O.Option<ts.Symbol>) =>
  flow(
    matchImpureModuleImport(objSym),
    O.map((modSpec: string) => formatImpureMemberModuleReason(target, modSpec)),
  );

const inspectIdentPropertyRuntimeCall =
  (checker: ts.TypeChecker) =>
  (objExpr: ts.Identifier, propName: string) =>
  (options: PurityOptions) => {
    const objSym = O.fromNullable(checker.getSymbolAtLocation(objExpr));
    const target: MemberCallTarget = { objText: objExpr.text, propName };
    return O.alt(() => matchImpureBuiltinMemberCall(target, objSym))(
      matchImpureMemberImportReason(target, objSym)(options),
    );
  };

const inspectPropertyRuntimeCall =
  (callee: ts.PropertyAccessExpression, checker: ts.TypeChecker) => (options: PurityOptions) =>
    ts.isIdentifier(callee.expression)
      ? inspectIdentPropertyRuntimeCall(checker)(callee.expression, callee.name.text)(options)
      : O.none;

const resolveFunctionCalleeName = (callee: ts.Expression) =>
  match(callee)
    .when(ts.isIdentifier, (id) => O.some(id.text))
    .when(ts.isPropertyAccessExpression, (pa) => O.some(pa.name.text))
    .otherwise(() => O.none);

const lookupResolvedSignature = (checker: ts.TypeChecker) =>
  flow((call: ts.CallExpression) => checker.getResolvedSignature(call), O.fromNullable);

const isVoidReturnSignature = (checker: ts.TypeChecker) =>
  flow(
    lookupResolvedSignature(checker),
    O.map((sig: ts.Signature) => checker.getReturnTypeOfSignature(sig)),
    O.exists((retType: ts.Type) => (retType.flags & ts.TypeFlags.Void) !== 0),
  );

const isVoidSignatureCall = (call: ts.CallExpression, checker: ts.TypeChecker) =>
  isVoidReturnSignature(checker)(call);

type VoidCallCheckEnv = Readonly<{
  callType: ts.Type;
  checker: ts.TypeChecker;
}>;

const matchVoidCallName = (call: ts.CallExpression, { callType, checker }: VoidCallCheckEnv) =>
  flow(
    resolveFunctionCalleeName,
    O.filter((name: string) => !POLYMORPHIC_HOF_NAMES.has(name)),
    O.filter(() => isVoidOrUndefinedOnly(callType) && isVoidSignatureCall(call, checker)),
    O.map(formatVoidExternalReason),
  );

const matchExternalVoidCall = (call: ts.CallExpression, env: VoidCallCheckEnv) =>
  matchVoidCallName(call, env)(call.expression);

const matchExternalEffectReason = (callType: ts.Type, effectSet: ReadonlySet<string>) =>
  O.map(formatExternalEffectReason)(matchEffectType(callType, effectSet));

type CheckerEffectEnv = Readonly<{
  checker: ts.TypeChecker;
  effectSet: ReadonlySet<string>;
}>;

const inspectExternalCallReturn = (
  call: ts.CallExpression,
  { checker, effectSet }: CheckerEffectEnv,
) => {
  const callType = checker.getTypeAtLocation(call);
  return O.alt(() => matchExternalVoidCall(call, { callType, checker }))(
    matchExternalEffectReason(callType, effectSet),
  );
};

const isExternalCanonicalCallee = (canonicalCallee: O.Option<ts.Symbol>) =>
  !O.exists(isDeclaredInProjectSource)(canonicalCallee);

const matchDirectRuntimeCall =
  (callee: ts.Expression, checker: ts.TypeChecker) => (options: PurityOptions) =>
    match(callee)
      .when(ts.isIdentifier, (id) => inspectIdentifierRuntimeCall(id, checker)(options))
      .when(ts.isPropertyAccessExpression, (pa) =>
        inspectPropertyRuntimeCall(pa, checker)(options),
      )
      .otherwise(() => O.none);

const matchImpureRuntimeCall =
  (env: CheckerEffectEnv) =>
  (call: ts.CallExpression, canonicalCallee: O.Option<ts.Symbol>) =>
    flow(
      matchDirectRuntimeCall(call.expression, env.checker),
      O.alt(() =>
        isExternalCanonicalCallee(canonicalCallee)
          ? inspectExternalCallReturn(call, env)
          : O.none,
      ),
    );

const isFunctionExprNode = (node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node);

const isProjectOrPolyHofCall = (
  calleeName: O.Option<string>,
  canonicalCallee: O.Option<ts.Symbol>,
) =>
  O.exists((name: string) => POLYMORPHIC_HOF_NAMES.has(name))(calleeName) ||
  O.exists(isDeclaredInProjectSource)(canonicalCallee);

const extractInlineHofArg = (arg: ts.Expression, hofName: string) => {
  const unwrapped = unwrapExpression(arg);
  return isFunctionExprNode(unwrapped)
    ? O.some<HofInlineCallback>({ fn: unwrapped, hofName })
    : O.none;
};

const resolveCallbackSymRef =
  (checker: ts.TypeChecker) => (callbackName: string, hofName: string) =>
    flow(
      lookupNodeSymbol(checker),
      O.map((sym: ts.Symbol) => resolveCanonicalSymbol(sym, checker)),
      O.filter(isDeclaredInProjectSource),
      O.map((targetSym: ts.Symbol) => ({ targetSym, callbackName, hofName })),
    );

const extractRefHofArg = (checker: ts.TypeChecker) => (arg: ts.Expression, hofName: string) => {
  const unwrapped = unwrapExpression(arg);
  return O.flatMap((callbackName: string) =>
    resolveCallbackSymRef(checker)(callbackName, hofName)(unwrapped),
  )(resolveFunctionCalleeName(unwrapped));
};

const extractProjectCallDeps = (label: string) =>
  flow(
    O.filter(isDeclaredInProjectSource),
    O.map(
      (targetSym: ts.Symbol) => [{ targetSym, calleeText: label }] satisfies ReadonlyArray<SymbolCallRef>,
    ),
    O.getOrElseW(() => []),
  );

const extractCallDeps = (canonicalCallee: O.Option<ts.Symbol>, label: string) =>
  extractProjectCallDeps(label)(canonicalCallee);

const collectCallHofArgs = (
  call: ts.CallExpression,
  {
    label,
    checker,
    hofMode,
  }: Readonly<
    Record<"label", string> & {
      readonly checker: ts.TypeChecker;
      readonly hofMode: "track" | "skip";
    }
  >,
) =>
  hofMode === "track"
    ? {
        hofInlineCallbacks: RA.filterMap((arg: ts.Expression) => extractInlineHofArg(arg, label))(
          call.arguments,
        ),
        hofRefCallbacks: RA.filterMap((arg: ts.Expression) =>
          extractRefHofArg(checker)(arg, label),
        )(call.arguments),
      }
    : {
        hofInlineCallbacks: [] satisfies ReadonlyArray<HofInlineCallback>,
        hofRefCallbacks: [] satisfies ReadonlyArray<HofRefCallback>,
      };

const resolveCanonicalCallee = (expr: ts.Expression, checker: ts.TypeChecker) =>
  O.map((sym: ts.Symbol) => resolveCanonicalSymbol(sym, checker))(lookupNodeSymbol(checker)(expr));

type CallInspectionEnv = CheckerEffectEnv & Readonly<{ options: PurityOptions }>;

const inspectCallDirectReasons =
  (env: CallInspectionEnv) =>
  (call: ts.CallExpression, canonicalCallee: O.Option<ts.Symbol>) =>
    RA.compact([
      matchCalleeMutableMethod(call, env.checker),
      matchImpureRuntimeCall(env)(call, canonicalCallee)(env.options),
    ]);

const inspectCallExpressionNode = (call: ts.CallExpression, env: CallInspectionEnv) => {
  const calleeName = resolveFunctionCalleeName(call.expression);
  const label = O.getOrElse(() => "anonymous")(calleeName);
  const canonicalCallee = resolveCanonicalCallee(call.expression, env.checker);
  return {
    reasons: inspectCallDirectReasons(env)(call, canonicalCallee),
    callDeps: extractCallDeps(canonicalCallee, label),
    ...collectCallHofArgs(call, {
      label,
      checker: env.checker,
      hofMode: isProjectOrPolyHofCall(calleeName, canonicalCallee) ? "track" : "skip",
    }),
  } satisfies CallInspectionResult;
};

const isIncrementUnaryExpr = (node: ts.Node) =>
  (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
  INCREMENT_OPERATORS.has(node.operator);

const isZeroArgNewDate = (node: ts.NewExpression) =>
  ts.isIdentifier(node.expression) &&
  DATE_GLOBAL_NAMES.has(node.expression.text) &&
  (node.arguments?.length ?? 0) === 0;

const isExternalNodeSymbol = (node: ts.Node, checker: ts.TypeChecker) =>
  isExternalSymbolOpt(lookupNodeSymbol(checker)(node));

const inspectProcessPropAccess = (
  node: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
) =>
  ts.isIdentifier(node.expression) &&
  PROCESS_GLOBAL_NAMES.has(node.expression.text) &&
  IMPURE_PROCESS_PROPS.has(node.name.text) &&
  isExternalNodeSymbol(node.expression, checker)
    ? O.some(formatProcessReadReason(node.name.text))
    : O.none;

const isIdentifierPropertyOrTypeKey = (node: ts.Identifier, parent: ts.Node) =>
  (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
  (ts.isPropertyAssignment(parent) && parent.name === node) ||
  ts.isTypeNode(parent) ||
  ts.isTypeReferenceNode(parent);

const matchDomGlobalReason = (node: ts.Identifier, checker: ts.TypeChecker) =>
  DOM_IMPURE_GLOBALS.has(node.text) && isExternalNodeSymbol(node, checker)
    ? O.some(formatDomGlobalReason(node.text))
    : O.none;

const inspectValueIdentifierReason =
  (node: ts.Identifier, checker: ts.TypeChecker) => (fn: ts.FunctionLikeDeclaration) =>
    O.alt(() => matchDomGlobalReason(node, checker))(
      isMutableModuleLevelBinding(node, { fnNode: fn, checker })
        ? O.some(formatMutableBindingReason(node.text))
        : O.none,
    );

const inspectIdentifierNode =
  (node: ts.Identifier, checker: ts.TypeChecker) => (fn: ts.FunctionLikeDeclaration) =>
    isIdentifierPropertyOrTypeKey(node, node.parent)
      ? O.none
      : inspectValueIdentifierReason(node, checker)(fn);

const isAssignmentBinaryExpr = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind);

const inspectNonCallBodyNode =
  (node: ts.Node, checker: ts.TypeChecker) => (fn: ts.FunctionLikeDeclaration) =>
    match(node)
      .when(ts.isThrowStatement, () => O.some("throws exception"))
      .when(isAssignmentBinaryExpr, () => O.some("mutates via assignment"))
      .when(isIncrementUnaryExpr, () => O.some("mutates via ++/--"))
      .when(ts.isDeleteExpression, () => O.some("mutates via delete"))
      .when(ts.isNewExpression, (n) =>
        isZeroArgNewDate(n) ? O.some("calls non-deterministic new Date()") : O.none,
      )
      .when(ts.isPropertyAccessExpression, (n) => inspectProcessPropAccess(n, checker))
      .when(ts.isIdentifier, (n) => inspectIdentifierNode(n, checker)(fn))
      .otherwise(() => O.none);

const matchSignatureEffectReason = (retType: ts.Type, effectSet: ReadonlySet<string>) =>
  O.map(formatEffectReason)(matchEffectType(retType, effectSet));

const inspectReturnTypeReason = (retType: ts.Type, effectSet: ReadonlySet<string>) =>
  O.alt(() => (isVoidOrUndefinedOnly(retType) ? O.some("returns void/undefined") : O.none))(
    matchSignatureEffectReason(retType, effectSet),
  );

const lookupFnSignature = (checker: ts.TypeChecker) =>
  flow((fn: ts.FunctionLikeDeclaration) => checker.getSignatureFromDeclaration(fn), O.fromNullable);

const inspectFnReturnType = (checker: ts.TypeChecker, effectSet: ReadonlySet<string>) =>
  flow(
    lookupFnSignature(checker),
    O.map((sig: ts.Signature) => checker.getReturnTypeOfSignature(sig)),
    O.flatMap((retType: ts.Type) => inspectReturnTypeReason(retType, effectSet)),
  );

const inspectSignatureReturnReason = (
  fn: ts.FunctionLikeDeclaration,
  { checker, effectSet }: CheckerEffectEnv,
) => inspectFnReturnType(checker, effectSet)(fn);

const inspectSignatureReasons = (
  fn: ts.FunctionLikeDeclaration,
  env: CheckerEffectEnv,
) =>
  RA.compact([
    hasAsyncModifier(fn) ? O.some("async function") : O.none,
    inspectSignatureReturnReason(fn, env),
  ]);

const collectDirectReasons = (
  fn: ts.FunctionLikeDeclaration,
  {
    bodyNodes,
    callResults,
    ctx,
  }: Readonly<{
    bodyNodes: ReadonlyArray<ts.Node>;
    callResults: ReadonlyArray<CallInspectionResult>;
    ctx: InspectionContext;
  }>,
) =>
  RA.uniq(S.Eq)([
    ...inspectSignatureReasons(fn, ctx),
    ...RA.filterMap((node: ts.Node) => inspectNonCallBodyNode(node, ctx.checker)(fn))(bodyNodes),
    ...RA.flatMap((r: CallInspectionResult) => r.reasons)(callResults),
  ]);

const inspectFunctionBody = (fn: ts.FunctionLikeDeclaration, ctx: InspectionContext) => {
  const bodyNodes = fn.body ? collectOwnBodyNodes(fn.body) : [];
  const callResults = RA.map((call: ts.CallExpression) =>
    inspectCallExpressionNode(call, {
      checker: ctx.checker,
      effectSet: ctx.effectSet,
      options: ctx.options,
    }),
  )(RA.filter(ts.isCallExpression)(bodyNodes));
  return {
    directReasons: collectDirectReasons(fn, { bodyNodes, callResults, ctx }),
    callDeps: RA.flatMap((r: CallInspectionResult) => r.callDeps)(callResults),
    hofInlineCallbacks: RA.flatMap((r: CallInspectionResult) => r.hofInlineCallbacks)(callResults),
    hofRefCallbacks: RA.flatMap((r: CallInspectionResult) => r.hofRefCallbacks)(callResults),
    complexity: computeCyclomaticComplexity(fn),
  };
};

const extractPropertyNameText = (name: ts.PropertyName) =>
  match(name)
    .when(ts.isIdentifier, (id) => O.some(id.text))
    .when(ts.isStringLiteral, (lit) => O.some(lit.text))
    .with(P._, () => O.none)
    .exhaustive();

const buildFunctionHeader = (reg: FunctionRegistration, sf: ts.SourceFile) => {
  const filePath = normalizeFilePath(sf.fileName);
  const loc = resolveTsNodeLocation(reg.placement.reportNode, sf);
  return {
    id: formatFnId(filePath, reg.fn.getStart(sf)),
    name: reg.name,
    filePath,
    line: loc.line,
    locationKey: makeLocationKey(loc),
  };
};

const buildCollectedFunction = (reg: FunctionRegistration, ctx: InspectionContext) =>
  ({
    ...buildFunctionHeader(reg, ctx.sf),
    node: reg.fn,
    placement: reg.placement,
    symbol: reg.symbol,
    ...inspectFunctionBody(reg.fn, ctx),
  }) satisfies CollectedFunction;

const toInspectionContext = (fileCtx: FileCollectionContext) =>
  ({
    sf: fileCtx.sf,
    checker: fileCtx.checker,
    options: fileCtx.options,
    effectSet: fileCtx.effectSet,
  }) satisfies InspectionContext;

const registerWithChildren =
  (reg: FunctionRegistration, body: ts.Node) => (fileCtx: FileCollectionContext) => [
    buildCollectedFunction(reg, toInspectionContext(fileCtx)),
    ...collectChildrenAtScope(body, "nested")(fileCtx),
  ];

const isSymbolExported = (sym: O.Option<ts.Symbol>, fileCtx: FileCollectionContext) =>
  O.exists((canonical: ts.Symbol) => fileCtx.exportedSyms.has(canonical))(
    O.map((s: ts.Symbol) => resolveCanonicalSymbol(s, fileCtx.checker))(sym),
  );

const resolveTopLevelVisibility =
  (
    reportNode: ts.Node,
    { sym, nesting }: Readonly<{ sym: O.Option<ts.Symbol>; nesting: ScopeLevel }>,
  ) =>
  (fileCtx: FileCollectionContext) =>
    nesting === "top-level" &&
    (fileCtx.exportedDecls.has(reportNode) || isSymbolExported(sym, fileCtx))
      ? ("exported" as const)
      : ("internal" as const);

const collectDirectTsChildren = (node: ts.Node) => {
  // eslint-disable-next-line strict-fp/prefer-readonly-collections -- local accumulator for direct ts.forEachChild collection
  const children: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    // eslint-disable-next-line strict-fp/no-mutation, strict-fp/prefer-fp-ts-array-methods -- O(k) direct child collection
    children.push(child);
  });
  return children;
};

const collectChildrenForContext = (
  { parent, nesting }: Readonly<{ parent: ts.Node; nesting: ScopeLevel }>,
  fileCtx: FileCollectionContext,
) =>
  RA.flatMap((child: ts.Node) => collectNodeFunctions(child, nesting)(fileCtx))(
    collectDirectTsChildren(parent),
  );

const collectChildrenAtScope =
  (parent: ts.Node, nesting: ScopeLevel) => (fileCtx: FileCollectionContext) =>
    collectChildrenForContext({ parent, nesting }, fileCtx);

const resolveFunctionDeclSymbol = (node: ts.FunctionDeclaration, checker: ts.TypeChecker) =>
  node.name
    ? O.fromNullable(checker.getSymbolAtLocation(node.name))
    : O.fromNullable(checker.getSymbolAtLocation(node));

const buildDeclPlacement = (
  {
    reportNode,
    sym,
    nesting,
  }: Readonly<{ reportNode: ts.Node; sym: O.Option<ts.Symbol>; nesting: ScopeLevel }>,
  fileCtx: FileCollectionContext,
) =>
  ({
    reportNode,
    exportStatus: resolveTopLevelVisibility(reportNode, { sym, nesting })(fileCtx),
    nesting,
  }) satisfies FunctionPlacement;

const collectFunctionDeclWithBody =
  (
    node: ts.FunctionDeclaration,
    { body, nesting }: Readonly<{ body: ts.Block; nesting: ScopeLevel }>,
  ) =>
  (fileCtx: FileCollectionContext) => {
    const sym = resolveFunctionDeclSymbol(node, fileCtx.checker);
    return registerWithChildren(
      {
        fn: node,
        name: node.name?.text ?? "default",
        symbol: sym,
        placement: buildDeclPlacement({ reportNode: node, sym, nesting }, fileCtx),
      },
      body,
    )(fileCtx);
  };

const collectFunctionDecl =
  (node: ts.FunctionDeclaration, nesting: ScopeLevel) => (fileCtx: FileCollectionContext) =>
    node.body
      ? collectFunctionDeclWithBody(node, { body: node.body, nesting })(fileCtx)
      : EMPTY_FUNCTIONS;

type IdentDeclTarget = Readonly<{
  readonly node: ts.VariableDeclaration;
  readonly identName: ts.Identifier;
  readonly nesting: ScopeLevel;
}>;

const collectVariableFnDecl =
  (target: IdentDeclTarget, fnExpr: ts.ArrowFunction | ts.FunctionExpression) =>
  (fileCtx: FileCollectionContext) => {
    const sym = O.fromNullable(fileCtx.checker.getSymbolAtLocation(target.identName));
    return registerWithChildren(
      {
        fn: fnExpr,
        name: target.identName.text,
        symbol: sym,
        placement: buildDeclPlacement({ reportNode: target.node, sym, nesting: target.nesting }, fileCtx),
      },
      fnExpr.body,
    )(fileCtx);
  };

const extractInitializerFnExpr = flow(O.map(unwrapExpression), O.filter(isFunctionExprNode));

const dispatchIdentVarInitializer = (target: IdentDeclTarget, fileCtx: FileCollectionContext) =>
  flow(
    extractInitializerFnExpr,
    O.match(
      () => collectChildrenAtScope(target.node, target.nesting)(fileCtx),
      (fnExpr: ts.ArrowFunction | ts.FunctionExpression) =>
        collectVariableFnDecl(target, fnExpr)(fileCtx),
    ),
  );

const dispatchIdentVariableDecl = (target: IdentDeclTarget, fileCtx: FileCollectionContext) =>
  dispatchIdentVarInitializer(target, fileCtx)(O.fromNullable(target.node.initializer));

const collectIdentVariableDecl = (target: IdentDeclTarget) => (fileCtx: FileCollectionContext) =>
  dispatchIdentVariableDecl(target, fileCtx);

const collectVariableDeclarationNode =
  (node: ts.VariableDeclaration, nesting: ScopeLevel) => (fileCtx: FileCollectionContext) =>
    ts.isIdentifier(node.name)
      ? collectIdentVariableDecl({ node, identName: node.name, nesting })(fileCtx)
      : collectChildrenAtScope(node, nesting)(fileCtx);

const collectMethodDeclWithBody =
  (
    node: ts.MethodDeclaration,
    { body, nesting }: Readonly<{ body: ts.Block; nesting: ScopeLevel }>,
  ) =>
  (fileCtx: FileCollectionContext) =>
    registerWithChildren(
      {
        fn: node,
        name: O.getOrElse(() => "method")(extractPropertyNameText(node.name)),
        symbol: O.fromNullable(fileCtx.checker.getSymbolAtLocation(node.name)),
        placement: {
          reportNode: node,
          exportStatus: fileCtx.exportedDecls.has(node) ? "exported" : "internal",
          nesting:
            nesting === "nested" && !fileCtx.exportedDecls.has(node) ? "nested" : "top-level",
        },
      },
      body,
    )(fileCtx);

const collectMethodDeclNode =
  (node: ts.MethodDeclaration, nesting: ScopeLevel) => (fileCtx: FileCollectionContext) =>
    node.body
      ? collectMethodDeclWithBody(node, { body: node.body, nesting })(fileCtx)
      : collectChildrenAtScope(node, nesting)(fileCtx);

const registerDefaultBagFnProp =
  (
    prop: ts.PropertyAssignment,
    {
      propName,
      propInit,
    }: Readonly<
      Record<"propName", string> & {
        readonly propInit: ts.ArrowFunction | ts.FunctionExpression;
      }
    >,
  ) =>
  (fileCtx: FileCollectionContext) =>
    registerWithChildren(
      {
        fn: propInit,
        name: formatDefaultMethodName(propName),
        symbol: O.fromNullable(fileCtx.checker.getSymbolAtLocation(prop.name)),
        placement: {
          reportNode: prop,
          exportStatus: "exported",
          nesting: "top-level",
        },
      },
      propInit.body,
    )(fileCtx);

const dispatchNamedBagFnProp =
  (fileCtx: FileCollectionContext) =>
  (prop: ts.PropertyAssignment, propInit: ts.ArrowFunction | ts.FunctionExpression) =>
    O.map((propName: string) =>
      registerDefaultBagFnProp(prop, { propName, propInit })(fileCtx),
    )(extractPropertyNameText(prop.name));

const dispatchBagPropInitializer = (
  prop: ts.PropertyAssignment,
  fileCtx: FileCollectionContext,
) =>
  flow(
    extractInitializerFnExpr,
    O.flatMap((propInit: ts.ArrowFunction | ts.FunctionExpression) =>
      dispatchNamedBagFnProp(fileCtx)(prop, propInit),
    ),
    O.getOrElse(() => EMPTY_FUNCTIONS),
  );

const dispatchDefaultBagPropertyAssignment = (
  prop: ts.PropertyAssignment,
  fileCtx: FileCollectionContext,
) => dispatchBagPropInitializer(prop, fileCtx)(O.some(prop.initializer));

const collectDefaultBagPropertyAssignment =
  (prop: ts.PropertyAssignment) => (fileCtx: FileCollectionContext) =>
    dispatchDefaultBagPropertyAssignment(prop, fileCtx);

const collectDefaultBagProp =
  (prop: ts.ObjectLiteralElementLike) => (fileCtx: FileCollectionContext) =>
    match(prop)
      .when(ts.isPropertyAssignment, (p) => collectDefaultBagPropertyAssignment(p)(fileCtx))
      .when(ts.isMethodDeclaration, (p) =>
        p.body
          ? collectMethodDeclWithBody(p, { body: p.body, nesting: "top-level" })(fileCtx)
          : EMPTY_FUNCTIONS,
      )
      .with(P._, () => EMPTY_FUNCTIONS)
      .exhaustive();

const isMultiPropObjectLiteral = (node: ts.Node): node is ts.ObjectLiteralExpression =>
  ts.isObjectLiteralExpression(node) && node.properties.length >= 2;

const registerDefaultFnExport =
  (node: ts.ExportAssignment, fnExpr: ts.ArrowFunction | ts.FunctionExpression) =>
  (fileCtx: FileCollectionContext) =>
    registerWithChildren(
      {
        fn: fnExpr,
        name: "default",
        symbol: O.fromNullable(fileCtx.checker.getSymbolAtLocation(node)),
        placement: {
          reportNode: node,
          exportStatus: "exported",
          nesting: "top-level",
        },
      },
      fnExpr.body,
    )(fileCtx);

const collectDefaultExportAssignment =
  (node: ts.ExportAssignment, nesting: ScopeLevel) => (fileCtx: FileCollectionContext) =>
    match(unwrapExpression(node.expression))
      .when(isFunctionExprNode, (fnExpr) => registerDefaultFnExport(node, fnExpr)(fileCtx))
      .when(isMultiPropObjectLiteral, (obj) =>
        RA.flatMap((prop: ts.ObjectLiteralElementLike) => collectDefaultBagProp(prop)(fileCtx))(
          obj.properties,
        ),
      )
      .otherwise(() => collectChildrenAtScope(node, nesting)(fileCtx));

const collectInlineFunctionExpr = (node: ts.ArrowFunction | ts.FunctionExpression) =>
  registerWithChildren(
    {
      fn: node,
      name: "<inline>",
      symbol: O.none,
      placement: {
        reportNode: node,
        exportStatus: "internal",
        nesting: "nested",
      },
    },
    node.body,
  );

const collectNodeFunctions =
  (node: ts.Node, nesting: ScopeLevel) =>
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST function collection
  (fileCtx: FileCollectionContext): ReadonlyArray<CollectedFunction> =>
    ts.isJSDoc(node)
      ? EMPTY_FUNCTIONS
      : match(node)
          .when(ts.isFunctionDeclaration, (n) => collectFunctionDecl(n, nesting)(fileCtx))
          .when(ts.isVariableDeclaration, (n) => collectVariableDeclarationNode(n, nesting)(fileCtx))
          .when(ts.isMethodDeclaration, (n) => collectMethodDeclNode(n, nesting)(fileCtx))
          .when(ts.isExportAssignment, (n) =>
            n.isExportEquals
              ? collectChildrenAtScope(n, nesting)(fileCtx)
              : collectDefaultExportAssignment(n, nesting)(fileCtx),
          )
          .when(isFunctionExprNode, (n) => collectInlineFunctionExpr(n)(fileCtx))
          .otherwise((n) => collectChildrenAtScope(n, nesting)(fileCtx));

const collectStatementsWithContext =
  (statements: ReadonlyArray<ts.Statement>) => (fileCtx: FileCollectionContext) =>
    RA.flatMap((stmt: ts.Statement) => collectNodeFunctions(stmt, "top-level")(fileCtx))(
      statements,
    );

const collectFileFunctions = (
  sf: ts.SourceFile,
  { checker, options, effectSet }: CallInspectionEnv,
) => {
  const runtimeExports = extractFileRuntimeExports(sf, checker);
  return collectStatementsWithContext(sf.statements)({
    sf,
    checker,
    options,
    effectSet,
    exportedDecls: new Set(
      RA.map((e: (typeof runtimeExports)[number]) => e.declaration)(runtimeExports),
    ),
    exportedSyms: new Set(
      RA.filterMap((e: (typeof runtimeExports)[number]) => e.symbol)(runtimeExports),
    ),
  });
};

const hasImpureReasonsForTarget = (target: O.Option<CollectedFunction>, reasonsById: ReasonsMap) =>
  O.exists((rec: CollectedFunction) => (reasonsById[rec.id]?.length ?? 0) > 0)(target);

const lookupRecordBySym = (index: ProgramFunctionIndex, targetSym: ts.Symbol) =>
  O.fromNullable(index.recordBySym.get(targetSym));

const lookupRecordByNode = (index: ProgramFunctionIndex, targetNode: ts.Node) =>
  O.fromNullable(index.recordByNode.get(targetNode));

const isSymTargetImpure = (targetSym: ts.Symbol, propEnv: PropagationEnv) =>
  hasImpureReasonsForTarget(lookupRecordBySym(propEnv.index, targetSym), propEnv.reasonsById);

const isNodeTargetImpure = (targetNode: ts.Node, propEnv: PropagationEnv) =>
  hasImpureReasonsForTarget(lookupRecordByNode(propEnv.index, targetNode), propEnv.reasonsById);

const collectPropagatedCallReasons = (rec: CollectedFunction) => (env: PropagationEnv) =>
  RA.filterMap((dep: SymbolCallRef) =>
    isSymTargetImpure(dep.targetSym, env) ? O.some(formatCallsImpureReason(dep.calleeText)) : O.none,
  )(rec.callDeps);

const collectPropagatedInlineHofReasons = (rec: CollectedFunction) => (env: PropagationEnv) =>
  RA.filterMap((hof: HofInlineCallback) =>
    isNodeTargetImpure(hof.fn, env) ? O.some(formatInlineHofReason(hof.hofName)) : O.none,
  )(rec.hofInlineCallbacks);

const collectPropagatedRefHofReasons = (rec: CollectedFunction) => (env: PropagationEnv) =>
  RA.filterMap((hof: HofRefCallback) =>
    isSymTargetImpure(hof.targetSym, env)
      ? O.some(formatRefHofReason(hof.callbackName, hof.hofName))
      : O.none,
  )(rec.hofRefCallbacks);

const mergeRecordReasons = (rec: CollectedFunction) => (env: PropagationEnv) =>
  RA.uniq(S.Eq)([
    ...(env.reasonsById[rec.id] ?? EMPTY_STRINGS),
    ...collectPropagatedCallReasons(rec)(env),
    ...collectPropagatedInlineHofReasons(rec)(env),
    ...collectPropagatedRefHofReasons(rec)(env),
  ]);

const countReasonList = flow(
  O.map((rs: ReadonlyArray<string>) => rs.length),
  O.getOrElse(() => 0),
);

const countCurrentReasons = (reasonsById: ReasonsMap, id: string) =>
  countReasonList(RR.lookup(id, reasonsById));

const evaluateRecordPropagation = (rec: CollectedFunction) => (env: PropagationEnv) => {
  const next = mergeRecordReasons(rec)(env);
  return {
    entry: [rec.id, next] as const,
    change:
      next.length > countCurrentReasons(env.reasonsById, rec.id)
        ? ("changed" as const)
        : ("stable" as const),
  };
};

const runPropagationPass =
  (records: ReadonlyArray<CollectedFunction>) => (env: PropagationEnv) => {
    const updated = RA.map((rec: CollectedFunction) => evaluateRecordPropagation(rec)(env))(
      records,
    );
    return {
      nextReasons: fromStringEntries(RA.map((u: (typeof updated)[number]) => u.entry)(updated)),
      status: RA.some((u: (typeof updated)[number]) => u.change === "changed")(updated)
        ? ("changed" as const)
        : ("stable" as const),
    };
  };

const propagateImpurityFixedPoint =
  (records: ReadonlyArray<CollectedFunction>, index: ProgramFunctionIndex) =>
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive fixed-point propagation
  (state: PropagationState): ReasonsMap =>
    state.remaining <= 0
      ? state.reasonsById
      : match(runPropagationPass(records)({ index, reasonsById: state.reasonsById }))
          .with({ status: "stable" }, ({ nextReasons }) => nextReasons)
          .with({ status: "changed" }, ({ nextReasons }) =>
            propagateImpurityFixedPoint(records, index)({
              remaining: state.remaining - 1,
              reasonsById: nextReasons,
            }),
          )
          .exhaustive();

const buildProgramFunctionIndex = (
  allRecords: ReadonlyArray<CollectedFunction>,
  checker: ts.TypeChecker,
) =>
  ({
    recordByNode: new Map<ts.Node, CollectedFunction>(
      RA.map((rec: CollectedFunction) => [rec.node, rec] as const)(allRecords),
    ),
    recordBySym: new Map(
      RA.filterMap((rec: CollectedFunction) =>
        O.map((sym: ts.Symbol) => [resolveCanonicalSymbol(sym, checker), rec] as const)(rec.symbol),
      )(allRecords),
    ),
  }) satisfies ProgramFunctionIndex;

const buildPurityRecordIdentity = (rec: CollectedFunction) => ({
  id: rec.id,
  name: rec.name,
  fileName: rec.filePath,
  line: rec.line,
  locationKey: rec.locationKey,
  node: rec.node,
  reportNode: rec.placement.reportNode,
  isExported: rec.placement.exportStatus === "exported",
  isNested: rec.placement.nesting === "nested",
  complexity: rec.complexity,
});

const toFunctionPurityRecord = (reasonsById: ReasonsMap) => (rec: CollectedFunction) => {
  const reasons = RA.sort(S.Ord)(reasonsById[rec.id] ?? EMPTY_STRINGS);
  return {
    ...buildPurityRecordIdentity(rec),
    purity: reasons.length > 0 ? ("impure" as const) : ("pure" as const),
    reasons,
  } satisfies FunctionPurityRecord;
};

const classifyModulePurity = (
  functions: ReadonlyArray<FunctionPurityRecord>,
  {
    pureExportedFunctions,
    impureExportedFunctions,
  }: Readonly<{
    pureExportedFunctions: ReadonlyArray<FunctionPurityRecord>;
    impureExportedFunctions: ReadonlyArray<FunctionPurityRecord>;
  }>,
) => {
  const topLevel = RA.filter((f: FunctionPurityRecord) => !f.isNested)(functions);
  return match({
    hasImpure:
      impureExportedFunctions.length > 0 ||
      RA.some((f: FunctionPurityRecord) => f.purity === "impure")(topLevel),
    hasPure:
      pureExportedFunctions.length > 0 ||
      RA.some((f: FunctionPurityRecord) => f.purity === "pure")(topLevel),
  })
    .with({ hasImpure: true }, () => "impure" as const)
    .with({ hasPure: true }, () => "pure" as const)
    .otherwise(() => "neutral" as const);
};

const indexExportPurityByName = flow(
  RA.map((expFn: FunctionPurityRecord) => [expFn.name, expFn.purity] as const),
  fromStringEntries,
);

const partitionExportedFunctions = (functions: ReadonlyArray<FunctionPurityRecord>) => {
  const exportedFunctions = RA.filter((f: FunctionPurityRecord) => f.isExported)(functions);
  return {
    exportedFunctions,
    pureExportedFunctions: RA.filter((f: FunctionPurityRecord) => f.purity === "pure")(
      exportedFunctions,
    ),
    impureExportedFunctions: RA.filter((f: FunctionPurityRecord) => f.purity === "impure")(
      exportedFunctions,
    ),
    exportPurityByName: indexExportPurityByName(exportedFunctions),
  };
};

const assembleFilePuritySummary = (
  sf: ts.SourceFile,
  functions: ReadonlyArray<FunctionPurityRecord>,
) => {
  const partitioned = partitionExportedFunctions(functions);
  return {
    fileName: normalizeFilePath(sf.fileName),
    isBarrel: isBarrelFile(sf),
    modulePurity: classifyModulePurity(functions, partitioned),
    functions,
    ...partitioned,
  } satisfies FilePuritySummary;
};

const buildFilePuritySummary = (
  sf: ts.SourceFile,
  {
    recs,
    reasonsById,
  }: Readonly<{ recs: ReadonlyArray<CollectedFunction>; reasonsById: ReasonsMap }>,
) => assembleFilePuritySummary(sf, RA.map(toFunctionPurityRecord(reasonsById))(recs));

const collectFileRecordPair = (sf: ts.SourceFile, env: CallInspectionEnv) =>
  [
    normalizeFilePath(sf.fileName),
    isBarrelFile(sf) ? EMPTY_FUNCTIONS : collectFileFunctions(sf, env),
  ] as const;

const indexTopLevelFunctionsByLocation = flow(
  RA.flatMap((summary: FilePuritySummary) => summary.functions),
  RA.filterMap((f: FunctionPurityRecord) =>
    f.isNested ? O.none : O.some([f.locationKey, f] as const),
  ),
  fromStringEntries,
);

const buildInitialReasons = flow(
  RA.map((rec: CollectedFunction) => [rec.id, rec.directReasons] as const),
  fromStringEntries,
);

const assembleProgramPurity = (
  sourceFiles: ReadonlyArray<ts.SourceFile>,
  {
    recordsByFile,
    finalReasons,
  }: Readonly<{
    recordsByFile: Readonly<Record<string, ReadonlyArray<CollectedFunction>>>;
    finalReasons: ReasonsMap;
  }>,
) => {
  const summaries = RA.map((sf: ts.SourceFile) =>
    buildFilePuritySummary(sf, {
      recs: recordsByFile[normalizeFilePath(sf.fileName)] ?? EMPTY_FUNCTIONS,
      reasonsById: finalReasons,
    }),
  )(sourceFiles);
  return {
    files: fromStringEntries(
      RA.map((summary: FilePuritySummary) => [summary.fileName, summary] as const)(summaries),
    ),
    functionsByLocation: indexTopLevelFunctionsByLocation(summaries),
  } satisfies ProgramPurityAnalysis;
};

const resolveProgramFinalReasons = (
  allRecords: ReadonlyArray<CollectedFunction>,
  checker: ts.TypeChecker,
) =>
  propagateImpurityFixedPoint(allRecords, buildProgramFunctionIndex(allRecords, checker))({
    remaining: allRecords.length + 2,
    reasonsById: buildInitialReasons(allRecords),
  });

const flattenFilePairRecords = RA.flatMap(
  ([, recs]: readonly [string, ReadonlyArray<CollectedFunction>]) => recs,
);

const buildFinalProgramReasons = (
  filePairs: ReadonlyArray<readonly [string, ReadonlyArray<CollectedFunction>]>,
  checker: ts.TypeChecker,
) => resolveProgramFinalReasons(flattenFilePairRecords(filePairs), checker);

const computeProgramPurity = (program: ts.Program, options: PurityOptions) => {
  const checker = program.getTypeChecker();
  const sourceFiles = collectProjectSourceFiles(program);
  const filePairs = RA.map((sf: ts.SourceFile) =>
    collectFileRecordPair(sf, { checker, options, effectSet: new Set(options.effectTypes) }),
  )(sourceFiles);
  return assembleProgramPurity(sourceFiles, {
    recordsByFile: fromStringEntries(filePairs),
    finalReasons: buildFinalProgramReasons(filePairs, checker),
  });
};

const purityCache = new WeakMap<ts.Program, Readonly<Record<string, ProgramPurityAnalysis>>>();

export const analyzeProgramPurity = ((
  program: ts.Program,
  options: PurityOptions = DEFAULT_PURITY_OPTIONS,
) =>
  memoizeByProgramAndKey(purityCache, (p) => computeProgramPurity(p, options))(
    program,
    formatPurityCacheKey(options),
  )) satisfies (program: ts.Program, options?: PurityOptions) => ProgramPurityAnalysis;
