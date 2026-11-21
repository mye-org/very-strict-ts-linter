import { noIfElseOrSwitch } from "../src/rules/no-if-else-or-switch.js";
import { noImperativeLoops } from "../src/rules/no-imperative-loops.js";
import { noLetOrVar } from "../src/rules/no-let-or-var.js";
import { noThrowOutsideUnsafe } from "../src/rules/no-throw-outside-unsafe.js";
import { requireExhaustiveMatch } from "../src/rules/require-exhaustive-match.js";
import { createRuleTester, createTypeAwareRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();
const typeAwareRuleTester = createTypeAwareRuleTester();

ruleTester.run("no-if-else-or-switch", noIfElseOrSwitch, {
  valid: [
    `const res = match(q).with({ kind: "a" }, () => 1).exhaustive();`,
    `const guard = (x: number) => match(x < 0).with(true, () => 0).with(false, () => x).exhaustive();`,
    `const complex = (x: number, y: string) => match({ isPositive: x > 0, tag: y }).with({ isPositive: true, tag: "a" }, () => 1).otherwise(() => 0);`,
  ],
  invalid: [
    {
      code: `const guard = (x: number): number => { if (x < 0) return 0; return x; };`,
      errors: [{ messageId: "noIfElse" }],
    },
    {
      code: `const f = (x: number): number => { if (x > 0) { return 1; } else { return 0; } };`,
      errors: [{ messageId: "noIfElse" }],
    },
    {
      code: `const f = (x: number): number => { if (x > 0) { return 1; } else if (x < 0) { return -1; } else { return 0; } };`,
      errors: [{ messageId: "noIfElse" }],
    },
    {
      code: `const f = (x: number): number => { if (x < 0) return 0; if (x > 10) return 10; return x; };`,
      errors: [{ messageId: "noIfElse" }, { messageId: "noIfElse" }],
    },
    {
      code: `const f = (x: string): number => { switch (x) { case "a": return 1; default: return 0; } };`,
      errors: [{ messageId: "noSwitch" }],
    },
  ],
});

typeAwareRuleTester.run("require-exhaustive-match", requireExhaustiveMatch, {
  valid: [
    `
      declare function match<T>(v: T): {
        with: (p: unknown, fn: () => number) => {
          exhaustive: () => number;
          otherwise: (fn: () => number) => number;
        };
      };
      type Q = { kind: "a" } | { kind: "b" };
      declare const q: Q;
      const r = match(q).with({ kind: "a" }, () => 1).exhaustive();
    `,
    `
      declare function match<T>(v: T): {
        with: (p: unknown, fn: () => number) => {
          exhaustive: () => number;
          otherwise: (fn: () => number) => number;
        };
      };
      declare const s: string;
      const r = match(s).with("hi", () => 1).otherwise(() => 0);
    `,
  ],
  invalid: [
    {
      code: `
        declare function match<T>(v: T): {
          with: (p: unknown, fn: () => number) => number;
        };
        declare const s: string;
        const r = match(s).with("hi", () => 1);
      `,
      errors: [{ messageId: "unterminatedMatch" }],
    },
    {
      code: `
        declare function match<T>(v: T): {
          with: (p: unknown, fn: () => number) => {
            otherwise: (fn: () => number) => number;
          };
        };
        type Q = { kind: "a" } | { kind: "b" };
        declare const q: Q;
        const r = match(q).with({ kind: "a" }, () => 1).otherwise(() => 0);
      `,
      errors: [{ messageId: "preferExhaustive" }],
    },
  ],
});

ruleTester.run("no-imperative-loops", noImperativeLoops, {
  valid: [`const xs = pipe([1, 2, 3], RA.map((x) => x + 1));`],
  invalid: [
    {
      code: `for (let i = 0; i < 10; i++) {}`,
      errors: [{ messageId: "noImperativeLoop" }],
    },
    {
      code: `for (const x of [1, 2, 3]) {}`,
      errors: [{ messageId: "noImperativeLoop" }],
    },
    {
      code: `while (true) {}`,
      errors: [{ messageId: "noImperativeLoop" }],
    },
  ],
});

ruleTester.run("no-let-or-var", noLetOrVar, {
  valid: [`const x = 1;`],
  invalid: [
    {
      code: `let x = 1; x = 2;`,
      errors: [{ messageId: "noLetOrVar" }, { messageId: "noMutation" }],
    },
    {
      code: `var y = 1;`,
      errors: [{ messageId: "noLetOrVar" }],
    },
  ],
});

ruleTester.run("no-throw-outside-unsafe", noThrowOutsideUnsafe, {
  valid: [
    `const fromStringUnsafe = (s: string): number => { if (!s) throw new Error("bad"); return 1; };`,
    `function mustGet(x: number): number { if (x < 0) throw new Error("neg"); return x; }`,
  ],
  invalid: [
    {
      code: `const compute = (x: number): number => { throw new Error("nope"); };`,
      errors: [{ messageId: "noThrow" }],
    },
  ],
});
