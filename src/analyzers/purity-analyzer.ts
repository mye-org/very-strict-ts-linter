import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as S from "fp-ts/lib/string.js";
import { pipe } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import {
  getProjectSourceFiles,
  memoizeByProgramAndKey,
  normalizeFilePath,
} from "../utils/program-cache.js";
import { getTsNodeLocation, makeLocationKey } from "../utils/ts-ast-helpers.js";
import {
  extractFileRuntimeExports,
  isBarrelFile,
  resolveCanonicalSymbol,
  unwrapExpression,
} from "./module-symbol-graph.js";

export type PurityStatus = "pure" | "impure";
export type ModulePurityStatus = "pure" | "impure" | "neutral";

export type PurityOptions = Readonly<{
  readonly effectTypes: ReadonlyArray<string>;
  readonly impureModules: ReadonlyArray<string>;
  readonly pureModules: ReadonlyArray<string>;
}>;

export type FunctionPurityInfo = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly fileName: string;
  readonly line: number;
  readonly locationKey: string;
  readonly node: ts.FunctionLikeDeclaration;
  readonly reportNode: ts.Node;
  readonly isExported: boolean;
  readonly isNested: boolean;
  readonly complexity: number;
  readonly purity: PurityStatus;
  readonly reasons: ReadonlyArray<string>;
}>;

export type FilePuritySummary = Readonly<{
  readonly fileName: string;
  readonly isBarrel: boolean;
  readonly modulePurity: ModulePurityStatus;
  readonly functions: ReadonlyArray<FunctionPurityInfo>;
  readonly exportedFunctions: ReadonlyArray<FunctionPurityInfo>;
  readonly pureExportedFunctions: ReadonlyArray<FunctionPurityInfo>;
  readonly impureExportedFunctions: ReadonlyArray<FunctionPurityInfo>;
  readonly exportPurityByName: Readonly<Record<string, PurityStatus>>;
}>;

export type ProgramPurityAnalysis = Readonly<{
  readonly files: Readonly<Record<string, FilePuritySummary>>;
  readonly functionsByLocation: Readonly<Record<string, FunctionPurityInfo>>;
}>;

export const DEFAULT_EFFECT_TYPES: ReadonlyArray<string> = [
  "Promise",
  "Task",
  "TaskEither",
  "IO",
  "IOEither",
  "ReaderTaskEither",
  "Effect",
  "Observable",
];

export const DEFAULT_IMPURE_MODULES: ReadonlyArray<string> = [
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
];

const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
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

