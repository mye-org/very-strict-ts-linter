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
  flow(
    (file: ts.SourceFile) => sourceFileDigestCache.get(file),
    O.fromNullable,
    O.getOrElse(() => computeSourceFileDigest(sf)),
  );

const extractStampPair = (sf: ts.SourceFile) =>
  [normalizeFilePath(sf.fileName), resolveSourceFileDigest(sf)(sf)] as const;

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

const resolveProgramFingerprintFor = (program: ts.Program) =>
  flow(
    (p: ts.Program) => programFingerprintCache.get(p),
    O.fromNullable,
    O.getOrElse(() => computeProgramFingerprint(program)),
  );

const resolveProgramFingerprint = (program: ts.Program) =>
  resolveProgramFingerprintFor(program)(program);

const matchEntryFingerprint = <V>(fp: string) =>
  O.flatMap(([storedFp, val]: StoredEntry<V>) => (storedFp === fp ? O.some(val) : O.none));

const lookupCachedEntry = <V>(cache: WeakMap<object, StoredEntry<V>>) =>
  flow((keyObj: object) => cache.get(keyObj), O.fromNullable);

const matchFallbackByFingerprint =
  (fp: string) =>
  <V>(cache: WeakMap<object, StoredEntry<V>>) =>
    flow(lookupCachedEntry(cache), matchEntryFingerprint<V>(fp));

const storeSingleValue =
  (program: ts.Program) =>
  (fingerprint: string) =>
  <A>(cache: WeakMap<ts.Program, A>) =>
  (value: A) => {
    cache.set(program, value);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- heterogeneous WeakMap value erasure without unknown
    fallbackSingleCache.set(cache, [fingerprint, value as never]);
    return value;
  };

export type MemoizeByProgramInput<A> = Readonly<{
  program: ts.Program;
  cache: WeakMap<ts.Program, A>;
  compute: (p: ts.Program) => A;
}>;

const lookupSingleByFingerprint = <A>({
  program,
  cache,
  compute,
}: MemoizeByProgramInput<A>) => {
  const fp = resolveProgramFingerprint(program);
  const store = storeSingleValue(program)(fp)(cache);
  return O.match(
    () => store(compute(program)),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- heterogeneous WeakMap value recovery without unknown
    (cached: never) => store(cached as A),
  )(matchFallbackByFingerprint(fp)(fallbackSingleCache)(cache));
};

const lookupOrComputeSingle = <A>({
  program,
  cache,
  compute,
}: MemoizeByProgramInput<A>) =>
  flow(
    (p: ts.Program) => cache.get(p),
    O.fromNullable,
    O.getOrElse(() => lookupSingleByFingerprint({ program, cache, compute })),
  );

export const memoizeByProgram = (<A>(cache: WeakMap<ts.Program, A>) =>
  (compute: (p: ts.Program) => A) =>
  (program: ts.Program) =>
    lookupOrComputeSingle({ program, cache, compute })(program)) satisfies <A>(
  cache: WeakMap<ts.Program, A>,
) => (compute: (p: ts.Program) => A) => (program: ts.Program) => A;

type KeyedMemoConfig<A> = Readonly<{
  cache: WeakMap<ts.Program, Readonly<Record<string, A>>>;
  compute: (p: ts.Program) => A;
}>;

const computeAndStoreKeyed =
  <A>({ cache, compute }: KeyedMemoConfig<A>) =>
  (existing: Readonly<Record<string, A>>) =>
  (program: ts.Program) =>
  (key: string) => {
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

const attachHydratedEntries =
  (program: ts.Program) =>
  <A>(cache: WeakMap<ts.Program, Readonly<Record<string, A>>>) =>
  (entries: Readonly<Record<string, A>>) => {
    cache.set(program, entries);
    return entries;
  };

const emptyKeyedRecord = <A>() => ({}) satisfies Readonly<Record<string, A>>;

const hydrateKeyedEntries =
  (program: ts.Program) =>
  <A>(cache: WeakMap<ts.Program, Readonly<Record<string, A>>>) =>
    flow(
      resolveProgramFingerprint,
      (fp) => matchFallbackByFingerprint(fp)(fallbackKeyedCache)(cache),
      O.map((entries) =>
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- heterogeneous WeakMap value recovery without unknown
        attachHydratedEntries(program)(cache)(entries as Readonly<Record<string, A>>),
      ),
      O.getOrElse(emptyKeyedRecord<A>),
    );

const hydrateKeyedFromFingerprint =
  (program: ts.Program) =>
  <A>(cache: WeakMap<ts.Program, Readonly<Record<string, A>>>) =>
    hydrateKeyedEntries(program)(cache)(program);

const lookupRecordKey =
  <A>(record: Readonly<Record<string, A>>) =>
  (key: string) =>
    RR.lookup(key)(record);

const lookupOrStoreKeyed =
  <A>(config: KeyedMemoConfig<A>) =>
  (existing: Readonly<Record<string, A>>) =>
  (program: ts.Program) =>
  (key: string) => {
    const computeFallback = () => computeAndStoreKeyed(config)(existing)(program)(key);
    return O.getOrElse(computeFallback)(lookupRecordKey(existing)(key));
  };

export const memoizeByProgramAndKey = (<A>(
  cache: WeakMap<ts.Program, Readonly<Record<string, A>>>,
) =>
  (compute: (p: ts.Program) => A) =>
  (program: ts.Program) =>
    lookupOrStoreKeyed({ cache, compute })(
      O.getOrElse(() => hydrateKeyedFromFingerprint(program)(cache))(
        O.fromNullable(cache.get(program)),
      ),
    )(program)) satisfies <A>(
  cache: WeakMap<ts.Program, Readonly<Record<string, A>>>,
) => (compute: (p: ts.Program) => A) => (program: ts.Program) => (key: string) => A;
