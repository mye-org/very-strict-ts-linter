import { preferFunctionComposition } from "../src/rules/prefer-function-composition.js";
import { preferMonadicComposition } from "../src/rules/prefer-monadic-composition.js";
import { preferMonadicErrorHandling } from "../src/rules/prefer-monadic-error-handling.js";
import { createRuleTester, createTypeAwareRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();
const typeAwareRuleTester = createTypeAwareRuleTester();

ruleTester.run("prefer-function-composition", preferFunctionComposition, {
  valid: [
    `const y = pipe(x, h, g, f);`,
    `const fn = flow(g, f);`,
    `const y = f(g(x));`,
    `const fn = (x: number) => f(x);`,
    `const y = pipe(x, O.map((n) => n + 1));`,
  ],
  invalid: [
    {
      code: `const y = f(g(h(x)));`,
      errors: [{ messageId: "preferPipe" }],
    },
    {
      code: `const y = f(g(x));`,
      options: [{ maxNestingDepth: 1 }],
      errors: [{ messageId: "preferPipe" }],
    },
    {
      code: `const fn = (x: number) => f(g(x));`,
      errors: [{ messageId: "preferFlow" }],
    },
    {
      code: `const fn = (x: number) => { return f(g(x)); };`,
      errors: [{ messageId: "preferFlow" }],
    },
  ],
});

typeAwareRuleTester.run(
  "prefer-monadic-error-handling",
  preferMonadicErrorHandling,
  {
    valid: [
      `
        declare const E: { tryCatch: <E, A>(f: () => A, onThrow: (e: unknown) => E) => unknown };
        const res = E.tryCatch(() => 1, (e) => e);
      `,
      `
        function parseUnsafe(raw: string): unknown {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        }
      `,
      `
        const mustFetch = async (): Promise<number> => {
          return await Promise.resolve(1);
        };
      `,
      `
        const fetchUnsafe = async (): Promise<number> => {
          return new Promise((resolve) => resolve(1));
        };
      `,
    ],
    invalid: [
      {
        code: `
          function parse(raw: string): unknown {
            try {
              return JSON.parse(raw);
            } catch {
              return null;
            }
          }
        `,
        errors: [{ messageId: "noTryCatch" }],
      },
      {
        code: `async function load(): Promise<number> { return 1; }`,
        errors: [{ messageId: "noAsyncAwait" }],
      },
      {
        code: `const load = async (): Promise<number> => 1;`,
        errors: [{ messageId: "noAsyncAwait" }],
      },
      {
        code: `const p = new Promise<number>((resolve) => resolve(1));`,
        errors: [{ messageId: "noRawPromise" }],
      },
      {
        code: `const p = Promise.resolve(1);`,
        errors: [{ messageId: "noRawPromise" }],
      },
      {
        code: `
          declare const p: Promise<number>;
          const q = p.then((x) => x + 1);
        `,
        errors: [{ messageId: "noRawPromise" }],
      },
    ],
  },
);

ruleTester.run("prefer-monadic-composition", preferMonadicComposition, {
  valid: [
    // flatMap is encouraged even when nested
    `
      const r = pipe(
        a,
        O.flatMap((x) =>
          pipe(
            b(x),
            O.flatMap((y) => O.some(x + y)),
          ),
        ),
      );
    `,
    // Single non-nested chain is allowed
    `const r = pipe(a, O.chain((x) => O.some(x + 1)));`,
    // Do-notation
    `const r = pipe(O.Do, O.bind("a", () => x), O.bind("b", ({ a }) => y(a)));`,
    // match unwrapping to a primitive/domain value
    `const r = pipe(a, O.match(() => 0, (x) => x + 1));`,
    // Type guard passed as predicate to filter
    `const r = pipe(xs, RA.filter(O.isSome));`,
  ],
  invalid: [
    {
      code: `
        const r = pipe(
          a,
          O.chain((x) =>
            pipe(
              b(x),
              O.chain((y) => O.some(x + y)),
            ),
          ),
        );
      `,
      errors: [{ messageId: "nestedChain" }],
    },
    {
      code: `const r = pipe(a, O.match(() => O.none, (x) => O.some(x + 1)));`,
      errors: [{ messageId: "unwrapAndRewrap" }],
    },
    {
      code: `const r = pipe(a, E.fold((e) => E.left(e), (x) => E.right(x + 1)));`,
      errors: [{ messageId: "unwrapAndRewrap" }],
    },
    {
      code: `const r = pipe(a, O.map(f), O.flatten);`,
      errors: [{ messageId: "mapThenFlatten" }],
    },
    {
      code: `const r = O.isSome(x) ? x.value : 0;`,
      errors: [{ messageId: "imperativeMonadCheck" }],
    },
  ],
});
