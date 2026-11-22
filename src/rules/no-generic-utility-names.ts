import path from "node:path";
import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import { normalizeFilePath } from "../utils/program-cache.js";

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
  pipe(
    raw.match(WORD_TOKEN_RE) ?? [],
    RA.map((token) => token.toLowerCase()),
  );

const stripFileExtensions = (fileName: string) =>
  fileName.replace(FILE_EXT_RE, "").replace(SECONDARY_SUFFIX_RE, "");

const matchBannedToken = (token: O.Option<string>, bannedSet: ReadonlySet<string>) =>
  pipe(token, O.filter((t) => bannedSet.has(t)));

const findSuffixBannedTerm = (raw: string, bannedSet: ReadonlySet<string>) =>
  pipe(raw, splitWordTokens, RA.last, (token) => matchBannedToken(token, bannedSet));

const findEdgeBannedTerm = (raw: string, bannedSet: ReadonlySet<string>) => {
  const tokens = splitWordTokens(raw);
  return pipe(
    matchBannedToken(RA.last(tokens), bannedSet),
    O.alt(() => matchBannedToken(RA.head(tokens), bannedSet)),
  );
};

const toNormalizedRelativePath = (location: FileLocation) => {
  const rel = normalizeFilePath(path.relative(location.cwd, location.filename));
  return rel !== ".." && !rel.startsWith("../")
    ? rel
    : normalizeFilePath(location.filename).replace(/^(?:[A-Za-z]:)?\/+/, "");
};

const resolveInspectablePath = (location: FileLocation) =>
  path.isAbsolute(location.filename)
    ? toNormalizedRelativePath(location)
    : normalizeFilePath(location.filename);

const splitInspectableSegments = (location: FileLocation) =>
  VIRTUAL_FILENAMES.has(location.filename)
    ? O.none
    : pipe(
        resolveInspectablePath(location).split("/"),
        RA.filter((segment) => !IGNORED_PATH_SEGMENTS.has(segment)),
        O.fromPredicate((segments) => segments.length > 0 && !segments.includes("node_modules")),
      );

const matchBannedDirectory = (directory: string, cfg: RuleCheckConfig) =>
  pipe(
    findEdgeBannedTerm(directory, cfg.bannedSet),
    O.map((term) => ({ directory, term })),
  );

const findBannedDirectory = (directories: ReadonlyArray<string>, cfg: RuleCheckConfig) =>
  pipe(
    directories,
    RA.filter((dir) => !cfg.allowedSet.has(dir)),
    RA.filterMap((dir) => matchBannedDirectory(dir, cfg)),
    RA.head,
  );

const isAllowedFile = (fileName: string, stem: string, allowedSet: ReadonlySet<string>) =>
  allowedSet.has(fileName) || allowedSet.has(stem);

const findBannedFileName = (fileName: string, cfg: RuleCheckConfig) => {
  const stem = stripFileExtensions(fileName);
  return isAllowedFile(fileName, stem, cfg.allowedSet)
    ? O.none
    : pipe(
        findEdgeBannedTerm(stem, cfg.bannedSet),
        O.map((term) => ({ fileName, term })),
      );
};

const checkDirectoryNames = (
  program: TSESTree.Program,
  segments: ReadonlyArray<string>,
  cfg: RuleCheckConfig,
) => {
  match(cfg.directoryNames)
    .with("check", () => {
      pipe(
        RA.init(segments),
        O.flatMap((dirs) => findBannedDirectory(dirs, cfg)),
        O.map(({ directory, term }) => {
          cfg.report({ node: program, messageId: "genericDirectoryName", data: { directory, term } });
        }),
      );
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
      pipe(
        RA.last(segments),
        O.flatMap((fileName) => findBannedFileName(fileName, cfg)),
        O.map(({ fileName, term }) => {
          cfg.report({ node: program, messageId: "genericFileName", data: { fileName, term } });
        }),
      );
    })
    .with("skip", () => {})
    .exhaustive();
};

const checkProgramPath = (
  program: TSESTree.Program,
  location: FileLocation,
  cfg: RuleCheckConfig,
) => {
  pipe(
    splitInspectableSegments(location),
    O.map((segments) => {
      checkDirectoryNames(program, segments, cfg);
      checkFileName(program, segments, cfg);
    }),
  );
};

const reportIfBannedIdentifier = (id: TSESTree.Identifier, cfg: RuleCheckConfig) => {
  pipe(
    findSuffixBannedTerm(id.name, cfg.bannedSet),
    O.map((term) => {
      cfg.report({ node: id, messageId: "genericIdentifierName", data: { name: id.name, term } });
    }),
  );
};

const checkIdentifierNode = (id: TSESTree.Identifier, cfg: RuleCheckConfig) => {
  match(cfg.allowedSet.has(id.name))
    .with(true, () => {})
    .with(false, () => { reportIfBannedIdentifier(id, cfg); })
    .exhaustive();
};

const checkOptionalIdentifier = (id: O.Option<TSESTree.Identifier>, cfg: RuleCheckConfig) => {
  pipe(id, O.map((node) => { checkIdentifierNode(node, cfg); }));
};

const getIdentifierIfPresent = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.Identifier ? O.some(node) : O.none;

const getExportedAliasIdentifier = (node: TSESTree.ExportSpecifier) =>
  node.exported.type === AST_NODE_TYPES.Identifier &&
  (node.local.type !== AST_NODE_TYPES.Identifier || node.exported.name !== node.local.name)
    ? O.some(node.exported)
    : O.none;

const buildIdentifierListeners = (cfg: RuleCheckConfig) => ({
  TSTypeAliasDeclaration: (node: TSESTree.TSTypeAliasDeclaration) => { checkIdentifierNode(node.id, cfg); },
  TSInterfaceDeclaration: (node: TSESTree.TSInterfaceDeclaration) => { checkIdentifierNode(node.id, cfg); },
  ClassDeclaration: (node: TSESTree.ClassDeclaration) => { checkOptionalIdentifier(O.fromNullable(node.id), cfg); },
  FunctionDeclaration: (node: TSESTree.FunctionDeclaration) => { checkOptionalIdentifier(O.fromNullable(node.id), cfg); },
  TSModuleDeclaration: (node: TSESTree.TSModuleDeclaration) => { checkOptionalIdentifier(getIdentifierIfPresent(node.id), cfg); },
  VariableDeclarator: (node: TSESTree.VariableDeclarator) => { checkOptionalIdentifier(getIdentifierIfPresent(node.id), cfg); },
  ImportNamespaceSpecifier: (node: TSESTree.ImportNamespaceSpecifier) => { checkIdentifierNode(node.local, cfg); },
  ExportSpecifier: (node: TSESTree.ExportSpecifier) => { checkOptionalIdentifier(getExportedAliasIdentifier(node), cfg); },
});

const buildListeners = (location: FileLocation, cfg: RuleCheckConfig) => ({
  Program: (node: TSESTree.Program) => { checkProgramPath(node, location, cfg); },
  ...(cfg.identifiers === "check" ? buildIdentifierListeners(cfg) : {}),
});

const toLowerSet = (items: ReadonlyArray<string>) =>
  new Set(pipe(items, RA.map((item) => item.toLowerCase())));

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
