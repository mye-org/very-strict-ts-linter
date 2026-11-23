import crypto from "node:crypto";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
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
const digestSourceText = flow(stripLeadingShebang, hashSha256);

const computeSourceFileDigest = (sf: ts.SourceFile) => {
  const digest = digestSourceText(sf.text);
  sourceFileDigestCache.set(sf, digest);
  return digest;
};

const resolveSourceFileDigest = (sf: ts.SourceFile) =>
  sourceFileDigestCache.get(sf) ?? computeSourceFileDigest(sf);

const extractStampPair = (sf: ts.SourceFile) =>
  [normalizeFilePath(sf.fileName), resolveSourceFileDigest(sf)] as const;

const formatStampPair = ([filePath, digest]: readonly [string, string]) =>
  `${filePath}:${digest}`;

const formatSourceFileStamp = flow(extractStampPair, formatStampPair);

const collectSortedStamps = flow(
  collectProjectSourceFiles,
  RA.map(formatSourceFileStamp),
  RA.sort(S.Ord),
  joinLines,
);

const hashProgramStamps = flow(collectSortedStamps, hashSha256);

const computeProgramFingerprint = (program: ts.Program) => {
  const fp = hashProgramStamps(program);
  programFingerprintCache.set(program, fp);
  return fp;
};

const resolveProgramFingerprint = (program: ts.Program) =>
  programFingerprintCache.get(program) ?? computeProgramFingerprint(program);

const matchEntryFingerprint = <V>(fp: string) =>
  O.flatMap(([storedFp, val]: StoredEntry<V>) => (storedFp === fp ? O.some(val) : O.none));

const lookupCachedEntry = <V>(cache: WeakMap<object, StoredEntry<V>>, keyObj: object) =>
  O.fromNullable(cache.get(keyObj));

const matchFallbackByFingerprint = <V>(
  cache: WeakMap<object, StoredEntry<V>>,
  keyObj: object,
  fp: string,
) => matchEntryFingerprint<V>(fp)(lookupCachedEntry(cache, keyObj));

const storeSingleValue = <A>(
  program: ts.Program,
  fingerprint: string,
  cache: WeakMap<ts.Program, A>,
  value: A,
) => {
  cache.set(program, value);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- heterogeneous WeakMap value erasure without unknown
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
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- heterogeneous WeakMap value recovery without unknown
    (cached: never) => storeSingleValue(program, fp, cache, cached as A),
  )(matchFallbackByFingerprint(fallbackSingleCache, cache, fp));
};

export const memoizeByProgram = <A>(
  program: ts.Program,
  cache: WeakMap<ts.Program, A>,
  compute: (p: ts.Program) => A,
): A => cache.get(program) ?? lookupSingleByFingerprint(program, cache, compute);

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
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- heterogeneous WeakMap value erasure without unknown
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

const emptyKeyedRecord = <A>() => ({}) satisfies Readonly<Record<string, A>>;

const hydrateKeyedEntries = <A>(
  program: ts.Program,
  cache: WeakMap<ts.Program, Readonly<Record<string, A>>>,
) =>
  flow(
    resolveProgramFingerprint,
    (fp) => matchFallbackByFingerprint(fallbackKeyedCache, cache, fp),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- heterogeneous WeakMap value recovery without unknown
    O.map((entries) => attachHydratedEntries(program, cache, entries as Readonly<Record<string, A>>)),
    O.getOrElse(emptyKeyedRecord<A>),
  );

const hydrateKeyedFromFingerprint = <A>(
  program: ts.Program,
  cache: WeakMap<ts.Program, Readonly<Record<string, A>>>,
) => hydrateKeyedEntries(program, cache)(program);

const lookupOrStoreKeyed = <A>(
  program: ts.Program,
  key: string,
  cache: WeakMap<ts.Program, Readonly<Record<string, A>>>,
  existing: Readonly<Record<string, A>>,
  compute: (p: ts.Program) => A,
) =>
  O.getOrElse(() => computeAndStoreKeyed(program, key, cache, existing, compute))(
    RR.lookup(key)(existing),
  );

export const memoizeByProgramAndKey = <A>(
  program: ts.Program,
  key: string,
  cache: WeakMap<ts.Program, Readonly<Record<string, A>>>,
  compute: (p: ts.Program) => A,
): A =>
  lookupOrStoreKeyed(
    program,
    key,
    cache,
    cache.get(program) ?? hydrateKeyedFromFingerprint(program, cache),
    compute,
  );
