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

const EMPTY_STRINGS = [] as ReadonlyArray<string>;
const EMPTY_FUNCTIONS = [] as ReadonlyArray<CollectedFunction>;

const fromStringEntries = <V>(entries: ReadonlyArray<readonly [string, V]>) =>
  Object.fromEntries(entries) as Readonly<Record<string, V>>;

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

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST body walk
const collectOwnBodyNodes = (node: ts.Node, sf: ts.SourceFile): ReadonlyArray<ts.Node> =>
  ts.isFunctionLike(node) || ts.isJSDoc(node)
    ? []
    : [
        node,
        ...RA.flatMap((child: ts.Node) => collectOwnBodyNodes(child, sf))(node.getChildren(sf)),
      ];

const isComplexityIncrementNode = (node: ts.Node) =>
  BRANCHING_SYNTAX_KINDS.has(node.kind) ||
  (ts.isBinaryExpression(node) && SHORT_CIRCUIT_OPERATORS.has(node.operatorToken.kind));

const computeCyclomaticComplexity = (fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile) =>
  fn.body
    ? 1 + RA.filter(isComplexityIncrementNode)(collectOwnBodyNodes(fn.body, sf)).length
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

const isMutableModuleLevelBinding = (
  ident: ts.Identifier,
  fnNode: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
) =>
  flow(
    lookupNodeSymbol(checker),
    O.map((sym) => resolveCanonicalSymbol(sym, checker)),
    O.flatMap((canonical) => O.fromNullable(canonical.valueDeclaration)),
    O.filter(isNonConstProjectVarDecl),
    O.exists((decl) => isOutsideFunctionScope(decl.parent, fnNode)),
  )(ident);

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
  objExpr: ts.Expression,
  methodName: string,
  checker: ts.TypeChecker,
) =>
  MUTATING_ARRAY_OR_COLLECTION_METHODS.has(methodName) &&
  isMutableCollectionType(checker.getTypeAtLocation(objExpr), checker)
    ? O.some(formatCollectionMutationReason(methodName))
    : O.none;

const inspectPropertyCallMutation = (
  propAccess: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
) =>
  O.alt(() => matchCollectionMutatingMethod(propAccess.expression, propAccess.name.text, checker))(
    matchStaticMutatingMethod(propAccess.expression, propAccess.name.text),
  );

const matchCalleeMutableMethod = (call: ts.CallExpression, checker: ts.TypeChecker) =>
  ts.isPropertyAccessExpression(call.expression)
    ? inspectPropertyCallMutation(call.expression, checker)
    : O.none;

const matchImpureModuleImport = (sym: O.Option<ts.Symbol>) => (options: PurityOptions) =>
  flow(
    O.flatMap(resolveImportedModuleSpecifier),
    O.filter((spec) => isImpureModuleSpecifier(spec, options)),
  )(sym);

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

const lookupImpureMemberSet = (objText: string) =>
  O.fromNullable((IMPURE_MEMBER_CALLS as Readonly<Record<string, ReadonlySet<string>>>)[objText]);

const isImpureMemberMethod = (target: MemberCallTarget) =>
  flow(
    (t: MemberCallTarget) => lookupImpureMemberSet(t.objText),
    O.exists((set) => set.has(target.propName)),
  )(target);

const matchImpureBuiltinMemberCall = (target: MemberCallTarget, objSym: O.Option<ts.Symbol>) =>
  isExternalSymbolOpt(objSym)
    ? match(target.objText)
        .when(
          (name) => CONSOLE_GLOBAL_NAMES.has(name),
          () => O.some(formatConsoleCallReason(target.propName)),
        )
        .when(
          () => isImpureMemberMethod(target),
          () => O.some(formatImpureMemberCallReason(target)),
        )
        .otherwise(() => O.none)
    : O.none;

const matchImpureMemberImportReason = (target: MemberCallTarget, objSym: O.Option<ts.Symbol>) =>
  flow(
    matchImpureModuleImport(objSym),
    O.map((modSpec: string) => formatImpureMemberModuleReason(target, modSpec)),
  );

