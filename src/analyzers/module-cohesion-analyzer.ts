import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as S from "fp-ts/lib/string.js";
import { pipe } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { normalizeFilePath } from "../utils/program-cache.js";
import { getTsTypeDeclarationFile, getTsTypeName, unwrapContainerTsTypes } from "../utils/type-helpers.js";
import {
  extractFileRuntimeExports,
  isBarrelFile,
  resolveCanonicalSymbol,
  RuntimeExport,
  unwrapExpression,
} from "./module-symbol-graph.js";

export type ModuleCohesionOptions = Readonly<{
  readonly ubiquitousTypes: ReadonlyArray<string>;
  readonly primaryDomainTypes: ReadonlyArray<string>;
}>;

export type CohesionCluster = Readonly<{
  readonly exports: ReadonlyArray<string>;
  readonly sharedReasons: ReadonlyArray<string>;
}>;

export type FileCohesionResult = Readonly<{
  readonly fileName: string;
  readonly isBarrel: boolean;
  readonly exportCount: number;
  readonly clusters: ReadonlyArray<CohesionCluster>;
  readonly isCohesive: boolean;
}>;

export const DEFAULT_UBIQUITOUS_TYPES: ReadonlyArray<string> = [
  "Context",
  "Logger",
  "Config",
  "Request",
  "Response",
];

const PRIMITIVE_FLAGS =
  ts.TypeFlags.String |
  ts.TypeFlags.StringLiteral |
  ts.TypeFlags.Number |
  ts.TypeFlags.NumberLiteral |
  ts.TypeFlags.Boolean |
  ts.TypeFlags.BooleanLiteral |
  ts.TypeFlags.BigInt |
  ts.TypeFlags.BigIntLiteral |
  ts.TypeFlags.ESSymbol |
  ts.TypeFlags.UniqueESSymbol |
  ts.TypeFlags.Void |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Null |
  ts.TypeFlags.Never |
  ts.TypeFlags.Any |
  ts.TypeFlags.Unknown |
  ts.TypeFlags.NonPrimitive;

const STDLIB_TYPE_NAMES = new Set([
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "Map",
  "ReadonlyMap",
  "WeakMap",
  "Set",
  "ReadonlySet",
  "WeakSet",
  "Promise",
  "Array",
  "ReadonlyArray",
  "Record",
  "ReadonlyRecord",
  "Readonly",
  "Partial",
  "Required",
  "Pick",
  "Omit",
  "Exclude",
  "Extract",
  "NonNullable",
  "ReturnType",
  "Parameters",
  "Awaited",
  "Function",
  "Object",
  "URL",
  "URLSearchParams",
  "Buffer",
  "ArrayBuffer",
  "Uint8Array",
  "Iterable",
  "AsyncIterable",
  "Iterator",
  "Generator",
]);

const isStdlibDeclFile = (declFile: string) => {
  const norm = normalizeFilePath(declFile);
  return (
    /\/typescript\/lib\/lib\..*\.d\.ts$/.test(norm) ||
    norm.includes("/node_modules/@types/node/")
  );
};

const isQualifyingDomainType = (
  type: ts.Type,
  sfPath: string,
  ubiquitousSet: ReadonlySet<string>,
  primarySet: ReadonlySet<string>,
): O.Option<string> => {
  if ((type.flags & PRIMITIVE_FLAGS) !== 0) return O.none;
  const nameOpt = getTsTypeName(type);
  if (O.isNone(nameOpt)) return O.none;
  const name = nameOpt.value;
  if (STDLIB_TYPE_NAMES.has(name) || ubiquitousSet.has(name)) return O.none;
  const declFileOpt = getTsTypeDeclarationFile(type);
  if (O.isSome(declFileOpt) && isStdlibDeclFile(declFileOpt.value)) return O.none;
  const isSameFile =
    O.isSome(declFileOpt) && normalizeFilePath(declFileOpt.value) === sfPath;
  if (isSameFile || primarySet.has(name)) {
    return O.some(name);
  }
  return O.none;
};

