import path from "node:path";
import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";
import { normalizeFilePath } from "../lib/source-paths.js";

type CheckTarget = "file" | "directory" | "identifier";

type Options = [
  Readonly<{
    readonly bannedTerms: ReadonlyArray<string>;
    readonly allowedNames: ReadonlyArray<string>;
    readonly targets: ReadonlyArray<CheckTarget>;
  }>,
];

type MessageIds = "genericFileName" | "genericDirectoryName" | "genericIdentifierName";
type CheckMode = "check" | "skip";

type FileLocation = Readonly<Record<"filename" | "cwd", string>>;

type RuleCheckConfig = Readonly<{
  readonly bannedSet: ReadonlySet<string>;
  readonly allowedSet: ReadonlySet<string>;
  readonly fileNames: CheckMode;
  readonly directoryNames: CheckMode;
  readonly identifiers: CheckMode;
  readonly report: (d: TSESLint.ReportDescriptor<MessageIds>) => void;
}>;

const DEFAULT_BANNED_TERMS = [
  "helper",
  "helpers",
  "util",
  "utils",
  "utility",
  "utilities",
  "common",
  "misc",
  "miscellaneous",
] as const;

const DEFAULT_TARGETS = ["file", "directory", "identifier"] as const satisfies ReadonlyArray<CheckTarget>;

const WORD_TOKEN_RE = /[A-Z]+(?=[A-Z][a-z]|[^A-Za-z]|$)|[A-Z]?[a-z]+/g;
const FILE_EXT_RE = /\.(?:[cm]?[tj]sx?)$/i;
const SECONDARY_SUFFIX_RE = /\.(?:d|test|spec|stories|story|mock|fixture)$/i;
const VIRTUAL_FILENAMES = new Set(["", "<input>", "<text>"]);
const IGNORED_PATH_SEGMENTS = new Set(["", ".", ".."]);

const splitWordTokens = (raw: string) =>
  RA.map((token: string) => token.toLowerCase())(raw.match(WORD_TOKEN_RE) ?? []);

const stripFileExtensions = (fileName: string) =>
  fileName.replace(FILE_EXT_RE, "").replace(SECONDARY_SUFFIX_RE, "");

const matchBannedToken = (token: O.Option<string>, bannedSet: ReadonlySet<string>) =>
  O.filter((t: string) => bannedSet.has(t))(token);

const findSuffixBannedTerm = (raw: string, bannedSet: ReadonlySet<string>) =>
  flow(splitWordTokens, RA.last, (token) => matchBannedToken(token, bannedSet))(raw);

const findEdgeBannedTerm = (raw: string, bannedSet: ReadonlySet<string>) => {
  const tokens = splitWordTokens(raw);
  return flow(
    (t: O.Option<string>) => matchBannedToken(t, bannedSet),
    O.alt(() => matchBannedToken(RA.head(tokens), bannedSet)),
  )(RA.last(tokens));
};

const isWithinWorkingTree = (rel: string) => rel !== ".." && !rel.startsWith("../");

const stripRootPrefix = (normalized: string) => normalized.replace(/^(?:[A-Za-z]:)?\/+/, "");

const toNormalizedRelativePath = (location: FileLocation) => {
  const rel = normalizeFilePath(path.relative(location.cwd, location.filename));
  return isWithinWorkingTree(rel) ? rel : stripRootPrefix(normalizeFilePath(location.filename));
};

const resolveInspectablePath = (location: FileLocation) =>
  path.isAbsolute(location.filename)
    ? toNormalizedRelativePath(location)
    : normalizeFilePath(location.filename);

const splitPathSegments = (normalizedPath: string) => normalizedPath.split("/");

const isInspectableSegmentList = (segments: ReadonlyArray<string>) =>
  segments.length > 0 && !segments.includes("node_modules");

const splitInspectableSegments = (location: FileLocation) =>
  VIRTUAL_FILENAMES.has(location.filename)
    ? O.none
    : flow(
        resolveInspectablePath,
        splitPathSegments,
        RA.filter((segment) => !IGNORED_PATH_SEGMENTS.has(segment)),
        O.fromPredicate(isInspectableSegmentList),
      )(location);

