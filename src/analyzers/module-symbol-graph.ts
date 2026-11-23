import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as S from "fp-ts/lib/string.js";
import { pipe } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import {
  getProjectSourceFiles,
  isMatchingAnyPattern,
  memoizeByProgram,
  memoizeByProgramAndKey,
  normalizeFilePath,
} from "../utils/program-cache.js";
import { collectTsNodes, getTsNodeLocation, makeLocationKey } from "../utils/ts-ast-helpers.js";

export type RuntimeExportKind = "function" | "class" | "value";

export type RuntimeExport = Readonly<{
  readonly key: string;
  readonly exportName: string;
  readonly localName: string;
  readonly kind: RuntimeExportKind;
  readonly fileName: string;
  readonly line: number;
  readonly locationKey: string;
  readonly declaration: ts.Node;
  readonly symbol: O.Option<ts.Symbol>;
  readonly defaultBagProperty: O.Option<string>;
}>;

export type ModuleConsumerRecord = Readonly<{
  readonly exportKey: string;
  readonly prodConsumers: ReadonlyArray<string>;
  readonly testConsumers: ReadonlyArray<string>;
}>;

export type FileModuleGraph = Readonly<{
  readonly fileName: string;
  readonly isBarrel: boolean;
  readonly isTest: boolean;
  readonly isEntryPoint: boolean;
  readonly lineCount: number;
  readonly runtimeExports: ReadonlyArray<RuntimeExport>;
  readonly consumersByExport: Readonly<Record<string, ModuleConsumerRecord>>;
  readonly prodImportsByConsumer: Readonly<Record<string, ReadonlyArray<string>>>;
}>;

export type ProgramSymbolGraph = Readonly<{
  readonly files: Readonly<Record<string, FileModuleGraph>>;
  readonly publicEntryPointExports: ReadonlySet<string>;
  readonly exportByKey: Readonly<Record<string, RuntimeExport>>;
}>;

export const DEFAULT_TEST_PATTERNS: ReadonlyArray<string> = [
  "**/*.test.ts",
  "**/*.spec.ts",
  "**/*.test.tsx",
  "**/*.spec.tsx",
  "**/__tests__/**",
];

const hasModifierKind = (node: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(node) &&
  pipe(
    ts.getModifiers(node) ?? [],
    RA.some((m) => m.kind === kind),
  );

const isExportedStmt = (node: ts.Node) => hasModifierKind(node, ts.SyntaxKind.ExportKeyword);
const isDefaultStmt = (node: ts.Node) => hasModifierKind(node, ts.SyntaxKind.DefaultKeyword);
const isAmbientStmt = (node: ts.Node) => hasModifierKind(node, ts.SyntaxKind.DeclareKeyword);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- recursive expression unwrap
export const unwrapExpression = (expr: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expr) ||
  ts.isAsExpression(expr) ||
  ts.isSatisfiesExpression(expr) ||
  ts.isTypeAssertionExpression(expr) ||
  ts.isNonNullExpression(expr)
    ? unwrapExpression(expr.expression)
    : expr;

const isFunctionExpressionLike = (expr: ts.Expression) => {
  const unwrapped = unwrapExpression(expr);
  return ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped);
};

const classifyInitializerKind = (init: ts.Expression | undefined): RuntimeExportKind => {
  if (!init) return "value";
  const unwrapped = unwrapExpression(init);
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) return "function";
  if (ts.isClassExpression(unwrapped)) return "class";
  return "value";
};

const isBarrelAllowedStatement = (stmt: ts.Statement) =>
  ts.isExportDeclaration(stmt) ||
  ts.isImportDeclaration(stmt) ||
  ts.isTypeAliasDeclaration(stmt) ||
  ts.isInterfaceDeclaration(stmt) ||
  ts.isEmptyStatement(stmt);

export const isBarrelFile = (sf: ts.SourceFile): boolean => {
  if (sf.statements.length === 0) return false;
  const hasReExport = pipe(
    sf.statements,
    RA.some((stmt) => ts.isExportDeclaration(stmt) && !stmt.isTypeOnly),
  );
  return hasReExport && pipe(sf.statements, RA.every(isBarrelAllowedStatement));
};