const inspectIdentPropertyRuntimeCall =
  (objExpr: ts.Identifier, propName: string, checker: ts.TypeChecker) =>
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
      ? inspectIdentPropertyRuntimeCall(callee.expression, callee.name.text, checker)(options)
      : O.none;

const resolveFunctionCalleeName = (callee: ts.Expression) =>
  match(callee)
    .when(ts.isIdentifier, (id) => O.some(id.text))
    .when(ts.isPropertyAccessExpression, (pa) => O.some(pa.name.text))
    .otherwise(() => O.none);

const lookupResolvedSignature = (checker: ts.TypeChecker) =>
  flow((call: ts.CallExpression) => checker.getResolvedSignature(call), O.fromNullable);

const isVoidSignatureCall = (call: ts.CallExpression, checker: ts.TypeChecker) =>
  flow(
    lookupResolvedSignature(checker),
    O.map((sig) => checker.getReturnTypeOfSignature(sig)),
    O.exists((retType) => (retType.flags & ts.TypeFlags.Void) !== 0),
  )(call);

const matchExternalVoidCall = (
  call: ts.CallExpression,
  callType: ts.Type,
  checker: ts.TypeChecker,
) =>
  flow(
    O.filter((name: string) => !POLYMORPHIC_HOF_NAMES.has(name)),
    O.filter(() => isVoidOrUndefinedOnly(callType) && isVoidSignatureCall(call, checker)),
    O.map(formatVoidExternalReason),
  )(resolveFunctionCalleeName(call.expression));

const matchExternalEffectReason = (callType: ts.Type, effectSet: ReadonlySet<string>) =>
  O.map(formatExternalEffectReason)(matchEffectType(callType, effectSet));

const inspectExternalCallReturn = (
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  effectSet: ReadonlySet<string>,
) => {
  const callType = checker.getTypeAtLocation(call);
  return O.alt(() => matchExternalVoidCall(call, callType, checker))(
    matchExternalEffectReason(callType, effectSet),
  );
};

const isProjectCalleeExpr = (callee: ts.Expression, checker: ts.TypeChecker) =>
  flow(
    lookupNodeSymbol(checker),
    O.map((s) => resolveCanonicalSymbol(s, checker)),
    O.exists(isDeclaredInProjectSource),
  )(callee);

const isExternalCalleeExpr = (callee: ts.Expression, checker: ts.TypeChecker) =>
  !isProjectCalleeExpr(callee, checker);

const matchDirectRuntimeCall =
  (callee: ts.Expression, checker: ts.TypeChecker) => (options: PurityOptions) =>
    match(callee)
      .when(ts.isIdentifier, (id) => inspectIdentifierRuntimeCall(id, checker)(options))
      .when(ts.isPropertyAccessExpression, (pa) =>
        inspectPropertyRuntimeCall(pa, checker)(options),
      )
      .otherwise(() => O.none);

