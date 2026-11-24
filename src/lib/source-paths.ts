import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

export const normalizeFilePath = ((filePath: string) =>
  filePath.replaceAll("\\", "/")) satisfies (filePath: string) => string;

const isNodeModulesPath = (filePath: string) => filePath.includes("/node_modules/");

const isNodeModulesFile = flow(
  (sf: ts.SourceFile) => sf.fileName,
  normalizeFilePath,
  isNodeModulesPath,
);

const isProjectSourceFile = (sf: ts.SourceFile) =>
  !sf.isDeclarationFile && !isNodeModulesFile(sf);

export const collectProjectSourceFiles = flow(
  (program: ts.Program) => program.getSourceFiles(),
  RA.filter(isProjectSourceFile),
);

const escapeRegexMeta = (pattern: string) =>
  pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");

const translateGlobWildcards = (escaped: string) =>
  escaped
    .replaceAll("**/", "__GLOBSTAR_SLASH__")
    .replaceAll("**", "__GLOBSTAR__")
    .replaceAll("*", "[^/]*")
    .replaceAll("__GLOBSTAR_SLASH__", "(?:.*/)?")
    .replaceAll("__GLOBSTAR__", ".*");

const buildAnchoredRegex = (body: string) => new RegExp(`^${body}$`);

const compileGlobPattern = flow(
  normalizeFilePath,
  escapeRegexMeta,
  translateGlobWildcards,
  buildAnchoredRegex,
);

type FilePathPredicate = (filePath: string) => boolean;

const isRegexMatch = (target: string) => {
  const isMatch = (re: RegExp) => re.test(target);
  return isMatch;
};

const isMatchingPattern = (filePath: string) => {
  const isMatch = flow(compileGlobPattern, isRegexMatch(normalizeFilePath(filePath)));
  return isMatch;
};

export const isMatchingAnyPattern = ((patterns: ReadonlyArray<string>) => {
  const isMatch = (filePath: string) => RA.some(isMatchingPattern(filePath))(patterns);
  return isMatch;
}) satisfies (patterns: ReadonlyArray<string>) => FilePathPredicate;

export const shouldLintDomainFile = ((scope: "everywhere" | "domain-only") =>
  (domainPatterns: ReadonlyArray<string>) => {
    const isIncludedFile = (filePath: string) =>
      scope === "everywhere" || isMatchingAnyPattern(domainPatterns)(filePath);
    return isIncludedFile;
  }) satisfies (
  scope: "everywhere" | "domain-only",
) => (domainPatterns: ReadonlyArray<string>) => FilePathPredicate;