const expandTypeAndCollectDomainNames = (
  rootType: ts.Type,
  checker: ts.TypeChecker,
  sfPath: string,
  ubiquitousSet: ReadonlySet<string>,
  primarySet: ReadonlySet<string>,
  visited: Set<ts.Type>,
): ReadonlyArray<string> => {
  if (visited.has(rootType)) return [];
  visited.add(rootType);

  const direct = isQualifyingDomainType(rootType, sfPath, ubiquitousSet, primarySet);
  const unwrapped = unwrapContainerTsTypes(rootType, checker);
  const nested: Array<string> = O.isSome(direct) ? [direct.value] : [];

  for (const t of unwrapped) {
    if (t !== rootType && !visited.has(t)) {
      nested.push(
        ...expandTypeAndCollectDomainNames(t, checker, sfPath, ubiquitousSet, primarySet, visited),
      );
    }
    if (t.isIntersection()) {
      for (const member of t.types) {
        if (!visited.has(member)) {
          nested.push(
            ...expandTypeAndCollectDomainNames(
              member,
              checker,
              sfPath,
              ubiquitousSet,
              primarySet,
              visited,
            ),
          );
        }
      }
    }
  }
  return pipe(nested, RA.uniq(S.Eq));
};

const collectAnnotationTypeRefs = (
  node: ts.Node,
  checker: ts.TypeChecker,
  sfPath: string,
  ubiquitousSet: ReadonlySet<string>,
  primarySet: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const names: Array<string> = [];
  const visit = (curr: ts.Node) => {
    if (ts.isTypeReferenceNode(curr)) {
      const sym = checker.getSymbolAtLocation(curr.typeName);
      if (sym) {
        const canonical = resolveCanonicalSymbol(sym, checker);
        const name = canonical.name;
        const decl = canonical.declarations?.[0];
        const declFile = decl ? normalizeFilePath(decl.getSourceFile().fileName) : "";
        if (
          !STDLIB_TYPE_NAMES.has(name) &&
          !ubiquitousSet.has(name) &&
          !isStdlibDeclFile(declFile) &&
          (declFile === sfPath || primarySet.has(name))
        ) {
          names.push(name);
        }
      }
    }
    ts.forEachChild(curr, visit);
  };
  visit(node);
  return pipe(names, RA.uniq(S.Eq));
};

const getExportTargetNode = (exp: RuntimeExport): ts.Node => {
  if (ts.isShorthandPropertyAssignment(exp.declaration) && O.isSome(exp.symbol)) {
    return exp.symbol.value.valueDeclaration ?? exp.symbol.value.declarations?.[0] ?? exp.declaration;
  }
  if (ts.isPropertyAssignment(exp.declaration)) {
    const unwrapped = unwrapExpression(exp.declaration.initializer);
    if (ts.isIdentifier(unwrapped) && O.isSome(exp.symbol)) {
      return exp.symbol.value.valueDeclaration ?? exp.symbol.value.declarations?.[0] ?? exp.declaration;
    }
    return unwrapped;
  }
  if (ts.isExportAssignment(exp.declaration)) {
    const unwrapped = unwrapExpression(exp.declaration.expression);
    if (ts.isIdentifier(unwrapped) && O.isSome(exp.symbol)) {
      return exp.symbol.value.valueDeclaration ?? exp.symbol.value.declarations?.[0] ?? exp.declaration;
    }
    return unwrapped;
  }
  return exp.declaration;
};