const MUTATING_ARRAY_OR_COLLECTION_METHODS = new Set([
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

const MUTATING_OBJECT_STATIC_METHODS = new Set([
  "assign",
  "defineProperty",
  "defineProperties",
  "setPrototypeOf",
]);

const MUTATING_REFLECT_STATIC_METHODS = new Set(["set", "deleteProperty", "defineProperty"]);

const IMPURE_DIRECT_GLOBALS = new Set([
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

const DOM_IMPURE_GLOBALS = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
  "location",
  "history",
]);

const IMPURE_MEMBER_CALLS: Readonly<Record<string, ReadonlySet<string>>> = {
  Date: new Set(["now"]),
  Math: new Set(["random"]),
  crypto: new Set(["randomUUID", "getRandomValues"]),
  performance: new Set(["now"]),
};

const IMPURE_PROCESS_PROPS = new Set(["env", "exit", "argv", "cwd", "hrtime", "stdout", "stderr", "stdin"]);

const POLYMORPHIC_HOF_NAMES = new Set([
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
  "with",
  "otherwise",
  "fold",
  "getOrElse",
  "alt",
  "bimap",
  "mapLeft",
  "tap",
]);

const matchesModulePattern = (specifier: string, patterns: ReadonlyArray<string>) =>
  pipe(
    patterns,
    RA.some((pattern) =>
      pattern.endsWith("/")
        ? specifier.startsWith(pattern)
        : specifier === pattern || specifier.startsWith(`${pattern}/`),
    ),
  );

const hasAsyncModifier = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  pipe(
    ts.getModifiers(node) ?? [],
    RA.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
  );

const getTypeSymbolName = (type: ts.Type): O.Option<string> =>
  O.fromNullable(type.aliasSymbol?.name ?? type.getSymbol()?.name);

const isEffectType = (type: ts.Type, effectSet: ReadonlySet<string>): O.Option<string> => {
  if (type.isUnion()) {
    for (const member of type.types) {
      const matched = isEffectType(member, effectSet);
      if (O.isSome(matched)) return matched;
    }
    return O.none;
  }
  const name = getTypeSymbolName(type);
  if (O.isSome(name) && effectSet.has(name.value)) {
    return name;
  }
  return O.none;
};

const isVoidOrUndefinedOnly = (type: ts.Type): boolean => {
  if ((type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0) return true;
  if (type.isUnion() && type.types.length > 0) {
    return type.types.every((m) => (m.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0);
  }
  return false;
};

// Walk all nodes inside a function's OWN body without descending into nested function definitions
const collectOwnBodyNodes = (body: ts.Node): ReadonlyArray<ts.Node> => {
  const result: Array<ts.Node> = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) {
      return;
    }
    result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return result;
};

export const computeCyclomaticComplexity = (fn: ts.FunctionLikeDeclaration): number => {
  if (!fn.body) return 1;
  const nodes = collectOwnBodyNodes(fn.body);
  let complexity = 1;
  for (const node of nodes) {
    if (
      ts.isIfStatement(node) ||
      ts.isConditionalExpression(node) ||
      ts.isCaseClause(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isCatchClause(node)
    ) {
      complexity += 1;
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      complexity += 1;
    }
  }
  return complexity;
};

const getImportedModuleSpecifier = (
  sym: ts.Symbol,
): O.Option<string> => {
  for (const decl of sym.declarations ?? []) {
    if (ts.isImportSpecifier(decl)) {
      const importDecl = decl.parent.parent.parent;
      if (ts.isImportDeclaration(importDecl) && ts.isStringLiteral(importDecl.moduleSpecifier)) {
        return O.some(importDecl.moduleSpecifier.text);
      }
    } else if (ts.isImportClause(decl)) {
      const importDecl = decl.parent;
      if (ts.isImportDeclaration(importDecl) && ts.isStringLiteral(importDecl.moduleSpecifier)) {
        return O.some(importDecl.moduleSpecifier.text);
      }
    } else if (ts.isNamespaceImport(decl)) {
      const importDecl = decl.parent.parent;
      if (ts.isImportDeclaration(importDecl) && ts.isStringLiteral(importDecl.moduleSpecifier)) {
        return O.some(importDecl.moduleSpecifier.text);
      }
    }
  }
  return O.none;
};

const isDeclaredInProjectSource = (sym: ts.Symbol): boolean =>
  (sym.declarations ?? []).some((d) => {
    const sf = d.getSourceFile();
    return !sf.isDeclarationFile && !normalizeFilePath(sf.fileName).includes("/node_modules/");
  });

const isMutableModuleLevelBinding = (
  ident: ts.Identifier,
  fnNode: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): boolean => {
  const sym = checker.getSymbolAtLocation(ident);
  if (!sym) return false;
  const canonical = resolveCanonicalSymbol(sym, checker);
  const decl = canonical.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl)) return false;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list)) return false;
  const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
  if (isConst) return false;
  // Check if declared outside this function (module-level or outer mutable closure)
  let curr: ts.Node | undefined = decl.parent;
  while (curr) {
    if (curr === fnNode) return false;
    curr = curr.parent;
  }
  return true;
};

const isCalleeMutableMethod = (
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): O.Option<string> => {
  if (!ts.isPropertyAccessExpression(call.expression)) return O.none;
  const methodName = call.expression.name.text;
  const objExpr = call.expression.expression;

  if (ts.isIdentifier(objExpr)) {
    if (objExpr.text === "Object" && MUTATING_OBJECT_STATIC_METHODS.has(methodName)) {
      return O.some(`mutates via Object.${methodName}()`);
    }
    if (objExpr.text === "Reflect" && MUTATING_REFLECT_STATIC_METHODS.has(methodName)) {
      return O.some(`mutates via Reflect.${methodName}()`);
    }
  }

  if (MUTATING_ARRAY_OR_COLLECTION_METHODS.has(methodName)) {
    const objType = checker.getTypeAtLocation(objExpr);
    const symName = objType.getSymbol()?.name ?? "";
    const isCollection =
      checker.isArrayType(objType) ||
      checker.isTupleType(objType) ||
      symName === "Array" ||
      symName === "Map" ||
      symName === "WeakMap" ||
      symName === "Set" ||
      symName === "WeakSet";
    if (isCollection) {
      return O.some(`calls mutating method .${methodName}()`);
    }
  }
  return O.none;
};