const matchImpureRuntimeCall = (
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  effectSet: ReadonlySet<string>,
) =>
  flow(
    matchDirectRuntimeCall(call.expression, checker),
    O.alt(() =>
      isExternalCalleeExpr(call.expression, checker)
        ? inspectExternalCallReturn(call, checker, effectSet)
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

const resolveProjectCallbackRef = (
  unwrapped: ts.Expression,
  callbackName: string,
  hofName: string,
  checker: ts.TypeChecker,
) =>
  flow(
    lookupNodeSymbol(checker),
    O.map((sym) => resolveCanonicalSymbol(sym, checker)),
    O.filter(isDeclaredInProjectSource),
    O.map((targetSym) => ({ targetSym, callbackName, hofName })),
  )(unwrapped);

const extractRefHofArg = (arg: ts.Expression, hofName: string, checker: ts.TypeChecker) => {
  const unwrapped = unwrapExpression(arg);
  return O.flatMap((callbackName: string) =>
    resolveProjectCallbackRef(unwrapped, callbackName, hofName, checker),
  )(resolveFunctionCalleeName(unwrapped));
};

const extractCallDeps = (canonicalCallee: O.Option<ts.Symbol>, label: string) =>
  flow(
    O.filter(isDeclaredInProjectSource),
    O.map((targetSym) => [{ targetSym, calleeText: label }] as ReadonlyArray<SymbolCallRef>),
    O.getOrElse(() => [] as ReadonlyArray<SymbolCallRef>),
  )(canonicalCallee);

const collectCallHofArgs = (
  call: ts.CallExpression,
  label: string,
  checker: ts.TypeChecker,
  hofMode: "track" | "skip",
) =>
  hofMode === "track"
    ? {
        hofInlineCallbacks: RA.filterMap((arg: ts.Expression) => extractInlineHofArg(arg, label))(
          call.arguments,
        ),
        hofRefCallbacks: RA.filterMap((arg: ts.Expression) =>
          extractRefHofArg(arg, label, checker),
        )(call.arguments),
      }
    : {
        hofInlineCallbacks: [] as ReadonlyArray<HofInlineCallback>,
        hofRefCallbacks: [] as ReadonlyArray<HofRefCallback>,
      };

const resolveCanonicalCallee = (expr: ts.Expression, checker: ts.TypeChecker) =>
  flow(
    lookupNodeSymbol(checker),
    O.map((sym) => resolveCanonicalSymbol(sym, checker)),
  )(expr);

const inspectCallDirectReasons =
  (call: ts.CallExpression, checker: ts.TypeChecker, effectSet: ReadonlySet<string>) =>
  (options: PurityOptions) =>
    RA.compact([
      matchCalleeMutableMethod(call, checker),
      matchImpureRuntimeCall(call, checker, effectSet)(options),
    ]);

const inspectCallExpressionNode =
  (call: ts.CallExpression, checker: ts.TypeChecker, effectSet: ReadonlySet<string>) =>
  (options: PurityOptions) => {
    const calleeName = resolveFunctionCalleeName(call.expression);
    const label = O.getOrElse(() => "anonymous")(calleeName);
    const canonicalCallee = resolveCanonicalCallee(call.expression, checker);
    return {
      reasons: inspectCallDirectReasons(call, checker, effectSet)(options),
      callDeps: extractCallDeps(canonicalCallee, label),
      ...collectCallHofArgs(
        call,
        label,
        checker,
        isProjectOrPolyHofCall(calleeName, canonicalCallee) ? "track" : "skip",
      ),
    } as CallInspectionResult;
  };

const isIncrementUnaryExpr = (node: ts.Node) =>
  (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
  INCREMENT_OPERATORS.has(node.operator);

const isZeroArgNewDate = (node: ts.NewExpression) =>
  ts.isIdentifier(node.expression) &&
  DATE_GLOBAL_NAMES.has(node.expression.text) &&
  (node.arguments?.length ?? 0) === 0;

const isExternalNodeSymbol = (node: ts.Node, checker: ts.TypeChecker) =>
  flow(lookupNodeSymbol(checker), isExternalSymbolOpt)(node);

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

const matchMutableBindingReason = (
  node: ts.Identifier,
  fn: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
) =>
  isMutableModuleLevelBinding(node, fn, checker)
    ? O.some(formatMutableBindingReason(node.text))
    : O.none;

const fallbackOptionWith = (primary: O.Option<string>) => (secondary: O.Option<string>) =>
  O.alt(() => secondary)(primary);

const inspectValueIdentifierReason = (node: ts.Identifier, checker: ts.TypeChecker) =>
  flow(
    (fn: ts.FunctionLikeDeclaration) => matchMutableBindingReason(node, fn, checker),
    fallbackOptionWith(matchDomGlobalReason(node, checker)),
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

const inspectSignatureReturnReason = (
  fn: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
  effectSet: ReadonlySet<string>,
) =>
  flow(
    lookupFnSignature(checker),
    O.map((sig) => checker.getReturnTypeOfSignature(sig)),
    O.flatMap((retType) => inspectReturnTypeReason(retType, effectSet)),
  )(fn);

const inspectSignatureReasons = (
  fn: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
  effectSet: ReadonlySet<string>,
) =>
  RA.compact([
    hasAsyncModifier(fn) ? O.some("async function") : O.none,
    inspectSignatureReturnReason(fn, checker, effectSet),
  ]);

const collectDirectReasons = (
  fn: ts.FunctionLikeDeclaration,
  bodyNodes: ReadonlyArray<ts.Node>,
  callResults: ReadonlyArray<CallInspectionResult>,
  ctx: InspectionContext,
) =>
  RA.uniq(S.Eq)([
    ...inspectSignatureReasons(fn, ctx.checker, ctx.effectSet),
    ...RA.filterMap((node: ts.Node) => inspectNonCallBodyNode(node, ctx.checker)(fn))(bodyNodes),
    ...RA.flatMap((r: CallInspectionResult) => r.reasons)(callResults),
  ]);

const inspectFunctionBody = (fn: ts.FunctionLikeDeclaration, ctx: InspectionContext) => {
  const bodyNodes = fn.body ? collectOwnBodyNodes(fn.body, ctx.sf) : [];
  const callResults = flow(
    RA.filter(ts.isCallExpression),
    RA.map((call) => inspectCallExpressionNode(call, ctx.checker, ctx.effectSet)(ctx.options)),
  )(bodyNodes);
  return {
    directReasons: collectDirectReasons(fn, bodyNodes, callResults, ctx),
    callDeps: RA.flatMap((r: CallInspectionResult) => r.callDeps)(callResults),
    hofInlineCallbacks: RA.flatMap((r: CallInspectionResult) => r.hofInlineCallbacks)(callResults),
    hofRefCallbacks: RA.flatMap((r: CallInspectionResult) => r.hofRefCallbacks)(callResults),
    complexity: computeCyclomaticComplexity(fn, ctx.sf),
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
  }) as CollectedFunction;

const toInspectionContext = (fileCtx: FileCollectionContext) =>
  ({
    sf: fileCtx.sf,
    checker: fileCtx.checker,
    options: fileCtx.options,
    effectSet: fileCtx.effectSet,
  }) as InspectionContext;

const registerWithChildren =
  (reg: FunctionRegistration, body: ts.Node) => (fileCtx: FileCollectionContext) => [
    buildCollectedFunction(reg, toInspectionContext(fileCtx)),
    ...collectChildrenAtScope(body, "nested")(fileCtx),
  ];

const isSymbolExported = (
  sym: O.Option<ts.Symbol>,
  exportedSyms: ReadonlySet<ts.Symbol>,
  checker: ts.TypeChecker,
) =>
  flow(
    O.map((s: ts.Symbol) => resolveCanonicalSymbol(s, checker)),
    O.exists((canonical) => exportedSyms.has(canonical)),
  )(sym);

const resolveTopLevelVisibility =
  (node: ts.Node, sym: O.Option<ts.Symbol>, nesting: ScopeLevel) =>
  (fileCtx: FileCollectionContext) =>
    nesting === "top-level" &&
    (fileCtx.exportedDecls.has(node) ||
      isSymbolExported(sym, fileCtx.exportedSyms, fileCtx.checker))
      ? ("exported" as const)
      : ("internal" as const);

const collectChildrenForContext = (
  parent: ts.Node,
  nesting: ScopeLevel,
  fileCtx: FileCollectionContext,
) =>
  RA.flatMap((child: ts.Node) => collectNodeFunctions(child, nesting)(fileCtx))(
    parent.getChildren(fileCtx.sf),
  );

const collectChildrenAtScope =
  (parent: ts.Node, nesting: ScopeLevel) => (fileCtx: FileCollectionContext) =>
    collectChildrenForContext(parent, nesting, fileCtx);

const resolveFunctionDeclSymbol = (node: ts.FunctionDeclaration, checker: ts.TypeChecker) =>
  node.name
    ? O.fromNullable(checker.getSymbolAtLocation(node.name))
    : O.fromNullable(checker.getSymbolAtLocation(node));

const buildDeclPlacement = (
  reportNode: ts.Node,
  sym: O.Option<ts.Symbol>,
  nesting: ScopeLevel,
  fileCtx: FileCollectionContext,
) =>
  ({
    reportNode,
    exportStatus: resolveTopLevelVisibility(reportNode, sym, nesting)(fileCtx),
    nesting,
  }) as FunctionPlacement;

const collectFunctionDeclWithBody =
  (node: ts.FunctionDeclaration, body: ts.Block, nesting: ScopeLevel) =>
  (fileCtx: FileCollectionContext) => {
    const sym = resolveFunctionDeclSymbol(node, fileCtx.checker);
    return registerWithChildren(
      {
        fn: node,
        name: node.name?.text ?? "default",
        symbol: sym,
        placement: buildDeclPlacement(node, sym, nesting, fileCtx),
      },
      body,
    )(fileCtx);
  };

const collectFunctionDecl =
  (node: ts.FunctionDeclaration, nesting: ScopeLevel) => (fileCtx: FileCollectionContext) =>
    node.body ? collectFunctionDeclWithBody(node, node.body, nesting)(fileCtx) : EMPTY_FUNCTIONS;

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
        placement: buildDeclPlacement(target.node, sym, target.nesting, fileCtx),
      },
      fnExpr.body,
    )(fileCtx);
  };

const extractInitializerFnExpr = flow(O.map(unwrapExpression), O.filter(isFunctionExprNode));

const dispatchIdentVariableDecl = (target: IdentDeclTarget, fileCtx: FileCollectionContext) =>
  flow(
    extractInitializerFnExpr,
    O.match(
      () => collectChildrenAtScope(target.node, target.nesting)(fileCtx),
      (fnExpr) => collectVariableFnDecl(target, fnExpr)(fileCtx),
    ),
  )(O.fromNullable(target.node.initializer));

const collectIdentVariableDecl = (target: IdentDeclTarget) => (fileCtx: FileCollectionContext) =>
  dispatchIdentVariableDecl(target, fileCtx);

const collectVariableDeclarationNode =
  (node: ts.VariableDeclaration, nesting: ScopeLevel) => (fileCtx: FileCollectionContext) =>
    ts.isIdentifier(node.name)
      ? collectIdentVariableDecl({ node, identName: node.name, nesting })(fileCtx)
      : collectChildrenAtScope(node, nesting)(fileCtx);

const collectMethodDeclWithBody =
  (node: ts.MethodDeclaration, body: ts.Block, nesting: ScopeLevel) =>
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
      ? collectMethodDeclWithBody(node, node.body, nesting)(fileCtx)
      : collectChildrenAtScope(node, nesting)(fileCtx);

const registerDefaultBagFnProp =
  (
    prop: ts.PropertyAssignment,
    propName: string,
    propInit: ts.ArrowFunction | ts.FunctionExpression,
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

const dispatchNamedBagFnProp = (
  prop: ts.PropertyAssignment,
  propInit: ts.ArrowFunction | ts.FunctionExpression,
  fileCtx: FileCollectionContext,
) =>
  O.map((propName: string) => registerDefaultBagFnProp(prop, propName, propInit)(fileCtx))(
    extractPropertyNameText(prop.name),
  );

const dispatchDefaultBagPropertyAssignment = (
  prop: ts.PropertyAssignment,
  fileCtx: FileCollectionContext,
) =>
  flow(
    extractInitializerFnExpr,
    O.flatMap((propInit) => dispatchNamedBagFnProp(prop, propInit, fileCtx)),
    O.getOrElse(() => EMPTY_FUNCTIONS),
  )(O.some(prop.initializer));

const collectDefaultBagPropertyAssignment =
  (prop: ts.PropertyAssignment) => (fileCtx: FileCollectionContext) =>
    dispatchDefaultBagPropertyAssignment(prop, fileCtx);

const collectDefaultBagProp =
  (prop: ts.ObjectLiteralElementLike) => (fileCtx: FileCollectionContext) =>
    match(prop)
      .when(ts.isPropertyAssignment, (p) => collectDefaultBagPropertyAssignment(p)(fileCtx))
      .when(ts.isMethodDeclaration, (p) =>
        p.body ? collectMethodDeclWithBody(p, p.body, "top-level")(fileCtx) : EMPTY_FUNCTIONS,
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
  checker: ts.TypeChecker,
  options: PurityOptions,
  effectSet: ReadonlySet<string>,
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

const countCurrentReasons = (reasonsById: ReasonsMap, id: string) =>
  flow(
    O.map((rs: ReadonlyArray<string>) => rs.length),
    O.getOrElse(() => 0),
  )(RR.lookup(id, reasonsById));

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
    recordByNode: new Map(
      RA.map((rec: CollectedFunction) => [rec.node as ts.Node, rec] as const)(allRecords),
    ),
    recordBySym: new Map(
      RA.filterMap((rec: CollectedFunction) =>
        O.map((sym: ts.Symbol) => [resolveCanonicalSymbol(sym, checker), rec] as const)(rec.symbol),
      )(allRecords),
    ),
  }) as ProgramFunctionIndex;

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
  } as FunctionPurityRecord;
};