export const resolveCanonicalSymbol = (
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): ts.Symbol => {
  const visited = new Set<ts.Symbol>();
  let current = symbol;
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !visited.has(current)) {
    visited.add(current);
    try {
      const aliased = checker.getAliasedSymbol(current);
      if (!aliased || aliased === current || aliased.name === "unknown") break;
      current = aliased;
    } catch {
      break;
    }
  }
  return current;
};

const makeExportKey = (fileName: string, exportName: string) => `${fileName}#${exportName}`;

const buildRuntimeExport = (
  sf: ts.SourceFile,
  exportName: string,
  localName: string,
  kind: RuntimeExportKind,
  declaration: ts.Node,
  symbol: O.Option<ts.Symbol>,
  defaultBagProperty: O.Option<string> = O.none,
): RuntimeExport => {
  const fileName = normalizeFilePath(sf.fileName);
  const loc = getTsNodeLocation(declaration, sf);
  return {
    key: makeExportKey(fileName, exportName),
    exportName,
    localName,
    kind,
    fileName,
    line: loc.line,
    locationKey: makeLocationKey(loc),
    declaration,
    symbol,
    defaultBagProperty,
  };
};

const collectBindingIdentifiers = (name: ts.BindingName): ReadonlyArray<ts.Identifier> => {
  if (ts.isIdentifier(name)) return [name];
  return pipe(
    name.elements,
    RA.flatMap((el) => (ts.isOmittedExpression(el) ? [] : collectBindingIdentifiers(el.name))),
  );
};

const extractVariableExports = (
  stmt: ts.VariableStatement,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
): ReadonlyArray<RuntimeExport> =>
  pipe(
    stmt.declarationList.declarations,
    RA.flatMap((decl) => {
      if (ts.isIdentifier(decl.name)) {
        const sym = O.fromNullable(checker.getSymbolAtLocation(decl.name));
        return [
          buildRuntimeExport(
            sf,
            decl.name.text,
            decl.name.text,
            classifyInitializerKind(decl.initializer),
            decl,
            sym,
          ),
        ];
      }
      return pipe(
        collectBindingIdentifiers(decl.name),
        RA.map((id) =>
          buildRuntimeExport(
            sf,
            id.text,
            id.text,
            "value",
            decl,
            O.fromNullable(checker.getSymbolAtLocation(id)),
          ),
        ),
      );
    }),
  );

const isRuntimeSymbol = (sym: ts.Symbol) => {
  const valueFlags =
    ts.SymbolFlags.Value |
    ts.SymbolFlags.Function |
    ts.SymbolFlags.Class |
    ts.SymbolFlags.RegularEnum |
    ts.SymbolFlags.ConstEnum |
    ts.SymbolFlags.Variable |
    ts.SymbolFlags.ValueModule;
  return (sym.flags & valueFlags) !== 0;
};

const classifyDeclarationNode = (decl: ts.Node): RuntimeExportKind => {
  if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) return "function";
  if (ts.isClassDeclaration(decl)) return "class";
  if (ts.isVariableDeclaration(decl)) return classifyInitializerKind(decl.initializer);
  return "value";
};

const extractNamedReExportSpecifiers = (
  stmt: ts.ExportDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
): ReadonlyArray<RuntimeExport> => {
  if (stmt.isTypeOnly || stmt.moduleSpecifier || !stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) {
    return [];
  }
  const normalizedSf = normalizeFilePath(sf.fileName);
  return pipe(
    stmt.exportClause.elements,
    RA.filter((spec) => !spec.isTypeOnly),
    RA.filterMap((spec) => {
      const localIdent = spec.propertyName ?? spec.name;
      const rawSym = checker.getSymbolAtLocation(localIdent) ?? checker.getSymbolAtLocation(spec.name);
      if (!rawSym) return O.none;
      const canonical = resolveCanonicalSymbol(rawSym, checker);
      if (!isRuntimeSymbol(canonical)) return O.none;
      const decl = canonical.valueDeclaration ?? canonical.declarations?.[0];
      if (!decl || normalizeFilePath(decl.getSourceFile().fileName) !== normalizedSf) {
        return O.none;
      }
      return O.some(
        buildRuntimeExport(
          sf,
          spec.name.text,
          localIdent.text,
          classifyDeclarationNode(decl),
          decl,
          O.some(canonical),
        ),
      );
    }),
  );
};

