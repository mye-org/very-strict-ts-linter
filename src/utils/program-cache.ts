import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import * as ts from "typescript";

const computeAndStore = <A>(
  program: ts.Program,
  cache: WeakMap<ts.Program, A>,
  compute: (p: ts.Program) => A,
) => {
  const value = compute(program);
  cache.set(program, value);
  return value;
};

export const memoizeByProgram = <A>(
  program: ts.Program,
  cache: WeakMap<ts.Program, A>,
  compute: (p: ts.Program) => A,
) =>
  pipe(
    O.fromNullable(cache.get(program)),
    O.getOrElse(() => computeAndStore(program, cache, compute)),
  );

const computeAndStoreKeyed = <A>(
  program: ts.Program,
  key: string,
  cache: WeakMap<ts.Program, Readonly<Record<string, A>>>,
  existing: Readonly<Record<string, A>>,
  compute: (p: ts.Program) => A,
) => {
  const value = compute(program);
  cache.set(program, { ...existing, [key]: value });
  return value;
};

export const memoizeByProgramAndKey = <A>(
  program: ts.Program,
  key: string,
  cache: WeakMap<ts.Program, Readonly<Record<string, A>>>,
  compute: (p: ts.Program) => A,
) => {
  const existing = cache.get(program) ?? {};
  return pipe(
    O.fromNullable(existing[key]),
    O.getOrElse(() => computeAndStoreKeyed(program, key, cache, existing, compute)),
  );
};

export const normalizeFilePath = (filePath: string) => filePath.replace(/\\/g, "/");

export const isProjectSourceFile = (sf: ts.SourceFile) =>
  !sf.isDeclarationFile && !normalizeFilePath(sf.fileName).includes("/node_modules/");

export const getProjectSourceFiles = (program: ts.Program) =>
  pipe(program.getSourceFiles(), RA.filter(isProjectSourceFile));

const globToRegExp = (pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/\\/g, "/")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "__GLOBSTAR_SLASH__")
      .replace(/\*\*/g, "__GLOBSTAR__")
      .replace(/\*/g, "[^/]*")
      .replace(/__GLOBSTAR_SLASH__/g, "(?:.*/)?")
      .replace(/__GLOBSTAR__/g, ".*")}$`,
  );

export const isMatchingPattern = (filePath: string, pattern: string) =>
  globToRegExp(pattern).test(normalizeFilePath(filePath));

export const isMatchingAnyPattern = (
  filePath: string,
  patterns: ReadonlyArray<string>,
) => pipe(patterns, RA.some((pattern) => isMatchingPattern(filePath, pattern)));

export const shouldLintDomainFile = (
  scope: "everywhere" | "domain-only",
  filePath: string,
  domainPatterns: ReadonlyArray<string>,
) => scope === "everywhere" || isMatchingAnyPattern(filePath, domainPatterns);