const isImpureRuntimeCall = (
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  options: PurityOptions,
  effectSet: ReadonlySet<string>,
): O.Option<string> => {
  const callee = call.expression;

  if (ts.isIdentifier(callee)) {
    const sym = checker.getSymbolAtLocation(callee);
    if (sym) {
      const modSpec = getImportedModuleSpecifier(sym);
      if (
        O.isSome(modSpec) &&
        !matchesModulePattern(modSpec.value, options.pureModules) &&
        matchesModulePattern(modSpec.value, options.impureModules)
      ) {
        return O.some(`calls '${callee.text}' from impure module '${modSpec.value}'`);
      }
    }
    if (IMPURE_DIRECT_GLOBALS.has(callee.text) && (!sym || !isDeclaredInProjectSource(sym))) {
      return O.some(`calls impure global ${callee.text}()`);
    }
  }

  if (ts.isPropertyAccessExpression(callee)) {
    const propName = callee.name.text;
    const objExpr = callee.expression;
    if (ts.isIdentifier(objExpr)) {
      const objSym = checker.getSymbolAtLocation(objExpr);
      if (objSym) {
        const modSpec = getImportedModuleSpecifier(objSym);
        if (
          O.isSome(modSpec) &&
          !matchesModulePattern(modSpec.value, options.pureModules) &&
          matchesModulePattern(modSpec.value, options.impureModules)
        ) {
          return O.some(`calls '${objExpr.text}.${propName}' from impure module '${modSpec.value}'`);
        }
      }
      if (objExpr.text === "console" && (!objSym || !isDeclaredInProjectSource(objSym))) {
        return O.some(`calls console.${propName}()`);
      }
      const impureMethods = IMPURE_MEMBER_CALLS[objExpr.text];
      if (impureMethods?.has(propName) && (!objSym || !isDeclaredInProjectSource(objSym))) {
        return O.some(`calls ${objExpr.text}.${propName}()`);
      }
    }
  }

  // Permissive-by-default third-party check: external .d.ts call returning effect or void is impure
  const calleeSym = checker.getSymbolAtLocation(callee);
  const canonicalCallee = calleeSym ? resolveCanonicalSymbol(calleeSym, checker) : undefined;
  const isExternalCall = !canonicalCallee || !isDeclaredInProjectSource(canonicalCallee);
  if (isExternalCall) {
    const callType = checker.getTypeAtLocation(call);
    const effectName = isEffectType(callType, effectSet);
    if (O.isSome(effectName)) {
      return O.some(`external call returns ${effectName.value}`);
    }
    const calleeName = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : "";
    if (calleeName && !POLYMORPHIC_HOF_NAMES.has(calleeName) && isVoidOrUndefinedOnly(callType)) {
      const sig = checker.getResolvedSignature(call);
      if (sig) {
        const retType = checker.getReturnTypeOfSignature(sig);
        if ((retType.flags & ts.TypeFlags.Void) !== 0) {
          return O.some(`calls void external function '${calleeName}'`);
        }
      }
    }
  }

  return O.none;
};

const getFunctionCalleeName = (callee: ts.Expression): O.Option<string> => {
  if (ts.isIdentifier(callee)) return O.some(callee.text);
  if (ts.isPropertyAccessExpression(callee)) return O.some(callee.name.text);
  return O.none;
};

type CollectedFnRecord = {
  readonly id: string;
  readonly name: string;
  readonly fileName: string;
  readonly line: number;
  readonly locationKey: string;
  readonly node: ts.FunctionLikeDeclaration;
  readonly reportNode: ts.Node;
  readonly symbol: O.Option<ts.Symbol>;
  readonly isExported: boolean;
  readonly isNested: boolean;
  readonly complexity: number;
  readonly paramSymbols: ReadonlySet<ts.Symbol>;
  readonly invokedParamIndices: ReadonlySet<number>;
  readonly directReasons: ReadonlyArray<string>;
  readonly callDepSymbols: ReadonlyArray<{ readonly sym: ts.Symbol; readonly label: string }>;
  readonly hofCallbackInlineNodes: ReadonlyArray<{ readonly fn: ts.FunctionLikeDeclaration; readonly hofName: string }>;
  readonly hofCallbackRefSymbols: ReadonlyArray<{ readonly sym: ts.Symbol; readonly label: string; readonly hofName: string }>;
};