const collectSignatureDomainTypes = (
  exp: RuntimeExport,
  checker: ts.TypeChecker,
  sfPath: string,
  ubiquitousSet: ReadonlySet<string>,
  primarySet: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const targetNode = getExportTargetNode(exp);
  const visited = new Set<ts.Type>();
  const names: Array<string> = [];

  const addType = (t: ts.Type) => {
    names.push(
      ...expandTypeAndCollectDomainNames(t, checker, sfPath, ubiquitousSet, primarySet, visited),
    );
  };

  const inspectSignatures = (sigs: ReadonlyArray<ts.Signature>) => {
    for (const sig of sigs) {
      addType(checker.getReturnTypeOfSignature(sig));
      for (const param of sig.getParameters()) {
        const decl = param.valueDeclaration ?? param.declarations?.[0];
        if (decl) {
          addType(checker.getTypeOfSymbolAtLocation(param, decl));
        }
      }
    }
  };

  if (ts.isFunctionLike(targetNode)) {
    const sig = checker.getSignatureFromDeclaration(targetNode);
    if (sig) inspectSignatures([sig]);
    for (const p of targetNode.parameters) {
      if (p.type) {
        names.push(...collectAnnotationTypeRefs(p.type, checker, sfPath, ubiquitousSet, primarySet));
      }
    }
    if (targetNode.type) {
      names.push(...collectAnnotationTypeRefs(targetNode.type, checker, sfPath, ubiquitousSet, primarySet));
    }
  } else if (ts.isVariableDeclaration(targetNode)) {
    const init = targetNode.initializer ? unwrapExpression(targetNode.initializer) : undefined;
    if (init && ts.isFunctionLike(init)) {
      const sig = checker.getSignatureFromDeclaration(init);
      if (sig) inspectSignatures([sig]);
      for (const p of init.parameters) {
        if (p.type) {
          names.push(...collectAnnotationTypeRefs(p.type, checker, sfPath, ubiquitousSet, primarySet));
        }
      }
      if (init.type) {
        names.push(...collectAnnotationTypeRefs(init.type, checker, sfPath, ubiquitousSet, primarySet));
      }
    } else {
      const varType = checker.getTypeAtLocation(targetNode);
      const callSigs = varType.getCallSignatures();
      if (callSigs.length > 0) {
        inspectSignatures(callSigs);
      } else {
        addType(varType);
      }
      if (targetNode.type) {
        names.push(...collectAnnotationTypeRefs(targetNode.type, checker, sfPath, ubiquitousSet, primarySet));
      }
    }
  } else if (ts.isClassDeclaration(targetNode) || ts.isClassExpression(targetNode)) {
    const clsType = checker.getTypeAtLocation(targetNode);
    inspectSignatures(clsType.getConstructSignatures());
    for (const member of targetNode.members) {
      if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
        const sig = checker.getSignatureFromDeclaration(member);
        if (sig) inspectSignatures([sig]);
      } else if (ts.isPropertyDeclaration(member) && member.type) {
        names.push(...collectAnnotationTypeRefs(member.type, checker, sfPath, ubiquitousSet, primarySet));
      }
    }
  } else {
    const nodeType = checker.getTypeAtLocation(targetNode);
    const callSigs = nodeType.getCallSignatures();
    if (callSigs.length > 0) {
      inspectSignatures(callSigs);
    } else {
      addType(nodeType);
    }
  }

  return pipe(names, RA.uniq(S.Eq));
};

type LocalDeclInfo = Readonly<{
  readonly sym: ts.Symbol;
  readonly name: string;
  readonly node: ts.Node;
}>;

