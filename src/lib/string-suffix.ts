import * as Pred from "fp-ts/lib/Predicate.js";

export const hasStrictSuffix = ((suffix: string) => {
  const hasTargetSuffix = (name: string) =>
    name.length > suffix.length && name.endsWith(suffix);
  return hasTargetSuffix;
}) satisfies (suffix: string) => Pred.Predicate<string>;
