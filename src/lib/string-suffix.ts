export const hasStrictSuffix = (name: string, suffix: string): boolean =>
  name.length > suffix.length && name.endsWith(suffix);