const matchBannedDirectory = (directory: string, cfg: RuleCheckConfig) =>
  flow(
    (dir: string) => findEdgeBannedTerm(dir, cfg.bannedSet),
    O.map((term) => ({ directory, term })),
  )(directory);

const findBannedDirectory = (directories: ReadonlyArray<string>, cfg: RuleCheckConfig) =>
  flow(
    RA.filterMap((dir: string) => (cfg.allowedSet.has(dir) ? O.none : matchBannedDirectory(dir, cfg))),
    RA.head,
  )(directories);

const isAllowedFile = (fileName: string, stem: string, allowedSet: ReadonlySet<string>) =>
  allowedSet.has(fileName) || allowedSet.has(stem);

const findBannedFileName = (fileName: string, cfg: RuleCheckConfig) => {
  const stem = stripFileExtensions(fileName);
  return isAllowedFile(fileName, stem, cfg.allowedSet)
    ? O.none
    : flow(
        (s: string) => findEdgeBannedTerm(s, cfg.bannedSet),
        O.map((term) => ({ fileName, term })),
      )(stem);
};

const checkDirectoryNames = (
  program: TSESTree.Program,
  segments: ReadonlyArray<string>,
  cfg: RuleCheckConfig,
) => {
  match(cfg.directoryNames)
    .with("check", () => {
      flow(
        RA.init<string>,
        O.flatMap((dirs) => findBannedDirectory(dirs, cfg)),
        O.map(({ directory, term }) => {
          cfg.report({ node: program, messageId: "genericDirectoryName", data: { directory, term } });
        }),
      )(segments);
    })
    .with("skip", () => {})
    .exhaustive();
};

const checkFileName = (
  program: TSESTree.Program,
  segments: ReadonlyArray<string>,
  cfg: RuleCheckConfig,
) => {
  match(cfg.fileNames)
    .with("check", () => {
      flow(
        RA.last<string>,
        O.flatMap((fileName) => findBannedFileName(fileName, cfg)),
        O.map(({ fileName, term }) => {
          cfg.report({ node: program, messageId: "genericFileName", data: { fileName, term } });
        }),
      )(segments);
    })
    .with("skip", () => {})
    .exhaustive();
};

const checkProgramPath = (
  program: TSESTree.Program,
  location: FileLocation,
  cfg: RuleCheckConfig,
) => {
  flow(
    splitInspectableSegments,
    O.map((segments) => {
      checkDirectoryNames(program, segments, cfg);
      checkFileName(program, segments, cfg);
    }),
  )(location);
};

const reportIfBannedIdentifier = (id: TSESTree.Identifier, cfg: RuleCheckConfig) => {
  flow(
    (name: string) => findSuffixBannedTerm(name, cfg.bannedSet),
    O.map((term) => {
      cfg.report({ node: id, messageId: "genericIdentifierName", data: { name: id.name, term } });
    }),
  )(id.name);
};

const checkIdentifierNode = (id: TSESTree.Identifier, cfg: RuleCheckConfig) => {
  match(cfg.allowedSet.has(id.name))
    .with(true, () => {})
    .with(false, () => { reportIfBannedIdentifier(id, cfg); })
    .exhaustive();
};

const checkOptionalIdentifier = (id: O.Option<TSESTree.Identifier>, cfg: RuleCheckConfig) => {
  O.map((node: TSESTree.Identifier) => { checkIdentifierNode(node, cfg); })(id);
};

const extractIdentifierIfPresent = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.Identifier ? O.some(node) : O.none;

const extractExportedAliasIdentifier = (node: TSESTree.ExportSpecifier) =>
  node.exported.type === AST_NODE_TYPES.Identifier &&
  (node.local.type !== AST_NODE_TYPES.Identifier || node.exported.name !== node.local.name)
    ? O.some(node.exported)
    : O.none;