const makeFnId = (sf: ts.SourceFile, node: ts.Node) =>
  `${normalizeFilePath(sf.fileName)}@${String(node.getStart(sf))}`;

const getInvokedParamIndices = (
  fn: ts.FunctionLikeDeclaration,
  bodyNodes: ReadonlyArray<ts.Node>,
  checker: ts.TypeChecker,
): ReadonlySet<number> => {
  const paramIndexBySym = new Map<ts.Symbol, number>();
  fn.parameters.forEach((p, idx) => {
    if (ts.isIdentifier(p.name)) {
      const sym = checker.getSymbolAtLocation(p.name);
      if (sym) paramIndexBySym.set(sym, idx);
    }
  });
  const invoked = new Set<number>();
  for (const node of bodyNodes) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const sym = checker.getSymbolAtLocation(node.expression);
      if (sym !== undefined) {
        const idx = paramIndexBySym.get(sym);
        if (idx !== undefined) invoked.add(idx);
      }
    }
  }
  return invoked;
};

const inspectFunctionBody = (
  fn: ts.FunctionLikeDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  options: PurityOptions,
  effectSet: ReadonlySet<string>,
) => {
  const reasons: Array<string> = [];
  const callDepSymbols: Array<{ readonly sym: ts.Symbol; readonly label: string }> = [];
  const hofCallbackInlineNodes: Array<{ readonly fn: ts.FunctionLikeDeclaration; readonly hofName: string }> = [];
  const hofCallbackRefSymbols: Array<{ readonly sym: ts.Symbol; readonly label: string; readonly hofName: string }> = [];

  if (hasAsyncModifier(fn)) {
    reasons.push("async function");
  }

  const sig = checker.getSignatureFromDeclaration(fn);
  if (sig) {
    const retType = checker.getReturnTypeOfSignature(sig);
    const effectMatch = isEffectType(retType, effectSet);
    if (O.isSome(effectMatch)) {
      reasons.push(`returns ${effectMatch.value}`);
    } else if (isVoidOrUndefinedOnly(retType)) {
      reasons.push("returns void/undefined");
    }
  }

  const bodyNodes = fn.body ? collectOwnBodyNodes(fn.body) : [];
  const paramSymbols = new Set<ts.Symbol>();
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name)) {
      const sym = checker.getSymbolAtLocation(p.name);
      if (sym) paramSymbols.add(sym);
    }
  }
  const invokedParamIndices = getInvokedParamIndices(fn, bodyNodes, checker);

  for (const node of bodyNodes) {
    if (ts.isThrowStatement(node)) {
      reasons.push("throws exception");
    } else if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
      reasons.push("mutates via assignment");
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      reasons.push("mutates via ++/--");
    } else if (ts.isDeleteExpression(node)) {
      reasons.push("mutates via delete");
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Date" &&
      (node.arguments?.length ?? 0) === 0
    ) {
      reasons.push("calls non-deterministic new Date()");
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "process" && IMPURE_PROCESS_PROPS.has(node.name.text)) {
        const sym = checker.getSymbolAtLocation(node.expression);
        if (!sym || !isDeclaredInProjectSource(sym)) {
          reasons.push(`reads process.${node.name.text}`);
        }
      }
    } else if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isPropertyKey =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        ts.isTypeNode(parent) ||
        ts.isTypeReferenceNode(parent);
      if (!isPropertyKey) {
        if (DOM_IMPURE_GLOBALS.has(node.text)) {
          const sym = checker.getSymbolAtLocation(node);
          if (!sym || !isDeclaredInProjectSource(sym)) {
            reasons.push(`accesses DOM global '${node.text}'`);
          }
        } else if (isMutableModuleLevelBinding(node, fn, checker)) {
          reasons.push(`references mutable binding '${node.text}'`);
        }
      }
    } else if (ts.isCallExpression(node)) {
      const mutMethod = isCalleeMutableMethod(node, checker);
      if (O.isSome(mutMethod)) {
        reasons.push(mutMethod.value);
      }
      const impureCall = isImpureRuntimeCall(node, checker, options, effectSet);
      if (O.isSome(impureCall)) {
        reasons.push(impureCall.value);
      }

      // Track calls to project functions
      const calleeSym = checker.getSymbolAtLocation(node.expression);
      const calleeName = getFunctionCalleeName(node.expression);
      const label = O.getOrElse(() => "anonymous")(calleeName);
      if (calleeSym) {
        const canonical = resolveCanonicalSymbol(calleeSym, checker);
        if (isDeclaredInProjectSource(canonical)) {
          callDepSymbols.push({ sym: canonical, label });
        }
      }

      // Track HOF callback arguments (both built-in polymorphic HOFs and user-defined HOFs)
      const isKnownPolyHof = O.isSome(calleeName) && POLYMORPHIC_HOF_NAMES.has(calleeName.value);
      for (const arg of node.arguments) {
        const unwrappedArg = unwrapExpression(arg);
        if (ts.isArrowFunction(unwrappedArg) || ts.isFunctionExpression(unwrappedArg)) {
          if (isKnownPolyHof || (calleeSym && isDeclaredInProjectSource(resolveCanonicalSymbol(calleeSym, checker)))) {
            hofCallbackInlineNodes.push({ fn: unwrappedArg, hofName: label });
          }
        } else if (ts.isIdentifier(unwrappedArg) || ts.isPropertyAccessExpression(unwrappedArg)) {
          if (isKnownPolyHof || (calleeSym && isDeclaredInProjectSource(resolveCanonicalSymbol(calleeSym, checker)))) {
            const argSym = checker.getSymbolAtLocation(unwrappedArg);
            if (argSym) {
              const canonicalArg = resolveCanonicalSymbol(argSym, checker);
              if (isDeclaredInProjectSource(canonicalArg)) {
                const argLabel = ts.isIdentifier(unwrappedArg)
                  ? unwrappedArg.text
                  : unwrappedArg.name.text;
                hofCallbackRefSymbols.push({ sym: canonicalArg, label: argLabel, hofName: label });
              }
            }
          }
        }
      }
    }
  }

  return {
    paramSymbols,
    invokedParamIndices,
    directReasons: pipe(reasons, RA.uniq(S.Eq)),
    callDepSymbols,
    hofCallbackInlineNodes,
    hofCallbackRefSymbols,
    complexity: computeCyclomaticComplexity(fn),
  };
};