const hasExportKeyword = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const collectUnexportedLocals = (
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  exportedSymbols: ReadonlySet<ts.Symbol>,
  ubiquitousSet: ReadonlySet<string>,
): ReadonlyArray<LocalDeclInfo> => {
  const locals: Array<LocalDeclInfo> = [];
  const register = (nameNode: ts.Identifier, declNode: ts.Node) => {
    const rawSym = checker.getSymbolAtLocation(nameNode);
    if (!rawSym) return;
    const canonical = resolveCanonicalSymbol(rawSym, checker);
    if (exportedSymbols.has(canonical)) return;
    locals.push({ sym: canonical, name: nameNode.text, node: declNode });
  };

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      register(stmt.name, stmt);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      register(stmt.name, stmt);
    } else if (ts.isEnumDeclaration(stmt)) {
      register(stmt.name, stmt);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      if (!hasExportKeyword(stmt) && !ubiquitousSet.has(stmt.name.text)) {
        register(stmt.name, stmt);
      }
    } else if (ts.isInterfaceDeclaration(stmt)) {
      if (!hasExportKeyword(stmt) && !ubiquitousSet.has(stmt.name.text)) {
        register(stmt.name, stmt);
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          register(decl.name, decl);
        }
      }
    }
  }
  return locals;
};

