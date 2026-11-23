import crypto from "node:crypto";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as S from "fp-ts/lib/string.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { collectProjectSourceFiles, normalizeFilePath } from "./source-paths.js";

const LEADING_SHEBANG_RE = /^(?:\/\/)?#![^\r\n]*/;

type StoredEntry<V> = readonly [string, V];

const sourceFileDigestCache = new WeakMap<ts.SourceFile, string>();
const programFingerprintCache = new WeakMap<ts.Program, string>();
const fallbackSingleCache = new WeakMap<object, StoredEntry<never>>();
const fallbackKeyedCache = new WeakMap<object, StoredEntry<Readonly<Record<string, never>>>>();

const stripLeadingShebang = (text: string) => text.replace(LEADING_SHEBANG_RE, "");
const hashSha256 = (content: string) => crypto.hash("sha256", content);
const joinLines = (lines: ReadonlyArray<string>) => lines.join("\n");

const computeSourceFileDigest = (sf: ts.SourceFile) => {
  const digest = flow(stripLeadingShebang, hashSha256)(sf.text);
  sourceFileDigestCache.set(sf, digest);
  return digest;
};

const resolveSourceFileDigest = (sf: ts.SourceFile) =>
  flow(
    (file: ts.SourceFile) => sourceFileDigestCache.get(file),
    O.fromNullable,
    O.getOrElse(() => computeSourceFileDigest(sf)),
  )(sf);

const formatStampForPath = (filePath: string) => (digest: string) => `${filePath}:${digest}`;

const formatSourceFileStamp = (sf: ts.SourceFile) =>
  flow(resolveSourceFileDigest, formatStampForPath(normalizeFilePath(sf.fileName)))(sf);

const collectSortedStamps = flow(
  collectProjectSourceFiles,
  RA.map(formatSourceFileStamp),
  RA.sort(S.Ord),
  joinLines,
);

const computeProgramFingerprint = (program: ts.Program) => {
  const fp = flow(collectSortedStamps, hashSha256)(program);
  programFingerprintCache.set(program, fp);
  return fp;
};

const resolveProgramFingerprint = (program: ts.Program) =>
  flow(
    (p: ts.Program) => programFingerprintCache.get(p),
    O.fromNullable,
    O.getOrElse(() => computeProgramFingerprint(program)),
  )(program);

const matchFallbackByFingerprint = <V>(
  cache: WeakMap<object, StoredEntry<V>>,
  keyObj: object,
  fp: string,
) =>
  flow(
    (k: object) => cache.get(k),
    O.fromNullable,
    O.flatMap(([storedFp, val]) => (storedFp === fp ? O.some(val) : O.none)),
  )(keyObj);

const storeSingleValue = <A>(
  program: ts.Program,
  fingerprint: string,
  cache: WeakMap<ts.Program, A>,
  value: A,
) => {
  cache.set(program, value);
  fallbackSingleCache.set(cache, [fingerprint, value as never]);
  return value;
};

const lookupSingleByFingerprint = <A>(
  program: ts.Program,
  cache: WeakMap<ts.Program, A>,
  compute: (p: ts.Program) => A,
) => {
  const fp = resolveProgramFingerprint(program);
  return O.match(
    () => storeSingleValue(program, fp, cache, compute(program)),
    (cached: never) => storeSingleValue(program, fp, cache, cached as A),
  )(matchFallbackByFingerprint(fallbackSingleCache, cache, fp));
};

export const memoizeByProgram = <A>(
  program: ts.Program,
  cache: WeakMap<ts.Program, A>,
  compute: (p: ts.Program) => A,
) =>
  flow(
    (p: ts.Program) => cache.get(p),
    O.fromNullable,
    O.getOrElse(() => lookupSingleByFingerprint(program, cache, compute)),
  )(program);

const computeAndStoreKeyed = <A>(
  program: ts.Program,
  key: string,
  cache: WeakMap<ts.Program, Readonly<Record<string, A>>>,
  existing: Readonly<Record<string, A>>,
  compute: (p: ts.Program) => A,
) => {
  const value = compute(program);
  const nextEntries = { ...existing, [key]: value };
  cache.set(program, nextEntries);
  fallbackKeyedCache.set(cache, [
    resolveProgramFingerprint(program),
    nextEntries as Readonly<Record<string, never>>,
  ]);
  return value;
};

const attachHydratedEntries = <A>(
  program: ts.Program,
  cache: WeakMap<ts.Program, Readonly<Record<string, A>>>,
  entries: Readonly<Record<string, A>>,
) => {
  cache.set(program, entries);
  return entries;
};

const emptyKeyedRecord = <A>() => ({}) as Readonly<Record<string, A>>;

const hydrateKeyedFromFingerprint = <A>(
  program: ts.Program,
  cache: WeakMap<ts.Program, Readonly<Record<string, A>>>,
) =>
  flow(
    resolveProgramFingerprint,
    (fp) => matchFallbackByFingerprint(fallbackKeyedCache, cache, fp),
    O.map((entries) => attachHydratedEntries(program, cache, entries as Readonly<Record<string, A>>)),
    O.getOrElse(emptyKeyedRecord<A>),
  )(program);

const lookupOrStoreKeyed = <A>(
  program: ts.Program,
  key: string,
  cache: WeakMap<ts.Program, Readonly<Record<string, A>>>,
  existing: Readonly<Record<string, A>>,
  compute: (p: ts.Program) => A,
) =>
  flow(
    (rec: Readonly<Record<string, A>>) => rec[key],
    O.fromNullable,
    O.getOrElse(() => computeAndStoreKeyed(program, key, cache, existing, compute)),
  )(existing);

export const memoizeByProgramAndKey = <A>(
  program: ts.Program,
  key: string,
  cache: WeakMap<ts.Program, Readonly<Record<string, A>>>,
  compute: (p: ts.Program) => A,
) =>
  lookupOrStoreKeyed(
    program,
    key,
    cache,
    cache.get(program) ?? hydrateKeyedFromFingerprint(program, cache),
    compute,
  );