const extractDefaultBagProperty = (
  prop: ts.ObjectLiteralElementLike,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
): O.Option<RuntimeExport> => {
  if (ts.isShorthandPropertyAssignment(prop)) {
    const rawSym = checker.getShorthandAssignmentValueSymbol(prop);
    const canonical = rawSym ? O.some(resolveCanonicalSymbol(rawSym, checker)) : O.none;
    const decl = O.isSome(canonical)
      ? canonical.value.valueDeclaration ?? canonical.value.declarations?.[0] ?? prop
      : prop;
    const kind = classifyDeclarationNode(decl);
    return O.some(
      buildRuntimeExport(
        sf,
        `default.${prop.name.text}`,
        prop.name.text,
        kind,
        prop,
        canonical,
        O.some(prop.name.text),
      ),
    );
  }
  if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
    const propName = prop.name.text;
    const unwrappedInit = unwrapExpression(prop.initializer);
    const targetSym = ts.isIdentifier(unwrappedInit)
      ? pipe(
          O.fromNullable(checker.getSymbolAtLocation(unwrappedInit)),
          O.map((s) => resolveCanonicalSymbol(s, checker)),
        )
      : O.fromNullable(checker.getSymbolAtLocation(prop.name));
    const kind = ts.isIdentifier(unwrappedInit) && O.isSome(targetSym) && targetSym.value.valueDeclaration
      ? classifyDeclarationNode(targetSym.value.valueDeclaration)
      : classifyInitializerKind(prop.initializer);
    return O.some(
      buildRuntimeExport(
        sf,
        `default.${propName}`,
        propName,
        kind,
        prop,
        targetSym,
        O.some(propName),
      ),
    );
  }
  if (ts.isMethodDeclaration(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
    return O.some(
      buildRuntimeExport(
        sf,
        `default.${prop.name.text}`,
        prop.name.text,
        "function",
        prop,
        O.fromNullable(checker.getSymbolAtLocation(prop.name)),
        O.some(prop.name.text),
      ),
    );
  }
  return O.none;
};

const extractDefaultAssignment = (
  stmt: ts.ExportAssignment,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
): ReadonlyArray<RuntimeExport> => {
  if (stmt.isExportEquals) return [];
  const unwrapped = unwrapExpression(stmt.expression);
  if (ts.isObjectLiteralExpression(unwrapped) && unwrapped.properties.length >= 2) {
    const props = pipe(
      unwrapped.properties,
      RA.filterMap((prop) => extractDefaultBagProperty(prop, sf, checker)),
    );
    if (props.length >= 2) return props;
  }
  const sym = ts.isIdentifier(unwrapped)
    ? pipe(
        O.fromNullable(checker.getSymbolAtLocation(unwrapped)),
        O.map((s) => resolveCanonicalSymbol(s, checker)),
      )
    : O.fromNullable(checker.getSymbolAtLocation(stmt));
  const localName = ts.isIdentifier(unwrapped) ? unwrapped.text : "default";
  const kind =
    ts.isIdentifier(unwrapped) && O.isSome(sym) && sym.value.valueDeclaration
      ? classifyDeclarationNode(sym.value.valueDeclaration)
      : classifyInitializerKind(unwrapped);
  return [buildRuntimeExport(sf, "default", localName, kind, stmt, sym)];
};

const extractStatementExports = (
  stmt: ts.Statement,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
): ReadonlyArray<RuntimeExport> => {
  if (isAmbientStmt(stmt)) return [];
  if (ts.isFunctionDeclaration(stmt) && isExportedStmt(stmt)) {
    if (!stmt.body) return [];
    const exportName = isDefaultStmt(stmt) ? "default" : stmt.name?.text ?? "default";
    const localName = stmt.name?.text ?? "default";
    const sym = stmt.name
      ? O.fromNullable(checker.getSymbolAtLocation(stmt.name))
      : O.fromNullable(checker.getSymbolAtLocation(stmt));
    return [buildRuntimeExport(sf, exportName, localName, "function", stmt, sym)];
  }
  if (ts.isClassDeclaration(stmt) && isExportedStmt(stmt)) {
    const exportName = isDefaultStmt(stmt) ? "default" : stmt.name?.text ?? "default";
    const localName = stmt.name?.text ?? "default";
    const sym = stmt.name
      ? O.fromNullable(checker.getSymbolAtLocation(stmt.name))
      : O.fromNullable(checker.getSymbolAtLocation(stmt));
    return [buildRuntimeExport(sf, exportName, localName, "class", stmt, sym)];
  }
  if (ts.isEnumDeclaration(stmt) && isExportedStmt(stmt)) {
    return [
      buildRuntimeExport(
        sf,
        stmt.name.text,
        stmt.name.text,
        "value",
        stmt,
        O.fromNullable(checker.getSymbolAtLocation(stmt.name)),
      ),
    ];
  }
  if (ts.isVariableStatement(stmt) && isExportedStmt(stmt)) {
    return extractVariableExports(stmt, sf, checker);
  }
  if (ts.isExportDeclaration(stmt)) {
    return extractNamedReExportSpecifiers(stmt, sf, checker);
  }
  if (ts.isExportAssignment(stmt)) {
    return extractDefaultAssignment(stmt, sf, checker);
  }
  return [];
};

