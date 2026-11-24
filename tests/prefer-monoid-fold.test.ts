import { preferMonoidFold } from "../src/rules/prefer-monoid-fold.js";
import { createRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();

ruleTester.run("prefer-monoid-fold", preferMonoidFold, {
  valid: [
    // Non-identity initial value
    `const total = RA.reduce(10, (acc: number, x: number) => acc + x)(xs);`,
    // Non-monoidal reducer (appending single item instead of spreading)
    `const list = RA.reduce([] as ReadonlyArray<number>, (acc, x: number) => [...acc, x])(xs);`,
    // Reducer transforms accumulator non-monoidally
    `const total = RA.reduce(0, (acc: number, x: number) => acc * 2 + x)(xs);`,
    // Constant increment (does not reference element)
    `const count = RA.reduce(0, (acc: number, _x: number) => acc + 1)(xs);`,
    // Mismatched init and operator
    `const weird = RA.reduce(true, (acc: boolean, x: boolean) => acc || x)(xs);`,
    // Multi-statement block body
    `const total = xs.reduce((acc, x) => { const next = acc + x; return next; }, 0);`,
  ],
  invalid: [
    {
      code: `const total = RA.reduce(0, (acc: number, x: number) => acc + x)(xs);`,
      errors: [{ messageId: "preferMonoidFold", data: { monoid: "N.MonoidSum" } }],
    },
    {
      code: `const total = xs.reduce((acc, x) => acc + x.amount, 0);`,
      errors: [{ messageId: "preferMonoidFold", data: { monoid: "N.MonoidSum" } }],
    },
    {
      code: `const joined = RA.reduce("", (acc: string, x: string) => acc + x)(xs);`,
      errors: [{ messageId: "preferMonoidFold", data: { monoid: "S.Monoid" } }],
    },
    {
      code: `const allTrue = RA.reduce(true, (acc: boolean, x: boolean) => acc && x)(xs);`,
      errors: [{ messageId: "preferMonoidFold", data: { monoid: "B.MonoidAll" } }],
    },
    {
      code: `const anyTrue = xs.reduce((acc, x) => acc || isValid(x), false);`,
      errors: [{ messageId: "preferMonoidFold", data: { monoid: "B.MonoidAny" } }],
    },
    {
      code: `const flat = RA.reduce([], (acc, x) => [...acc, ...x])(xs);`,
      errors: [{ messageId: "preferMonoidFold", data: { monoid: "RA.getMonoid" } }],
    },
    {
      code: `const merged = xs.reduce(function (acc, x) { return { ...acc, ...x }; }, {});`,
      errors: [{ messageId: "preferMonoidFold", data: { monoid: "RR.getMonoid" } }],
    },
  ],
});
