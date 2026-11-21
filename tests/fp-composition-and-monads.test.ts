import { preferFunctionComposition } from "../src/rules/prefer-function-composition.js";
import { preferMonadicComposition } from "../src/rules/prefer-monadic-composition.js";
import { preferMonadicErrorHandling } from "../src/rules/prefer-monadic-error-handling.js";
import { preferPointFree } from "../src/rules/prefer-point-free.js";
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

typeAwareRuleTester.run("prefer-point-free", preferPointFree, {
  valid: [
    // Already point-free
    `
      declare function inc(x: number): number;
      declare const map: <A, B>(f: (a: A) => B) => (xs: ReadonlyArray<A>) => ReadonlyArray<B>;
      const mapInc = map(inc);
    `,
    // Exclude (x) => pipe(x, ...)
    `
      declare function pipe<A, B, C>(a: A, ab: (a: A) => B, bc: (b: B) => C): C;
      declare function f(x: number): number;
      declare function g(x: number): string;
      const fn = (x: number) => pipe(x, f, g);
    `,
    // Extra, reordered, or transformed arguments
    `
      declare function add(a: number, b: number): number;
      const addOne = (x: number) => add(x, 1);
      const flipped = (a: number, b: number) => add(b, a);
      const shifted = (x: number) => add(x + 1, x);
    `,
    // Parameter referenced in callee
    `
      declare function makeFn(x: number): (y: number) => number;
      const selfApply = (x: number) => makeFn(x)(x);
    `,
    // Self-recursive definition must not trigger TDZ
    `
      const loop = (x: number): number => loop(x);
      function loopFn(x: number): number { return loopFn(x); }
    `,
    // Skip interface/object methods that depend on `this`
    `
      declare const ctx: { report(x: number): void };
      const fn = (x: number) => ctx.report(x);
    `,
    `
      const obj = { val: 1, inc(x: number) { return this.val + x; } };
      const fn = (x: number) => obj.inc(x);
    `,
    `
      declare const sig: { (this: { readonly a: number }, x: number): number };
      const fn = (x: number) => sig(x);
    `,
    // Skip callee with extra optional or rest parameters
    `
      declare function parseNum(s: string, radix?: number): number;
      const fn = (s: string) => parseNum(s);
    `,
    `
      declare function sum(...xs: ReadonlyArray<number>): number;
      const fn = (x: number) => sum(x);
    `,
    // Skip overloaded callee
    `
      declare function parse(x: string): number;
      declare function parse(x: number): string;
      const fn = (x: string) => parse(x);
    `,
    // Skip when explicit annotations specialize/narrow a generic or wider callee
    `
      declare const identity: <A>(a: A) => A;
      const idNum = (x: number) => identity(x);
    `,
    `
      declare function accept(x: string | number): void;
      const onlyStr = (x: string) => accept(x);
    `,
    // Skip explicit type arguments on inner call
    `
      declare const identity: <A>(a: A) => A;
      const fn = (x: number) => identity<number>(x);
    `,
    // Skip void block that intentionally discards a non-void return value
    `
      declare function compute(x: number): number;
      const fn = (x: number) => { compute(x); };
    `,
    // Skip async wrappers and object getters
    `
      declare function fetchNum(x: number): Promise<number>;
      const fn = async (x: number) => fetchNum(x);
    `,
    `
      declare function getVal(): number;
      const obj = { get x() { return getVal(); } };
    `,
  ],
  invalid: [
    {
      code: `
        declare function inc(x: number): number;
        declare const apply: <A, B>(f: (a: A) => B, a: A) => B;
        const r = apply((x) => inc(x), 1);
      `,
      errors: [{ messageId: "preferPointFree" }],
    },
    {
      code: `
        declare function add(a: number, b: number): number;
        declare const combine: (f: (a: number, b: number) => number) => number;
        const r = combine((a, b) => add(a, b));
      `,
      errors: [{ messageId: "preferPointFree" }],
    },
    {
      code: `
        declare function inc(x: number): number;
        declare const map: <A, B>(f: (a: A) => B) => (xs: ReadonlyArray<A>) => ReadonlyArray<B>;
        const fn = (xs: ReadonlyArray<number>) => map(inc)(xs);
      `,
      errors: [{ messageId: "preferPointFree" }],
    },
    {
      code: `
        declare function sum(...xs: ReadonlyArray<number>): number;
        const fn = (...xs: ReadonlyArray<number>) => sum(...xs);
      `,
      errors: [{ messageId: "preferPointFree" }],
    },
    {
      code: `
        declare function inc(x: number): number;
        const a = (x: number) => { return inc(x); };
        const b = function (x: number) { return inc(x); };
        function c(x: number) { return inc(x); }
      `,
      errors: [
        { messageId: "preferPointFree" },
        { messageId: "preferPointFree" },
        { messageId: "preferPointFree" },
      ],
    },
    {
      code: `
        declare function logNum(x: number): void;
        const fn = (x: number) => { logNum(x); };
      `,
      errors: [{ messageId: "preferPointFree" }],
    },
    {
      code: `
        declare const O: { some: <A>(a: A) => unknown };
        declare const map: <A, B>(f: (a: A) => B) => (xs: ReadonlyArray<A>) => ReadonlyArray<B>;
        declare const xs: ReadonlyArray<number>;
        const ys = map((x) => O.some(x))(xs);
      `,
      errors: [{ messageId: "preferPointFree" }],
    },
    {
      code: `
        const mod = { inc: (x: number) => x + 1 };
        const fn = (x: number) => mod.inc(x);
      `,
      errors: [{ messageId: "preferPointFree" }],
    },
    {
      code: `
        declare function getZero(): number;
        const fn = () => getZero();
      `,
      errors: [{ messageId: "preferPointFree" }],
    },
  ],
});
