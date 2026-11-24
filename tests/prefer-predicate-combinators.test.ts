import { preferPredicateCombinators } from "../src/rules/prefer-predicate-combinators.js";
import { createRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();

ruleTester.run("prefer-predicate-combinators", preferPredicateCombinators, {
  valid: [
    // Single bare predicate call (eta-expansion, not a combinator/negation)
    `const f = (x: string) => isA(x);`,
    // Non-predicate comparison inside logical expression
    `const f = (x: string) => isA(x) && x.length > 0;`,
    // Different identifier used in second predicate
    `const f = (x: string) => isA(x) || isB(y);`,
    // Multiple parameters
    `const f = (x: string, y: string) => isA(x) || isB(y);`,
    // Non-unary predicate call
    `const f = (x: string) => isA(x, 1) || isB(x);`,
    // Nullish coalescing is not boolean logical combination
    `const f = (x: string) => isA(x) ?? isB(x);`,
    // Multi-statement block body
    `const f = (x: string) => { const a = isA(x); return a || isB(x); };`,
    // Self-call is not a predicate call
    `const f = (x: (v: unknown) => boolean) => !x(x);`,
  ],
  invalid: [
    {
      code: `const f = (x: string) => isA(x) || isB(x);`,
      errors: [{ messageId: "preferPredicateCombinator" }],
    },
    {
      code: `const f = (x: string) => isA(x) && !isB(x);`,
      errors: [{ messageId: "preferPredicateCombinator" }],
    },
    {
      code: `const f = (x: string) => !isA(x);`,
      errors: [{ messageId: "preferPredicateNot" }],
    },
    {
      code: `const f = (x: string) => isA(x) || isB(x) || isC(x);`,
      errors: [{ messageId: "preferPredicateCombinator" }],
    },
    {
      code: `const f = (x: string) => { return Pred.isString(x) && isNonEmpty(x); };`,
      errors: [{ messageId: "preferPredicateCombinator" }],
    },
    {
      code: `const f = function (x: string) { return !isA(x); };`,
      errors: [{ messageId: "preferPredicateNot" }],
    },
    {
      code: `const f = (x: string) => !(isA(x) || isB(x));`,
      errors: [{ messageId: "preferPredicateNot" }],
    },
  ],
});