export const extractFileRuntimeExports = (
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
): ReadonlyArray<RuntimeExport> => {
  if (isBarrelFile(sf)) return [];
  const all = pipe(
    sf.statements,
    RA.flatMap((stmt) => extractStatementExports(stmt, sf, checker)),
  );
  const seen = new Set<string>();
  return pipe(
    all,
    RA.filter((exp) => {
      if (seen.has(exp.exportName)) return false;
      seen.add(exp.exportName);
      return true;
    }),
  );
};

export const isRuntimeFunctionNode = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  (ts.isVariableDeclaration(node) && Boolean(node.initializer && isFunctionExpressionLike(node.initializer)));

type RawImportEdge = Readonly<{
  readonly consumerFile: string;
  readonly exportKey: string;
}>;

type BaseProgramSymbolData = Readonly<{
  readonly fileExports: Readonly<Record<string, ReadonlyArray<RuntimeExport>>>;
  readonly barrelFiles: ReadonlySet<string>;
  readonly lineCounts: Readonly<Record<string, number>>;
  readonly exportByKey: Readonly<Record<string, RuntimeExport>>;
  readonly importEdges: ReadonlyArray<RawImportEdge>;
}>;

const buildSymbolToExportLookup = (
  exportByKey: Readonly<Record<string, RuntimeExport>>,
) => {
  const bySymbol = new Map<ts.Symbol, RuntimeExport>();
  const byFileAndLocal = new Map<string, RuntimeExport>();
  const byFileDefaultProps = new Map<string, Map<string, RuntimeExport>>();

  for (const exp of Object.values(exportByKey)) {
    if (O.isSome(exp.symbol)) {
      bySymbol.set(exp.symbol.value, exp);
    }
    byFileAndLocal.set(`${exp.fileName}#${exp.localName}`, exp);
    byFileAndLocal.set(`${exp.fileName}#${exp.exportName}`, exp);
    if (O.isSome(exp.defaultBagProperty)) {
      const existing = byFileDefaultProps.get(exp.fileName) ?? new Map<string, RuntimeExport>();
      existing.set(exp.defaultBagProperty.value, exp);
      byFileDefaultProps.set(exp.fileName, existing);
    }
  }
  return { bySymbol, byFileAndLocal, byFileDefaultProps };
};

type SymbolLookup = ReturnType<typeof buildSymbolToExportLookup>;

const matchSymbolToExport = (
  sym: ts.Symbol,
  checker: ts.TypeChecker,
  lookup: SymbolLookup,
): O.Option<RuntimeExport> => {
  const canonical = resolveCanonicalSymbol(sym, checker);
  const direct = lookup.bySymbol.get(canonical);
  if (direct) return O.some(direct);
  const decl = canonical.valueDeclaration ?? canonical.declarations?.[0];
  if (!decl) return O.none;
  const declFile = normalizeFilePath(decl.getSourceFile().fileName);
  const byLocal = lookup.byFileAndLocal.get(`${declFile}#${canonical.name}`);
  if (byLocal) return O.some(byLocal);
  if (canonical.name === "default") {
    return O.fromNullable(lookup.byFileAndLocal.get(`${declFile}#default`));
  }
  return O.none;
};

const resolveModuleSymbolFromSpecifier = (
  specifier: ts.Expression,
  checker: ts.TypeChecker,
): O.Option<ts.Symbol> => O.fromNullable(checker.getSymbolAtLocation(specifier));

const extractBindingPropNames = (pattern: ts.ObjectBindingPattern): ReadonlyArray<string> =>
  pipe(
    pattern.elements,
    RA.filterMap((el) => {
      const propName = el.propertyName ?? el.name;
      return ts.isIdentifier(propName) || ts.isStringLiteral(propName)
        ? O.some(propName.text)
        : O.none;
    }),
  );

