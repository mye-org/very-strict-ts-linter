import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

export const normalizeFilePath = (filePath: string): string => filePath.replaceAll("\\", "/");

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

const isRegexMatch = (re: RegExp, target: string) => re.test(target);

const isMatchingPattern = (filePath: string, pattern: string) =>
  isRegexMatch(compileGlobPattern(pattern), normalizeFilePath(filePath));

export const isMatchingAnyPattern = (
  filePath: string,
  patterns: ReadonlyArray<string>,
): boolean => RA.some((pattern: string) => isMatchingPattern(filePath, pattern))(patterns);

type FilePathPredicate = (filePath: string) => boolean;

export const shouldLintDomainFile = (
  scope: "everywhere" | "domain-only",
  domainPatterns: ReadonlyArray<string>,
): FilePathPredicate => {
  const isIncludedFile = (filePath: string) =>
    scope === "everywhere" || isMatchingAnyPattern(filePath, domainPatterns);
  return isIncludedFile;
};
