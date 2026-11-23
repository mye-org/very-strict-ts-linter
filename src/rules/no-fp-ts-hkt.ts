import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServices,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../lib/rule-factory.js";
import { normalizeFilePath } from "../lib/source-paths.js";

type MessageIds = "noFpTsHkt";

type CheckerContext = Readonly<{
  services: ParserServicesWithTypeInformation;
  checker: ts.TypeChecker;
}>;

type HktImportIndex = Readonly<{
  directHktLocals: ReadonlySet<string>;
  fpTsRootNamespaces: ReadonlySet<string>;
}>;

type HktCheckContext = Readonly<{
  checkerCtx: O.Option<CheckerContext>;
  imports: HktImportIndex;
}>;

const FP_TS_HKT_SOURCE_RE = /^fp-ts\/(?:(?:lib|es6)\/)?HKT(?:\/index)?(?:\.js)?$/;
const FP_TS_ROOT_SOURCE_RE = /^fp-ts(?:\/(?:lib|es6)(?:\/index(?:\.js)?)?)?$/;
const FP_TS_HKT_FILE_RE = /(?:^|\/)node_modules\/fp-ts\/(?:(?:lib|es6)\/)?HKT\.d\.ts$/;

const FP_TS_HKT_SYMBOLS: ReadonlySet<string> = new Set([
  "HKT",
  "HKT2",
  "HKT3",
  "HKT4",
  "URItoKind",
  "URItoKind2",
  "URItoKind3",
  "URItoKind4",
  "URIS",
  "URIS2",
  "URIS3",
  "URIS4",
  "Kind",
  "Kind2",
  "Kind3",
  "Kind4",
]);

const isFpTsHktSource = (source: string) => FP_TS_HKT_SOURCE_RE.test(source);
const isFpTsRootSource = (source: string) => FP_TS_ROOT_SOURCE_RE.test(source);

const hasTypeProgram = (services: ParserServices): services is ParserServicesWithTypeInformation =>
  Boolean(services.program);

const toCheckerContext = (services: ParserServices) =>
  hasTypeProgram(services)
    ? O.some<CheckerContext>({ services, checker: services.program.getTypeChecker() })
    : O.none;

const isImportDeclaration = (
  stmt: TSESTree.ProgramStatement,
): stmt is TSESTree.ImportDeclaration => stmt.type === AST_NODE_TYPES.ImportDeclaration;

const isNamedHktImportSpecifier = (spec: TSESTree.ImportClause): spec is TSESTree.ImportSpecifier =>
  spec.type === AST_NODE_TYPES.ImportSpecifier &&
  spec.imported.type === AST_NODE_TYPES.Identifier &&
  spec.imported.name === "hkt";

const isNamedHktExportSpecifier = (spec: TSESTree.ExportSpecifier) =>
  spec.local.type === AST_NODE_TYPES.Identifier && spec.local.name === "hkt";

const extractDirectHktLocalNames = (decl: TSESTree.ImportDeclaration) =>
  match({
    isHktModule: isFpTsHktSource(decl.source.value),
    isRootModule: isFpTsRootSource(decl.source.value),
  })
    .with({ isHktModule: true }, () =>
      RA.map((spec: TSESTree.ImportClause) => spec.local.name)(decl.specifiers),
    )
    .with({ isRootModule: true }, () =>
      flow(
        RA.filter(isNamedHktImportSpecifier),
        RA.map((spec: TSESTree.ImportSpecifier) => spec.local.name),
      )(decl.specifiers),
    )
    .with(P._, () => [] as ReadonlyArray<string>)
    .exhaustive();

const extractFpTsRootNamespaces = (decl: TSESTree.ImportDeclaration) =>
  isFpTsRootSource(decl.source.value)
    ? RA.filterMap((spec: TSESTree.ImportClause) =>
        spec.type === AST_NODE_TYPES.ImportNamespaceSpecifier ? O.some(spec.local.name) : O.none,
      )(decl.specifiers)
    : ([] as ReadonlyArray<string>);

