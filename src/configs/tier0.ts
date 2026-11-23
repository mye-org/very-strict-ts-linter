export const tier0TypeChecker = {
  tier: 0,
  name: "Type Checker",
  command: "tsc --noEmit",
  description: 'Type soundness — "Does this code obey TypeScript\'s type system?"',
} as const;
