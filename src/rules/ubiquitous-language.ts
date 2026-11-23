import path from "node:path";
import { AST_NODE_TYPES, ESLintUtils, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as S from "fp-ts/lib/string.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { isEsTreeAnonymousFunctionNode } from "../lib/estree-function-nodes.js";
import { memoizeByProgram } from "../lib/program-memo.js";
import { createRule } from "../lib/rule-factory.js";
import { collectProjectSourceFiles, normalizeFilePath, shouldLintDomainFile } from "../lib/source-paths.js";
import { hasStrictSuffix } from "../lib/string-suffix.js";
import { collectTsNodes } from "../lib/ts-node-traversal.js";

// eslint-disable-next-line strict-fp/prefer-union-over-boolean -- ESLint rule JSON schema boolean option
type ScopeFlag = boolean;

type Options = [
  Readonly<
    Record<"enforceEverywhere", ScopeFlag> & {
      readonly domainPatterns: ReadonlyArray<string>;
      readonly genericSuffixes: ReadonlyArray<string>;
      readonly crudVerbs: ReadonlyArray<string>;
      readonly synonymGroups: ReadonlyArray<ReadonlyArray<string>>;
      readonly allowedTerms: ReadonlyArray<string>;
    }
  >,
];
type MessageIds = "genericSuffix" | "crudVerb" | "synonymCollision";
type SymbolKind = "function" | "type";
type RepoKind = "repo" | "non-repo";
type ContextTermsByDir = Readonly<Record<string, ReadonlySet<string>>>;

const DEFAULT_DOMAIN_PATTERNS = ["**/domain/**", "**/domains/**", "**/application/**"];
const DEFAULT_GENERIC_SUFFIXES = ["Manager", "Helper", "Processor", "Utils", "Util", "Data", "Info", "Handler"];
const DEFAULT_CRUD_VERBS = ["create", "update", "get", "delete", "set", "fetch"];
const DEFAULT_SYNONYM_GROUPS = [
  ["Client", "Customer", "Tenant"],
  ["Account", "Member", "User"],
  ["Order", "Purchase", "Basket"],
];
const REPO_PATH_RE = /(repository|repositories|repo|adapter|infra)/i;
const PASCAL_TOKEN_RE = /[A-Z][a-z0-9]+/g;

const contextTermCache = new WeakMap<ts.Program, ContextTermsByDir>();

const extractPascalTokens = (name: string) => name.match(PASCAL_TOKEN_RE) ?? [];

const isNamedTsDecl = (
  node: ts.Node,
): node is
  | ts.TypeAliasDeclaration
  | ts.InterfaceDeclaration
  | ts.ClassDeclaration
  | ts.FunctionDeclaration
  | ts.VariableDeclaration =>
  ts.isTypeAliasDeclaration(node) ||
  ts.isInterfaceDeclaration(node) ||
  ts.isClassDeclaration(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isVariableDeclaration(node);

const extractDeclaredTsName = (node: ts.Node) =>
  isNamedTsDecl(node) && node.name && ts.isIdentifier(node.name)
    ? O.some(node.name.text)
    : O.none;

const resolveContextDir = flow(path.dirname, normalizeFilePath);

const extractSfTokens = (sf: ts.SourceFile) =>
  flow(collectTsNodes, RA.filterMap(extractDeclaredTsName), RA.flatMap(extractPascalTokens))(sf, sf);

const mergeSourceFileTerms = (acc: ContextTermsByDir, sf: ts.SourceFile) => {
  const dir = resolveContextDir(sf.fileName);
  return {
    ...acc,
    [dir]: new Set([...(acc[dir] ?? []), ...extractSfTokens(sf)]),
  };
};

const buildContextTermsByDir = flow(
  collectProjectSourceFiles,
  RA.reduce<ts.SourceFile, ContextTermsByDir>({}, mergeSourceFileTerms),
);

const indexProgramContextTerms = (program: ts.Program) =>
  memoizeByProgram(program, contextTermCache, buildContextTermsByDir);

const findGenericSuffix = (name: string, suffixes: ReadonlyArray<string>) =>
  RA.findFirst((s: string) => hasStrictSuffix(name, s))(suffixes);

const findCrudVerb = (name: string, verbs: ReadonlyArray<string>) =>
  RA.findFirst((v: string) => {
    const nextChar = name.charAt(v.length);
    return name.startsWith(v) && nextChar >= "A" && nextChar <= "Z";
  })(verbs);

type SynonymContext = Readonly<{
  readonly contextTerms: ReadonlySet<string>;
  readonly synonymGroups: ReadonlyArray<ReadonlyArray<string>>;
  readonly allowed: ReadonlySet<string>;
}>;

const formatConflictingTerms = (token: string) =>
  RA.match(
    () => O.none,
    (nonEmpty: ReadonlyArray<string>) => O.some({ token, conflicting: nonEmpty.join(", ") }),
  );

const findGroupConflict = (
  token: string,
  ownTokens: ReadonlySet<string>,
  group: ReadonlyArray<string>,
  ctx: SynonymContext,
) =>
  flow(
    RA.filter(
      (term: string) =>
        term !== token &&
        !ownTokens.has(term) &&
        ctx.contextTerms.has(term) &&
        !ctx.allowed.has(term),
    ),
    RA.uniq(S.Eq),
    formatConflictingTerms(token),
  )(group);

const matchTokenGroupConflict = (
  token: string,
  ownTokens: ReadonlySet<string>,
  ctx: SynonymContext,
) =>
  flow(
    RA.findFirst((group: ReadonlyArray<string>) => group.includes(token)),
    O.flatMap((group) => findGroupConflict(token, ownTokens, group, ctx)),
  )(ctx.synonymGroups);

const findCollisionForTokens = (
  tokens: ReadonlyArray<string>,
  ownTokens: ReadonlySet<string>,
  ctx: SynonymContext,
) =>
  flow(
    RA.filter((token: string) => !ctx.allowed.has(token)),
    RA.filterMap((token) => matchTokenGroupConflict(token, ownTokens, ctx)),
    RA.head,
  )(tokens);

const findSynonymCollision = (name: string, ctx: SynonymContext) => {
  const tokens = extractPascalTokens(name);
  return findCollisionForTokens(tokens, new Set(tokens), ctx);
};

const reportGenericAndCrud = (
  id: TSESTree.Identifier,
  symbolKind: SymbolKind,
  repoKind: RepoKind,
  options: Options[0],
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  O.map((suffix: string) => {
    report({ node: id, messageId: "genericSuffix", data: { name: id.name, suffix } });
  })(findGenericSuffix(id.name, options.genericSuffixes));
  match({ symbolKind, repoKind })
    .with({ symbolKind: "function", repoKind: "non-repo" }, () => {
      O.map((verb: string) => {
        report({ node: id, messageId: "crudVerb", data: { name: id.name, verb } });
      })(findCrudVerb(id.name, options.crudVerbs));
    })
    .otherwise(() => {});
};

const checkIdentifier = (
  id: TSESTree.Identifier,
  symbolKind: SymbolKind,
  repoKind: RepoKind,
  contextTerms: ReadonlySet<string>,
  options: Options[0],
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  const allowed = new Set(options.allowedTerms);
  match(allowed.has(id.name))
    .with(true, () => {})
    .with(false, () => {
      reportGenericAndCrud(id, symbolKind, repoKind, options, report);
      O.map(({ token, conflicting }: Readonly<Record<"token" | "conflicting", string>>) => {
        report({ node: id, messageId: "synonymCollision", data: { term: token, conflicting } });
      })(findSynonymCollision(id.name, { contextTerms, synonymGroups: options.synonymGroups, allowed }));
    })
    .exhaustive();
};

const resolveDeclaratorKind = (node: TSESTree.VariableDeclarator) =>
  O.exists(isEsTreeAnonymousFunctionNode)(O.fromNullable(node.init))
    ? ("function" as const)
    : ("type" as const);

const extractDeclaratorIdentifier = (node: TSESTree.VariableDeclarator) =>
  node.id.type === AST_NODE_TYPES.Identifier ? O.some(node.id) : O.none;

const classifyRepoKind = (fileName: string) =>
  REPO_PATH_RE.test(fileName) ? ("repo" as const) : ("non-repo" as const);

const buildListenerMap = (run: (id: O.Option<TSESTree.Identifier>, symbolKind: SymbolKind) => void) => ({
  TSTypeAliasDeclaration: (node: TSESTree.TSTypeAliasDeclaration) => { run(O.some(node.id), "type"); },
  TSInterfaceDeclaration: (node: TSESTree.TSInterfaceDeclaration) => { run(O.some(node.id), "type"); },
  ClassDeclaration: (node: TSESTree.ClassDeclaration) => { run(O.fromNullable(node.id), "type"); },
  FunctionDeclaration: (node: TSESTree.FunctionDeclaration) => { run(O.fromNullable(node.id), "function"); },
  VariableDeclarator: (node: TSESTree.VariableDeclarator) => {
    run(extractDeclaratorIdentifier(node), resolveDeclaratorKind(node));
  },
});

const buildListeners = (
  contextTerms: ReadonlySet<string>,
  fileName: string,
  options: Options[0],
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) =>
  buildListenerMap((id, symbolKind) => {
    O.map((node: TSESTree.Identifier) => {
      checkIdentifier(node, symbolKind, classifyRepoKind(fileName), contextTerms, options, report);
    })(id);
  });

export const ubiquitousLanguage = createRule<Options, MessageIds>({
  name: "ubiquitous-language",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Enforce Ubiquitous Language in domain and application layers by flagging generic technical suffixes, CRUD verbs on domain functions, and synonym collisions.",
    },
    messages: {
      genericSuffix:
        "Avoid generic technical name `{{name}}` (`*{{suffix}}`). Use an explicit domain concept from your Ubiquitous Language.",
      crudVerb:
        "Avoid CRUD-style verb `{{verb}}` in domain/application name `{{name}}`. Prefer an intention-revealing business verb.",
      synonymCollision:
        "Synonym collision: `{{term}}` coexists with [{{conflicting}}] in the same bounded context. Standardize on a single Ubiquitous Language term.",
    },
    schema: [
      {
        type: "object",
        properties: {
          enforceEverywhere: { type: "boolean" },
          domainPatterns: { type: "array", items: { type: "string" } },
          genericSuffixes: { type: "array", items: { type: "string" } },
          crudVerbs: { type: "array", items: { type: "string" } },
          synonymGroups: { type: "array", items: { type: "array", items: { type: "string" } } },
          allowedTerms: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        enforceEverywhere: false,
        domainPatterns: DEFAULT_DOMAIN_PATTERNS,
        genericSuffixes: DEFAULT_GENERIC_SUFFIXES,
        crudVerbs: DEFAULT_CRUD_VERBS,
        synonymGroups: DEFAULT_SYNONYM_GROUPS,
        allowedTerms: [],
      },
    ],
  },
  create: (context, [options]) =>
    shouldLintDomainFile(
      options.enforceEverywhere ? "everywhere" : "domain-only",
      context.filename,
      options.domainPatterns,
    )
      ? buildListeners(
          indexProgramContextTerms(ESLintUtils.getParserServices(context).program)[
            resolveContextDir(context.filename)
          ] ?? new Set<string>(),
          context.filename,
          options,
          (d) => { context.report(d); },
        )
      : {},
});