const collectHktImports = (body: ReadonlyArray<TSESTree.ProgramStatement>) => {
  const imports = RA.filter(isImportDeclaration)(body);
  return {
    directHktLocals: new Set(RA.flatMap(extractDirectHktLocalNames)(imports)),
    fpTsRootNamespaces: new Set(RA.flatMap(extractFpTsRootNamespaces)(imports)),
  } satisfies HktImportIndex;
};

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive qualified name traversal
const collectEntityNameParts = (entity: TSESTree.EntityName): ReadonlyArray<string> =>
  match(entity)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => [id.name])
    .with({ type: AST_NODE_TYPES.ThisExpression }, () => [] as ReadonlyArray<string>)
    .with({ type: AST_NODE_TYPES.TSQualifiedName }, (q) => [
      ...collectEntityNameParts(q.left),
      q.right.name,
    ])
    .exhaustive();

const resolveLeftmostName = flow(collectEntityNameParts, RA.head<string>);

const startsWithHktQualifier = flow(
  O.flatMap(resolveLeftmostName),
  O.exists((name) => name === "hkt"),
);

const isRootNamespaceHktType = (
  entity: TSESTree.EntityName,
  rootNamespaces: ReadonlySet<string>,
) => {
  const parts = collectEntityNameParts(entity);
  return parts.length >= 2 && rootNamespaces.has(parts[0] ?? "") && parts[1] === "hkt";
};

const resolveAliasedSymbol = (symbol: ts.Symbol, checker: ts.TypeChecker) =>
  symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

const resolveDeclFileName = (decl: ts.Declaration) => decl.getSourceFile().fileName;

const isFpTsHktFilePath = (filePath: string) => FP_TS_HKT_FILE_RE.test(filePath);

const isFpTsPackagePath = (filePath: string) =>
  filePath.includes("/node_modules/fp-ts/") || filePath.startsWith("node_modules/fp-ts/");

const isFpTsHktDeclaration = flow(resolveDeclFileName, normalizeFilePath, isFpTsHktFilePath);

const isFpTsPackageDeclaration = flow(resolveDeclFileName, normalizeFilePath, isFpTsPackagePath);

const hasFpTsHktDeclaration = flow(
  (symbol: ts.Symbol) => symbol.getDeclarations(),
  O.fromNullable,
  O.exists(RA.some(isFpTsHktDeclaration)),
);

const hasFpTsPackageDeclaration = flow(
  (symbol: ts.Symbol) => symbol.getDeclarations(),
  O.fromNullable,
  O.exists(RA.some(isFpTsPackageDeclaration)),
);

const lookupTsNode = (node: TSESTree.Node, ctx: CheckerContext) =>
  O.fromNullable(ctx.services.esTreeNodeToTSNodeMap.get(node));

const lookupSymbolAtTsNode = (ctx: CheckerContext) =>
  flow((tsNode: ts.Node) => ctx.checker.getSymbolAtLocation(tsNode), O.fromNullable);

const resolveTsSymbol = (node: TSESTree.Node, ctx: CheckerContext) =>
  flow(
    O.flatMap(lookupSymbolAtTsNode(ctx)),
    O.map((symbol: ts.Symbol) => resolveAliasedSymbol(symbol, ctx.checker)),
  )(lookupTsNode(node, ctx));

const isFpTsHktTypeSymbol = (symbol: ts.Symbol) =>
  FP_TS_HKT_SYMBOLS.has(symbol.name) && hasFpTsHktDeclaration(symbol);

const isTypeRefFpTsHktByType = (entity: TSESTree.EntityName, ctx: CheckerContext) =>
  O.exists(isFpTsHktTypeSymbol)(resolveTsSymbol(entity, ctx));

const isTypeRefFpTsHkt = (node: TSESTree.TSTypeReference, ctx: HktCheckContext) =>
  !O.exists((rootName: string) => ctx.imports.directHktLocals.has(rootName))(
    resolveLeftmostName(node.typeName),
  ) &&
  ((O.isNone(ctx.checkerCtx) &&
    isRootNamespaceHktType(node.typeName, ctx.imports.fpTsRootNamespaces)) ||
    O.exists((c: CheckerContext) => isTypeRefFpTsHktByType(node.typeName, c))(ctx.checkerCtx));

const isStaticHktMember = (node: TSESTree.MemberExpression) =>
  !node.computed &&
  node.object.type === AST_NODE_TYPES.Identifier &&
  node.property.type === AST_NODE_TYPES.Identifier &&
  node.property.name === "hkt";

const isFpTsHktMemberByType = (node: TSESTree.MemberExpression, ctx: CheckerContext) =>
  O.exists(
    (symbol: ts.Symbol) =>
      hasFpTsHktDeclaration(symbol) ||
      (symbol.name === "hkt" && hasFpTsPackageDeclaration(symbol)),
  )(resolveTsSymbol(node.property, ctx));