const classifyModulePurity = (
  functions: ReadonlyArray<FunctionPurityRecord>,
  pureExported: ReadonlyArray<FunctionPurityRecord>,
  impureExported: ReadonlyArray<FunctionPurityRecord>,
) => {
  const topLevel = RA.filter((f: FunctionPurityRecord) => !f.isNested)(functions);
  return match({
    hasImpure:
      impureExported.length > 0 ||
      RA.some((f: FunctionPurityRecord) => f.purity === "impure")(topLevel),
    hasPure:
      pureExported.length > 0 ||
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
    modulePurity: classifyModulePurity(
      functions,
      partitioned.pureExportedFunctions,
      partitioned.impureExportedFunctions,
    ),
    functions,
    ...partitioned,
  } as FilePuritySummary;
};

const buildFilePuritySummary = (
  sf: ts.SourceFile,
  recs: ReadonlyArray<CollectedFunction>,
  reasonsById: ReasonsMap,
) => assembleFilePuritySummary(sf, RA.map(toFunctionPurityRecord(reasonsById))(recs));

const collectFileRecordPair = (
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  options: PurityOptions,
  effectSet: ReadonlySet<string>,
) =>
  [
    normalizeFilePath(sf.fileName),
    isBarrelFile(sf) ? EMPTY_FUNCTIONS : collectFileFunctions(sf, checker, options, effectSet),
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
  recordsByFile: Readonly<Record<string, ReadonlyArray<CollectedFunction>>>,
  finalReasons: ReasonsMap,
) => {
  const summaries = RA.map((sf: ts.SourceFile) =>
    buildFilePuritySummary(
      sf,
      recordsByFile[normalizeFilePath(sf.fileName)] ?? EMPTY_FUNCTIONS,
      finalReasons,
    ),
  )(sourceFiles);
  return {
    files: fromStringEntries(
      RA.map((summary: FilePuritySummary) => [summary.fileName, summary] as const)(summaries),
    ),
    functionsByLocation: indexTopLevelFunctionsByLocation(summaries),
  } as ProgramPurityAnalysis;
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
    collectFileRecordPair(sf, checker, options, new Set(options.effectTypes)),
  )(sourceFiles);
  return assembleProgramPurity(
    sourceFiles,
    fromStringEntries(filePairs),
    buildFinalProgramReasons(filePairs, checker),
  );
};

const purityCache = new WeakMap<ts.Program, Readonly<Record<string, ProgramPurityAnalysis>>>();

export const analyzeProgramPurity = (
  program: ts.Program,
  options: PurityOptions = DEFAULT_PURITY_OPTIONS,
) =>
  memoizeByProgramAndKey(program, formatPurityCacheKey(options), purityCache, (p) =>
    computeProgramPurity(p, options),
  );