const collectFileFunctions = (
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  options: PurityOptions,
  effectSet: ReadonlySet<string>,
): ReadonlyArray<CollectedFnRecord> => {
  const fileName = normalizeFilePath(sf.fileName);
  const runtimeExports = extractFileRuntimeExports(sf, checker);
  const exportedDecls = new Set<ts.Node>(runtimeExports.map((e) => e.declaration));
  const exportedSyms = new Set<ts.Symbol>(
    pipe(
      runtimeExports,
      RA.filterMap((e) => e.symbol),
    ),
  );
  const records: Array<CollectedFnRecord> = [];

  const registerFn = (
    fn: ts.FunctionLikeDeclaration,
    name: string,
    reportNode: ts.Node,
    symbol: O.Option<ts.Symbol>,
    isExported: boolean,
    isNested: boolean,
  ) => {
    if (!fn.body) return;
    const loc = getTsNodeLocation(reportNode, sf);
    const inspected = inspectFunctionBody(fn, sf, checker, options, effectSet);
    records.push({
      id: makeFnId(sf, fn),
      name,
      fileName,
      line: loc.line,
      locationKey: makeLocationKey(loc),
      node: fn,
      reportNode,
      symbol,
      isExported,
      isNested,
      ...inspected,
    });
  };

  const visit = (node: ts.Node, depth: number) => {
    if (ts.isFunctionDeclaration(node) && node.body) {
      const name = node.name?.text ?? "default";
      const sym = node.name
        ? O.fromNullable(checker.getSymbolAtLocation(node.name))
        : O.fromNullable(checker.getSymbolAtLocation(node));
      const isExp =
        depth === 0 &&
        (exportedDecls.has(node) || (O.isSome(sym) && exportedSyms.has(resolveCanonicalSymbol(sym.value, checker))));
      registerFn(node, name, node, sym, isExp, depth > 0);
      ts.forEachChild(node.body, (c) => visit(c, depth + 1));
      return;
    }

    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const unwrapped = unwrapExpression(node.initializer);
      if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
        const sym = O.fromNullable(checker.getSymbolAtLocation(node.name));
        const isExp =
          depth === 0 &&
          (exportedDecls.has(node) || (O.isSome(sym) && exportedSyms.has(resolveCanonicalSymbol(sym.value, checker))));
        registerFn(unwrapped, node.name.text, node, sym, isExp, depth > 0);
        if (unwrapped.body) {
          ts.forEachChild(unwrapped.body, (c) => visit(c, depth + 1));
        }
        return;
      }
    }

    if (ts.isMethodDeclaration(node) && node.body) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : "method";
      const sym = O.fromNullable(checker.getSymbolAtLocation(node.name));
      const isDefaultBagMethod = exportedDecls.has(node);
      registerFn(node, name, node, sym, isDefaultBagMethod, depth > 0 && !isDefaultBagMethod);
      ts.forEachChild(node.body, (c) => visit(c, depth + 1));
      return;
    }

    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const unwrapped = unwrapExpression(node.expression);
      if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
        registerFn(unwrapped, "default", node, O.fromNullable(checker.getSymbolAtLocation(node)), true, false);
        if (unwrapped.body) {
          ts.forEachChild(unwrapped.body, (c) => visit(c, depth + 1));
        }
        return;
      }
      if (ts.isObjectLiteralExpression(unwrapped) && unwrapped.properties.length >= 2) {
        for (const prop of unwrapped.properties) {
          if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
            const propInit = unwrapExpression(prop.initializer);
            if (ts.isArrowFunction(propInit) || ts.isFunctionExpression(propInit)) {
              registerFn(
                propInit,
                `default.${prop.name.text}`,
                prop,
                O.fromNullable(checker.getSymbolAtLocation(prop.name)),
                true,
                false,
              );
              if (propInit.body) {
                ts.forEachChild(propInit.body, (c) => visit(c, depth + 1));
              }
            }
          } else if (ts.isMethodDeclaration(prop) && prop.body) {
            visit(prop, 0);
          }
        }
        return;
      }
    }

    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      registerFn(node, "<inline>", node, O.none, false, true);
      if (node.body) {
        ts.forEachChild(node.body, (c) => visit(c, depth + 1));
      }
      return;
    }

    ts.forEachChild(node, (c) => visit(c, depth));
  };

  for (const stmt of sf.statements) {
    visit(stmt, 0);
  }
  return records;
};