const collectReferencedSymbolsInNode = (
  root: ts.Node,
  checker: ts.TypeChecker,
): ReadonlySet<ts.Symbol> => {
  const refs = new Set<ts.Symbol>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isDeclName =
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        (ts.isFunctionDeclaration(parent) && parent.name === node) ||
        (ts.isClassDeclaration(parent) && parent.name === node) ||
        (ts.isParameter(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === node);
      if (!isDeclName) {
        const raw = checker.getSymbolAtLocation(node);
        if (raw) refs.add(resolveCanonicalSymbol(raw, checker));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return refs;
};

export const analyzeFileCohesion = (
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  options: ModuleCohesionOptions = {
    ubiquitousTypes: DEFAULT_UBIQUITOUS_TYPES,
    primaryDomainTypes: [],
  },
): FileCohesionResult => {
  const sfPath = normalizeFilePath(sf.fileName);
  const barrel = isBarrelFile(sf);
  if (barrel) {
    return { fileName: sfPath, isBarrel: true, exportCount: 0, clusters: [], isCohesive: true };
  }

  const runtimeExports = extractFileRuntimeExports(sf, checker);
  if (runtimeExports.length <= 1) {
    return {
      fileName: sfPath,
      isBarrel: false,
      exportCount: runtimeExports.length,
      clusters: runtimeExports.length === 1 ? [{ exports: [runtimeExports[0]!.exportName], sharedReasons: [] }] : [],
      isCohesive: true,
    };
  }

  const ubiquitousSet = new Set(options.ubiquitousTypes);
  const primarySet = new Set(options.primaryDomainTypes);

  const exportSymbolToName = new Map<ts.Symbol, string>();
  const exportedSymbols = new Set<ts.Symbol>();
  for (const exp of runtimeExports) {
    if (O.isSome(exp.symbol)) {
      const canonical = resolveCanonicalSymbol(exp.symbol.value, checker);
      exportSymbolToName.set(canonical, exp.exportName);
      exportedSymbols.add(canonical);
    }
  }

  const locals = collectUnexportedLocals(sf, checker, exportedSymbols, ubiquitousSet);
  const localBySym = new Map<ts.Symbol, LocalDeclInfo>(locals.map((l) => [l.sym, l]));
  const localDirectRefs = new Map<ts.Symbol, ReadonlySet<ts.Symbol>>();
  for (const local of locals) {
    localDirectRefs.set(local.sym, collectReferencedSymbolsInNode(local.node, checker));
  }

  // Transitive reachability from a starting set of referenced symbols through unexported locals
  const expandTransitiveRefs = (initialRefs: ReadonlySet<ts.Symbol>) => {
    const visitedLocals = new Set<ts.Symbol>();
    const reachedExports = new Set<string>();
    const queue: Array<ts.Symbol> = [];

    for (const sym of initialRefs) {
      const expName = exportSymbolToName.get(sym);
      if (expName) reachedExports.add(expName);
      if (localBySym.has(sym) && !visitedLocals.has(sym)) {
        visitedLocals.add(sym);
        queue.push(sym);
      }
    }

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const nextRefs = localDirectRefs.get(curr);
      if (!nextRefs) continue;
      for (const next of nextRefs) {
        const expName = exportSymbolToName.get(next);
        if (expName) reachedExports.add(expName);
        if (localBySym.has(next) && !visitedLocals.has(next)) {
          visitedLocals.add(next);
          queue.push(next);
        }
      }
    }
    return { visitedLocals, reachedExports };
  };

  type ExportProfile = Readonly<{
    readonly name: string;
    readonly reachedExports: ReadonlySet<string>;
    readonly usedLocals: ReadonlySet<ts.Symbol>;
    readonly domainTypes: ReadonlySet<string>;
  }>;

  const profiles: ReadonlyArray<ExportProfile> = runtimeExports.map((exp) => {
    const targetNode = getExportTargetNode(exp);
    const directRefs = collectReferencedSymbolsInNode(targetNode, checker);
    const { visitedLocals, reachedExports } = expandTransitiveRefs(directRefs);
    reachedExports.delete(exp.exportName);
    const domainTypes = new Set(
      collectSignatureDomainTypes(exp, checker, sfPath, ubiquitousSet, primarySet),
    );
    return {
      name: exp.exportName,
      reachedExports,
      usedLocals: visitedLocals,
      domainTypes,
    };
  });

  // Build undirected adjacency list with edge explanations
  const adj = new Map<string, Map<string, string>>();
  for (const p of profiles) {
    adj.set(p.name, new Map());
  }
  const addEdge = (a: string, b: string, reason: string) => {
    adj.get(a)?.set(b, reason);
    adj.get(b)?.set(a, reason);
  };

  for (let i = 0; i < profiles.length; i += 1) {
    const u = profiles[i]!;
    for (let j = i + 1; j < profiles.length; j += 1) {
      const v = profiles[j]!;
      if (u.reachedExports.has(v.name)) {
        addEdge(u.name, v.name, `${u.name} calls ${v.name}`);
        continue;
      }
      if (v.reachedExports.has(u.name)) {
        addEdge(u.name, v.name, `${v.name} calls ${u.name}`);
        continue;
      }
      let sharedLocalName: string | undefined;
      for (const localSym of u.usedLocals) {
        if (v.usedLocals.has(localSym)) {
          sharedLocalName = localBySym.get(localSym)?.name;
          break;
        }
      }
      if (sharedLocalName) {
        addEdge(u.name, v.name, `shared helper '${sharedLocalName}'`);
        continue;
      }
      let sharedTypeName: string | undefined;
      for (const dt of u.domainTypes) {
        if (v.domainTypes.has(dt)) {
          sharedTypeName = dt;
          break;
        }
      }
      if (sharedTypeName) {
        addEdge(u.name, v.name, `shared type '${sharedTypeName}'`);
      }
    }
  }

  // Connected components via BFS
  const visited = new Set<string>();
  const clusters: Array<CohesionCluster> = [];
  for (const p of profiles) {
    if (visited.has(p.name)) continue;
    const compExports: Array<string> = [];
    const compReasons = new Set<string>();
    const bfsQueue: Array<string> = [p.name];
    visited.add(p.name);
    while (bfsQueue.length > 0) {
      const curr = bfsQueue.shift()!;
      compExports.push(curr);
      const neighbors = adj.get(curr);
      if (!neighbors) continue;
      for (const [nb, reason] of neighbors.entries()) {
        compReasons.add(reason);
        if (!visited.has(nb)) {
          visited.add(nb);
          bfsQueue.push(nb);
        }
      }
    }
    compExports.sort();
    clusters.push({
      exports: compExports,
      sharedReasons: Array.from(compReasons).sort(),
    });
  }

  clusters.sort((a, b) => (a.exports[0] ?? "").localeCompare(b.exports[0] ?? ""));

  return {
    fileName: sfPath,
    isBarrel: false,
    exportCount: runtimeExports.length,
    clusters,
    isCohesive: clusters.length <= 1,
  };
};
