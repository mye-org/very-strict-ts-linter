export const hasStrictSuffix = (name: string, suffix: string) =>
  name.length > suffix.length && name.endsWith(suffix);