const buildIdentifierListeners = (cfg: RuleCheckConfig) => ({
  TSTypeAliasDeclaration: (node: TSESTree.TSTypeAliasDeclaration) => { checkIdentifierNode(node.id, cfg); },
  TSInterfaceDeclaration: (node: TSESTree.TSInterfaceDeclaration) => { checkIdentifierNode(node.id, cfg); },
  ClassDeclaration: (node: TSESTree.ClassDeclaration) => { checkOptionalIdentifier(O.fromNullable(node.id), cfg); },
  FunctionDeclaration: (node: TSESTree.FunctionDeclaration) => { checkOptionalIdentifier(O.fromNullable(node.id), cfg); },
  TSModuleDeclaration: (node: TSESTree.TSModuleDeclaration) => { checkOptionalIdentifier(extractIdentifierIfPresent(node.id), cfg); },
  VariableDeclarator: (node: TSESTree.VariableDeclarator) => { checkOptionalIdentifier(extractIdentifierIfPresent(node.id), cfg); },
  ImportNamespaceSpecifier: (node: TSESTree.ImportNamespaceSpecifier) => { checkIdentifierNode(node.local, cfg); },
  ExportSpecifier: (node: TSESTree.ExportSpecifier) => { checkOptionalIdentifier(extractExportedAliasIdentifier(node), cfg); },
});

const buildListeners = (location: FileLocation, cfg: RuleCheckConfig) => ({
  Program: (node: TSESTree.Program) => { checkProgramPath(node, location, cfg); },
  ...(cfg.identifiers === "check" ? buildIdentifierListeners(cfg) : {}),
});

const toLowerSet = (items: ReadonlyArray<string>) =>
  new Set(RA.map((item: string) => item.toLowerCase())(items));

const toTargetMode = (targets: ReadonlySet<CheckTarget>, target: CheckTarget) =>
  targets.has(target) ? ("check" as const) : ("skip" as const);

const buildRuleConfig = (
  options: Options[0],
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  const targetSet = new Set(options.targets);
  return {
    bannedSet: toLowerSet(options.bannedTerms),
    allowedSet: new Set(options.allowedNames),
    fileNames: toTargetMode(targetSet, "file"),
    directoryNames: toTargetMode(targetSet, "directory"),
    identifiers: toTargetMode(targetSet, "identifier"),
    report,
  };
};

export const noGenericUtilityNames = createRule<Options, MessageIds>({
  name: "no-generic-utility-names",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow generic junk-drawer file, directory, and symbol names like `*helper`, `*utils`, `*common`, or `*misc`; name modules and symbols by concrete capability or domain concept.",
    },
    messages: {
      genericFileName:
        "Avoid generic junk-drawer file name `{{fileName}}` (matched `{{term}}`). Name modules by what they do or the domain concept they own (e.g., `date-formatting.ts`, `user-validation.ts`, `retry.ts`, `factories.ts`).",
      genericDirectoryName:
        "Avoid generic junk-drawer directory `{{directory}}` (matched `{{term}}`). Group cohesive modules by capability or domain concept (e.g., `lib/formatting`, `lib/crypto`, `lib/collections`).",
      genericIdentifierName:
        "Avoid generic junk-drawer name `{{name}}` (matched `{{term}}`). Name symbols by their concrete intent or move behavior closer to the data it operates on.",
    },
    schema: [
      {
        type: "object",
        properties: {
          bannedTerms: { type: "array", items: { type: "string" } },
          allowedNames: { type: "array", items: { type: "string" } },
          targets: {
            type: "array",
            items: { type: "string", enum: ["file", "directory", "identifier"] },
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        bannedTerms: [...DEFAULT_BANNED_TERMS],
        allowedNames: [],
        targets: [...DEFAULT_TARGETS],
      },
    ],
  },
  create: (context, [options]) =>
    buildListeners(
      { filename: context.filename, cwd: context.cwd },
      buildRuleConfig(options, (d) => { context.report(d); }),
    ),
});