const computeProgramPurity = (
  program: ts.Program,
  options: PurityOptions,
): ProgramPurityAnalysis => {
  const checker = program.getTypeChecker();
  const effectSet = new Set(options.effectTypes);
  const sourceFiles = getProjectSourceFiles(program);

  const allRecords: Array<CollectedFnRecord> = [];
  const recordsByFile = new Map<string, ReadonlyArray<CollectedFnRecord>>();
  const recordById = new Map<string, CollectedFnRecord>();
  const recordByNode = new Map<ts.Node, CollectedFnRecord>();
  const recordBySym = new Map<ts.Symbol, CollectedFnRecord>();

  for (const sf of sourceFiles) {
    const fileName = normalizeFilePath(sf.fileName);
    if (isBarrelFile(sf)) {
      recordsByFile.set(fileName, []);
      continue;
    }
    const fns = collectFileFunctions(sf, checker, options, effectSet);
    recordsByFile.set(fileName, fns);
    for (const rec of fns) {
      allRecords.push(rec);
      recordById.set(rec.id, rec);
      recordByNode.set(rec.node, rec);
      if (O.isSome(rec.symbol)) {
        recordBySym.set(resolveCanonicalSymbol(rec.symbol.value, checker), rec);
      }
    }
  }

  // Fixed-point monotonic impurity propagation across call graph (handles cycles / SCCs)
  const reasonsById = new Map<string, Set<string>>();
  for (const rec of allRecords) {
    reasonsById.set(rec.id, new Set(rec.directReasons));
  }

  let changed = true;
  let guard = 0;
  const maxIterations = allRecords.length + 2;
  while (changed && guard < maxIterations) {
    changed = false;
    guard += 1;

    for (const rec of allRecords) {
      const ownReasons = reasonsById.get(rec.id);
      if (!ownReasons) continue;
      const beforeSize = ownReasons.size;

      for (const dep of rec.callDepSymbols) {
        const target = recordBySym.get(dep.sym);
        if (!target) continue;
        const targetReasons = reasonsById.get(target.id);
        if (targetReasons && targetReasons.size > 0) {
          ownReasons.add(`calls impure '${dep.label}'`);
        }
      }

      for (const inlineHof of rec.hofCallbackInlineNodes) {
        const target = recordByNode.get(inlineHof.fn);
        if (!target) continue;
        const targetReasons = reasonsById.get(target.id);
        if (targetReasons && targetReasons.size > 0) {
          ownReasons.add(`passes impure callback to '${inlineHof.hofName}'`);
        }
      }

      for (const refHof of rec.hofCallbackRefSymbols) {
        const target = recordBySym.get(refHof.sym);
        if (!target) continue;
        const targetReasons = reasonsById.get(target.id);
        if (targetReasons && targetReasons.size > 0) {
          ownReasons.add(`passes impure callback '${refHof.label}' to '${refHof.hofName}'`);
        }
      }

      if (ownReasons.size > beforeSize) {
        changed = true;
      }
    }
  }

  const files: Record<string, FilePuritySummary> = {};
  const functionsByLocation: Record<string, FunctionPurityInfo> = {};

  for (const sf of sourceFiles) {
    const fileName = normalizeFilePath(sf.fileName);
    const barrel = isBarrelFile(sf);
    const recs = recordsByFile.get(fileName) ?? [];

    const functions: ReadonlyArray<FunctionPurityInfo> = recs.map((rec) => {
      const reasons = Array.from(reasonsById.get(rec.id) ?? []).sort();
      const info: FunctionPurityInfo = {
        id: rec.id,
        name: rec.name,
        fileName: rec.fileName,
        line: rec.line,
        locationKey: rec.locationKey,
        node: rec.node,
        reportNode: rec.reportNode,
        isExported: rec.isExported,
        isNested: rec.isNested,
        complexity: rec.complexity,
        purity: reasons.length > 0 ? "impure" : "pure",
        reasons,
      };
      if (!rec.isNested) {
        functionsByLocation[rec.locationKey] = info;
      }
      return info;
    });

    const exportedFunctions = functions.filter((f) => f.isExported);
    const pureExportedFunctions = exportedFunctions.filter((f) => f.purity === "pure");
    const impureExportedFunctions = exportedFunctions.filter((f) => f.purity === "impure");

    const exportPurityByName: Record<string, PurityStatus> = {};
    for (const expFn of exportedFunctions) {
      exportPurityByName[expFn.name] = expFn.purity;
    }

    const topLevelFns = functions.filter((f) => !f.isNested);
    const hasAnyImpure =
      impureExportedFunctions.length > 0 || topLevelFns.some((f) => f.purity === "impure");
    const hasAnyPure = pureExportedFunctions.length > 0 || topLevelFns.some((f) => f.purity === "pure");
    const modulePurity: ModulePurityStatus = hasAnyImpure
      ? "impure"
      : hasAnyPure
        ? "pure"
        : "neutral";

    files[fileName] = {
      fileName,
      isBarrel: barrel,
      modulePurity,
      functions,
      exportedFunctions,
      pureExportedFunctions,
      impureExportedFunctions,
      exportPurityByName,
    };
  }

  return { files, functionsByLocation };
};

const purityCache = new WeakMap<ts.Program, Readonly<Record<string, ProgramPurityAnalysis>>>();

export const analyzeProgramPurity = (
  program: ts.Program,
  options: PurityOptions = {
    effectTypes: DEFAULT_EFFECT_TYPES,
    impureModules: DEFAULT_IMPURE_MODULES,
    pureModules: [],
  },
): ProgramPurityAnalysis => {
  const key = [
    options.effectTypes.join(","),
    options.impureModules.join(","),
    options.pureModules.join(","),
  ].join("||");
  return memoizeByProgramAndKey(program, key, purityCache, (p) =>
    computeProgramPurity(p, options),
  );
};