const isFpTsHktMemberExpression = (node: TSESTree.MemberExpression, ctx: HktCheckContext) =>
  isStaticHktMember(node) &&
  ((O.isNone(ctx.checkerCtx) &&
    node.object.type === AST_NODE_TYPES.Identifier &&
    ctx.imports.fpTsRootNamespaces.has(node.object.name)) ||
    O.exists((c: CheckerContext) => isFpTsHktMemberByType(node, c))(ctx.checkerCtx));

const isFpTsHktModuleAugmentation = (node: TSESTree.TSModuleDeclaration) =>
  node.id.type === AST_NODE_TYPES.Literal &&
  typeof node.id.value === "string" &&
  isFpTsHktSource(node.id.value);

const isFpTsHktImportType = (node: TSESTree.TSImportType) =>
  isFpTsHktSource(node.source.value) ||
  (isFpTsRootSource(node.source.value) && startsWithHktQualifier(O.fromNullable(node.qualifier)));

const reportWhen = <N extends TSESTree.Node>(
  node: N,
  predicate: Pred.Predicate<N>,
  report: (n: TSESTree.Node) => void,
) => {
  flow(O.some<N>, O.filter(predicate), O.map(report))(node);
};

const checkImportDeclaration = (
  node: TSESTree.ImportDeclaration,
  report: (n: TSESTree.Node) => void,
) => {
  match({
    isHktModule: isFpTsHktSource(node.source.value),
    isRootModule: isFpTsRootSource(node.source.value),
  })
    .with({ isHktModule: true }, () => { report(node); })
    .with({ isRootModule: true }, () => {
      flow(RA.filter(isNamedHktImportSpecifier), RA.map(report))(node.specifiers);
    })
    .with(P._, () => {})
    .exhaustive();
};

const checkExportNamedDeclaration = (
  node: TSESTree.ExportNamedDeclaration,
  report: (n: TSESTree.Node) => void,
) => {
  O.map((source: TSESTree.StringLiteral) => {
    match({
      isHktModule: isFpTsHktSource(source.value),
      isRootModule: isFpTsRootSource(source.value),
    })
      .with({ isHktModule: true }, () => { report(node); })
      .with({ isRootModule: true }, () => {
        flow(RA.filter(isNamedHktExportSpecifier), RA.map(report))(node.specifiers);
      })
      .with(P._, () => {})
      .exhaustive();
  })(O.fromNullable(node.source));
};

const buildHktListeners = (
  ctx: HktCheckContext,
  report: (node: TSESTree.Node) => void,
) =>
  ({
    ImportDeclaration: (n) => { checkImportDeclaration(n, report); },
    ExportNamedDeclaration: (n) => { checkExportNamedDeclaration(n, report); },
    ExportAllDeclaration: (n) => { reportWhen(n, (e) => isFpTsHktSource(e.source.value), report); },
    TSModuleDeclaration: (n) => { reportWhen(n, isFpTsHktModuleAugmentation, report); },
    TSImportType: (n) => { reportWhen(n, isFpTsHktImportType, report); },
    TSTypeReference: (n) => { reportWhen(n, (r) => isTypeRefFpTsHkt(r, ctx), report); },
    MemberExpression: (n) => { reportWhen(n, (m) => isFpTsHktMemberExpression(m, ctx), report); },
  }) satisfies TSESLint.RuleListener;

const extractProgramStatements = (sourceCode: Readonly<TSESLint.SourceCode>) =>
  sourceCode.ast.body;

export const noFpTsHkt = createRule<[], MessageIds>({
  name: "no-fp-ts-hkt",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow `fp-ts` Higher-Kinded Types (`fp-ts/HKT`, `HKT`, `Kind`, `URIS`, `URItoKind`); prefer concrete data types and ordinary generics.",
    },
    messages: {
      noFpTsHkt:
        "Avoid `fp-ts` Higher-Kinded Types (`HKT`, `Kind`, `URIS`, `URItoKind`). Use concrete `fp-ts` data types and ordinary generics instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) =>
    buildHktListeners(
      {
        checkerCtx: toCheckerContext(ESLintUtils.getParserServices(context, true)),
        imports: collectHktImports(extractProgramStatements(context.sourceCode)),
      },
      (node) => { context.report({ node, messageId: "noFpTsHkt" }); },
    ),
});