const collectIdentifierMemberAccesses = (
  sf: ts.SourceFile,
  targetSym: ts.Symbol,
  checker: ts.TypeChecker,
): Readonly<{ readonly accessedNames: ReadonlyArray<string>; readonly escapesWhole: boolean }> => {
  const nodes = collectTsNodes(sf, sf);
  const accessed: Array<string> = [];
  let escapesWhole = false;

  for (const node of nodes) {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      if (checker.getSymbolAtLocation(node.expression) === targetSym) {
        accessed.push(node.name.text);
      }
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      if (checker.getSymbolAtLocation(node.expression) === targetSym) {
        accessed.push(node.argumentExpression.text);
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      if (checker.getSymbolAtLocation(node.initializer) === targetSym) {
        accessed.push(...extractBindingPropNames(node.name));
      }
    } else if (ts.isIdentifier(node)) {
      if (checker.getSymbolAtLocation(node) !== targetSym) continue;
      const parent = node.parent;
      const isDecl =
        (ts.isNamespaceImport(parent) && parent.name === node) ||
        (ts.isImportClause(parent) && parent.name === node);
      const isMemberBase =
        (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
        (ts.isElementAccessExpression(parent) && parent.expression === node) ||
        (ts.isVariableDeclaration(parent) &&
          parent.initializer === node &&
          ts.isObjectBindingPattern(parent.name));
      if (!isDecl && !isMemberBase) {
        escapesWhole = true;
      }
    }
  }
  return { accessedNames: pipe(accessed, RA.uniq(S.Eq)), escapesWhole };
};

const resolveModuleExportByName = (
  moduleSym: ts.Symbol,
  exportName: string,
  checker: ts.TypeChecker,
  lookup: SymbolLookup,
): O.Option<RuntimeExport> => {
  const modExports = checker.getExportsOfModule(moduleSym);
  const found = modExports.find((e) => e.name === exportName);
  return found ? matchSymbolToExport(found, checker, lookup) : O.none;
};

const resolveAllModuleExports = (
  moduleSym: ts.Symbol,
  checker: ts.TypeChecker,
  lookup: SymbolLookup,
): ReadonlyArray<RuntimeExport> =>
  pipe(
    checker.getExportsOfModule(moduleSym),
    RA.filterMap((sym) => matchSymbolToExport(sym, checker, lookup)),
  );

const collectDefaultImportEdges = (
  sf: ts.SourceFile,
  defaultName: ts.Identifier,
  moduleSpecifier: ts.Expression,
  consumerFile: string,
  checker: ts.TypeChecker,
  lookup: SymbolLookup,
): ReadonlyArray<RawImportEdge> => {
  const rawSym = checker.getSymbolAtLocation(defaultName);
  if (!rawSym) return [];
  const directMatch = matchSymbolToExport(rawSym, checker, lookup);
  if (O.isSome(directMatch)) {
    return [{ consumerFile, exportKey: directMatch.value.key }];
  }
  const modSym = resolveModuleSymbolFromSpecifier(moduleSpecifier, checker);
  const targetDeclFile = pipe(
    modSym,
    O.chain((ms) => O.fromNullable(ms.valueDeclaration ?? ms.declarations?.[0])),
    O.map((d) => normalizeFilePath(d.getSourceFile().fileName)),
  );
  if (O.isNone(targetDeclFile)) return [];
  const bagProps = lookup.byFileDefaultProps.get(targetDeclFile.value);
  if (!bagProps) return [];
  const usage = collectIdentifierMemberAccesses(sf, rawSym, checker);
  if (usage.escapesWhole && usage.accessedNames.length === 0) {
    return Array.from(bagProps.values()).map((exp) => ({ consumerFile, exportKey: exp.key }));
  }
  return pipe(
    usage.accessedNames,
    RA.filterMap((prop) => O.fromNullable(bagProps.get(prop))),
    RA.map((exp) => ({ consumerFile, exportKey: exp.key })),
  );
};

const collectNamespaceImportEdges = (
  sf: ts.SourceFile,
  nsBinding: ts.NamespaceImport,
  moduleSpecifier: ts.Expression,
  consumerFile: string,
  checker: ts.TypeChecker,
  lookup: SymbolLookup,
): ReadonlyArray<RawImportEdge> => {
  const nsSym = checker.getSymbolAtLocation(nsBinding.name);
  const modSym = resolveModuleSymbolFromSpecifier(moduleSpecifier, checker);
  if (!nsSym || O.isNone(modSym)) return [];
  const usage = collectIdentifierMemberAccesses(sf, nsSym, checker);
  const accessedEdges = pipe(
    usage.accessedNames,
    RA.filterMap((name) => resolveModuleExportByName(modSym.value, name, checker, lookup)),
    RA.map((exp) => ({ consumerFile, exportKey: exp.key })),
  );
  if (usage.escapesWhole && accessedEdges.length === 0) {
    return pipe(
      resolveAllModuleExports(modSym.value, checker, lookup),
      RA.map((exp) => ({ consumerFile, exportKey: exp.key })),
    );
  }
  return accessedEdges;
};

const collectNamedImportEdges = (
  namedBindings: ts.NamedImports,
  consumerFile: string,
  checker: ts.TypeChecker,
  lookup: SymbolLookup,
): ReadonlyArray<RawImportEdge> =>
  pipe(
    namedBindings.elements,
    RA.filter((spec) => !spec.isTypeOnly),
    RA.filterMap((spec) => {
      const sym = checker.getSymbolAtLocation(spec.name);
      return sym
        ? pipe(
            matchSymbolToExport(sym, checker, lookup),
            O.map((exp) => ({ consumerFile, exportKey: exp.key })),
          )
        : O.none;
    }),
  );

const collectFileImportEdges = (
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  lookup: SymbolLookup,
): ReadonlyArray<RawImportEdge> => {
  const consumerFile = normalizeFilePath(sf.fileName);
  return pipe(
    sf.statements,
    RA.filter(ts.isImportDeclaration),
    RA.filter((decl) => Boolean(decl.importClause && !decl.importClause.isTypeOnly)),
    RA.flatMap((decl) => {
      const clause = decl.importClause;
      if (!clause) return [];
      const defaultEdges = clause.name
        ? collectDefaultImportEdges(sf, clause.name, decl.moduleSpecifier, consumerFile, checker, lookup)
        : [];
      const bindings = clause.namedBindings;
      const namedOrNsEdges = !bindings
        ? []
        : ts.isNamespaceImport(bindings)
          ? collectNamespaceImportEdges(sf, bindings, decl.moduleSpecifier, consumerFile, checker, lookup)
          : collectNamedImportEdges(bindings, consumerFile, checker, lookup);
      return [...defaultEdges, ...namedOrNsEdges];
    }),
  );
};

const computeBaseSymbolData = (program: ts.Program): BaseProgramSymbolData => {
  const checker = program.getTypeChecker();
  const sourceFiles = getProjectSourceFiles(program);
  const barrelFiles = new Set<string>();
  const fileExports: Record<string, ReadonlyArray<RuntimeExport>> = {};
  const lineCounts: Record<string, number> = {};
  const exportByKey: Record<string, RuntimeExport> = {};

  for (const sf of sourceFiles) {
    const fileName = normalizeFilePath(sf.fileName);
    lineCounts[fileName] = sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1;
    if (isBarrelFile(sf)) {
      barrelFiles.add(fileName);
      fileExports[fileName] = [];
    } else {
      const exports = extractFileRuntimeExports(sf, checker);
      fileExports[fileName] = exports;
      for (const exp of exports) {
        exportByKey[exp.key] = exp;
      }
    }
  }

  const lookup = buildSymbolToExportLookup(exportByKey);
  const importEdges = pipe(
    sourceFiles,
    RA.filter((sf) => !barrelFiles.has(normalizeFilePath(sf.fileName))),
    RA.flatMap((sf) => collectFileImportEdges(sf, checker, lookup)),
    RA.filter((edge) => {
      const exp = exportByKey[edge.exportKey];
      return Boolean(exp && exp.fileName !== edge.consumerFile);
    }),
  );

  return { fileExports, barrelFiles, lineCounts, exportByKey, importEdges };
};

const baseSymbolDataCache = new WeakMap<ts.Program, BaseProgramSymbolData>();

const getBaseSymbolData = (program: ts.Program) =>
  memoizeByProgram(program, baseSymbolDataCache, computeBaseSymbolData);

const resolveEntryPointExports = (
  program: ts.Program,
  base: BaseProgramSymbolData,
  entryPoints: ReadonlyArray<string>,
): ReadonlySet<string> => {
  if (entryPoints.length === 0) return new Set();
  const checker = program.getTypeChecker();
  const lookup = buildSymbolToExportLookup(base.exportByKey);
  const result = new Set<string>();

  for (const sf of getProjectSourceFiles(program)) {
    const fileName = normalizeFilePath(sf.fileName);
    if (!isMatchingAnyPattern(fileName, entryPoints)) continue;
    for (const ownExp of base.fileExports[fileName] ?? []) {
      result.add(ownExp.key);
    }
    const modSym = checker.getSymbolAtLocation(sf);
    if (!modSym) continue;
    for (const exp of resolveAllModuleExports(modSym, checker, lookup)) {
      result.add(exp.key);
    }
  }
  return result;
};

const computeProgramSymbolGraph = (
  program: ts.Program,
  entryPoints: ReadonlyArray<string>,
  testPatterns: ReadonlyArray<string>,
): ProgramSymbolGraph => {
  const base = getBaseSymbolData(program);
  const publicEntryPointExports = resolveEntryPointExports(program, base, entryPoints);

  const prodByExportKey = new Map<string, Set<string>>();
  const testByExportKey = new Map<string, Set<string>>();
  const prodImportsByTargetAndConsumer = new Map<string, Map<string, Set<string>>>();

  for (const edge of base.importEdges) {
    const exp = base.exportByKey[edge.exportKey];
    if (!exp) continue;
    const consumerIsTest = isMatchingAnyPattern(edge.consumerFile, testPatterns);
    if (consumerIsTest) {
      const set = testByExportKey.get(edge.exportKey) ?? new Set<string>();
      set.add(edge.consumerFile);
      testByExportKey.set(edge.exportKey, set);
    } else {
      const set = prodByExportKey.get(edge.exportKey) ?? new Set<string>();
      set.add(edge.consumerFile);
      prodByExportKey.set(edge.exportKey, set);

      const byConsumer =
        prodImportsByTargetAndConsumer.get(exp.fileName) ?? new Map<string, Set<string>>();
      const importedSet = byConsumer.get(edge.consumerFile) ?? new Set<string>();
      importedSet.add(exp.exportName);
      byConsumer.set(edge.consumerFile, importedSet);
      prodImportsByTargetAndConsumer.set(exp.fileName, byConsumer);
    }
  }

  const files: Record<string, FileModuleGraph> = {};
  for (const [fileName, runtimeExports] of Object.entries(base.fileExports)) {
    const consumersByExport: Record<string, ModuleConsumerRecord> = {};
    for (const exp of runtimeExports) {
      consumersByExport[exp.exportName] = {
        exportKey: exp.key,
        prodConsumers: Array.from(prodByExportKey.get(exp.key) ?? []).sort(),
        testConsumers: Array.from(testByExportKey.get(exp.key) ?? []).sort(),
      };
    }
    const consumerMap = prodImportsByTargetAndConsumer.get(fileName);
    const prodImportsByConsumer: Record<string, ReadonlyArray<string>> = {};
    if (consumerMap) {
      for (const [consumer, expNames] of consumerMap.entries()) {
        prodImportsByConsumer[consumer] = Array.from(expNames).sort();
      }
    }
    files[fileName] = {
      fileName,
      isBarrel: base.barrelFiles.has(fileName),
      isTest: isMatchingAnyPattern(fileName, testPatterns),
      isEntryPoint: isMatchingAnyPattern(fileName, entryPoints),
      lineCount: base.lineCounts[fileName] ?? 0,
      runtimeExports,
      consumersByExport,
      prodImportsByConsumer,
    };
  }

  return {
    files,
    publicEntryPointExports,
    exportByKey: base.exportByKey,
  };
};

const programSymbolGraphCache = new WeakMap<
  ts.Program,
  Readonly<Record<string, ProgramSymbolGraph>>
>();

export const analyzeModuleSymbolGraph = (
  program: ts.Program,
  entryPoints: ReadonlyArray<string> = [],
  testPatterns: ReadonlyArray<string> = DEFAULT_TEST_PATTERNS,
): ProgramSymbolGraph =>
  memoizeByProgramAndKey(
    program,
    `${entryPoints.join(",")}||${testPatterns.join(",")}`,
    programSymbolGraphCache,
    (p) => computeProgramSymbolGraph(p, entryPoints, testPatterns),
  );
