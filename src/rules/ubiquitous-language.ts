import path from "node:path";
import { AST_NODE_TYPES, ESLintUtils, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as S from "fp-ts/lib/string.js";
import { flow, pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../utils/create-rule.js";
import {
  getProjectSourceFiles,
  memoizeByProgram,
  normalizeFilePath,
  shouldLintDomainFile,
} from "../utils/program-cache.js";
import { collectTsNodes } from "../utils/ts-ast-helpers.js";
import { hasStrictSuffix, isEsTreeAnonymousFunctionNode } from "../utils/type-helpers.js";

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

const contextTermCache = new WeakMap<ts.Program, Readonly<Record<string, ReadonlySet<string>>>>();

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

const getDeclaredNameFromTsNode = (node: ts.Node) =>
  isNamedTsDecl(node) && node.name && ts.isIdentifier(node.name)
    ? O.some(node.name.text)
    : O.none;

const getContextDir = flow(path.dirname, normalizeFilePath);

const extractSfTokens = (sf: ts.SourceFile) =>
  pipe(collectTsNodes(sf, sf), RA.filterMap(getDeclaredNameFromTsNode), RA.flatMap(extractPascalTokens));

const getProgramContextTerms = (program: ts.Program) =>
  memoizeByProgram(program, contextTermCache, (p) => {
    const byDir: Record<string, Set<string>> = {};
    for (const sf of getProjectSourceFiles(p)) {
      const dir = getContextDir(sf.fileName);
      const set = byDir[dir] ?? new Set<string>();
      for (const token of extractSfTokens(sf)) {
        set.add(token);
      }
      byDir[dir] = set;
    }
    return byDir as Readonly<Record<string, ReadonlySet<string>>>;
  });

const findGenericSuffix = (name: string, suffixes: ReadonlyArray<string>) =>
  pipe(suffixes, RA.findFirst((s) => hasStrictSuffix(name, s)));

const findCrudVerb = (name: string, verbs: ReadonlyArray<string>) =>
  pipe(
    verbs,
    RA.findFirst((v) => {
      const nextChar = name.charAt(v.length);
      return name.startsWith(v) && nextChar >= "A" && nextChar <= "Z";
    }),
  );

type SynonymContext = Readonly<{
  readonly contextTerms: ReadonlySet<string>;
  readonly synonymGroups: ReadonlyArray<ReadonlyArray<string>>;
  readonly allowed: ReadonlySet<string>;
}>;

const findGroupConflict = (
  token: string,
  ownTokens: ReadonlySet<string>,
  group: ReadonlyArray<string>,
  ctx: SynonymContext,
) =>
  pipe(
    group,
    RA.filter(
      (term) =>
        term !== token &&
        !ownTokens.has(term) &&
        ctx.contextTerms.has(term) &&
        !ctx.allowed.has(term),
    ),
    RA.uniq(S.Eq),
    (conflicting) =>
      conflicting.length > 0 ? O.some({ token, conflicting: conflicting.join(", ") }) : O.none,
  );

const matchTokenGroupConflict = (
  token: string,
  ownTokens: ReadonlySet<string>,
  ctx: SynonymContext,
) =>
  pipe(
    ctx.synonymGroups,
    RA.findFirst((group) => group.includes(token)),
    O.flatMap((group) => findGroupConflict(token, ownTokens, group, ctx)),
  );

const findSynonymCollision = (name: string, ctx: SynonymContext) => {
  const tokens = extractPascalTokens(name);
  const ownTokens = new Set(tokens);
  return pipe(
    tokens,
    RA.filter((token) => !ctx.allowed.has(token)),
    RA.filterMap((token) => matchTokenGroupConflict(token, ownTokens, ctx)),
    RA.head,
  );
};

const reportGenericAndCrud = (
  id: TSESTree.Identifier,
  symbolKind: SymbolKind,
  repoKind: RepoKind,
  options: Options[0],
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  pipe(
    findGenericSuffix(id.name, options.genericSuffixes),
    O.map((suffix) => { report({ node: id, messageId: "genericSuffix", data: { name: id.name, suffix } }); }),
  );
  match({ symbolKind, repoKind })
    .with({ symbolKind: "function", repoKind: "non-repo" }, () => {
      pipe(
        findCrudVerb(id.name, options.crudVerbs),
        O.map((verb) => { report({ node: id, messageId: "crudVerb", data: { name: id.name, verb } }); }),
      );
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
      pipe(
        findSynonymCollision(id.name, { contextTerms, synonymGroups: options.synonymGroups, allowed }),
        O.map(({ token, conflicting }) => {
          report({ node: id, messageId: "synonymCollision", data: { term: token, conflicting } });
        }),
      );
    })
    .exhaustive();
};

const getDeclaratorKind = (init: O.Option<TSESTree.Expression>) =>
  pipe(init, O.exists(isEsTreeAnonymousFunctionNode)) ? ("function" as const) : ("type" as const);

const getDeclaratorIdentifier = (node: TSESTree.VariableDeclarator) =>
  node.id.type === AST_NODE_TYPES.Identifier ? O.some(node.id) : O.none;

const buildListenerMap = (run: (id: O.Option<TSESTree.Identifier>, symbolKind: SymbolKind) => void) => ({
  TSTypeAliasDeclaration: (node: TSESTree.TSTypeAliasDeclaration) => { run(O.some(node.id), "type"); },
  TSInterfaceDeclaration: (node: TSESTree.TSInterfaceDeclaration) => { run(O.some(node.id), "type"); },
  ClassDeclaration: (node: TSESTree.ClassDeclaration) => { run(O.fromNullable(node.id), "type"); },
  FunctionDeclaration: (node: TSESTree.FunctionDeclaration) => { run(O.fromNullable(node.id), "function"); },
  VariableDeclarator: (node: TSESTree.VariableDeclarator) => {
    pipe(O.fromNullable(node.init), getDeclaratorKind, (kind) => { run(getDeclaratorIdentifier(node), kind); });
  },
});

const buildListeners = (
  contextTerms: ReadonlySet<string>,
  fileName: string,
  options: Options[0],
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) =>
  buildListenerMap((id, symbolKind) => {
    pipe(
      id,
      O.map((node) => {
        checkIdentifier(node, symbolKind, REPO_PATH_RE.test(fileName) ? "repo" : "non-repo", contextTerms, options, report);
      }),
    );
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
          getProgramContextTerms(ESLintUtils.getParserServices(context).program)[
            getContextDir(context.filename)
          ] ?? new Set<string>(),
          context.filename,
          options,
          (d) => { context.report(d); },
        )
      : {},
});
