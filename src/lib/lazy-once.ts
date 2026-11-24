import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";

export const lazyOnce = (<A>(compute: () => A) => {
  const cache = new WeakMap<object, { readonly value: A }>();
  const token = {};
  const populate = () => {
    const entry = { value: compute() };
    cache.set(token, entry);
    return entry.value;
  };
  const readCache = (key: object) => cache.get(key);
  const lookup = flow(readCache, O.fromNullable);
  const resolve = flow(
    lookup,
    O.match(populate, (entry: { readonly value: A }) => entry.value),
  );
  return () => resolve(token);
}) satisfies <A>(compute: () => A) => () => A;
