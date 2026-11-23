import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";
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
  flow(
    (p: ts.Program) => cache.get(p),
    O.fromNullable,
    O.getOrElse(() => computeAndStore(program, cache, compute)),
  )(program);

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
) => lookupOrStoreKeyed(program, key, cache, cache.get(program) ?? {}, compute);
