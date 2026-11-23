import { noFpTsChain } from "../src/rules/no-fp-ts-chain.js";
import { noFpTsHkt } from "../src/rules/no-fp-ts-hkt.js";
import { noFpTsPipe } from "../src/rules/no-fp-ts-pipe.js";
import { noNestedPipe } from "../src/rules/no-nested-pipe.js";
import { preferFunctionComposition } from "../src/rules/prefer-function-composition.js";
import { preferMonadicComposition } from "../src/rules/prefer-monadic-composition.js";
import { preferMonadicErrorHandling } from "../src/rules/prefer-monadic-error-handling.js";
import { preferPointFree } from "../src/rules/prefer-point-free.js";
import { createRuleTester, createTypeAwareRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();
const typeAwareRuleTester = createTypeAwareRuleTester();

ruleTester.run("prefer-function-composition", preferFunctionComposition, {
  valid: [
    `const y = flow(h, g, f)(x);`,
    `const fn = flow(g, f);`,
    `const y = f(g(x));`,
    `const fn = (x: number) => f(x);`,
    `const fn = flow(O.map((n) => n + 1));`,
  ],
  invalid: [
    {
      code: `const y = f(g(h(x)));`,
      errors: [{ messageId: "preferFlowComposition" }],
    },
    {
      code: `const y = f(g(x));`,
      options: [{ maxNestingDepth: 1 }],
      errors: [{ messageId: "preferFlowComposition" }],
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
    // flow with map + flatMap
    `const fn = flow(O.map(f), O.flatMap(g));`,
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
      code: `const fn = flow(O.map(f), O.flatten);`,
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

ruleTester.run("no-nested-pipe", noNestedPipe, {
  valid: [
    // Single top-level pipe
    `const res = pipe(x, f, g);`,
    // Inner pipeline extracted into standalone function
    `
      const transformItem = (x: number) => pipe(x, f, g);
      const res = pipe(items, RA.map(transformItem));
    `,
    // Extracted into helper before outer pipe
    `
      const outer = (opt: O.Option<number>) => {
        const inner = (x: number) => pipe(x, f, g);
        return pipe(opt, O.map(inner));
      };
    `,
    // Sibling pipes not nested inside each other
    `const pair = [pipe(a, f), pipe(b, g)];`,
    // Method .pipe() (e.g. Node stream / RxJS) inside pipe is not fp-ts pipe
    `const res = pipe(getStream(), (s) => s.pipe(transform));`,
  ],
  invalid: [
    {
      code: `const res = pipe(pipe(x, f), g);`,
      errors: [{ messageId: "noNestedPipe" }],
    },
    {
      code: `const res = pipe(items, RA.map((x) => pipe(x, f, g)));`,
      errors: [{ messageId: "noNestedPipe" }],
    },
    {
      code: `
        const res = pipe(
          opt,
          O.flatMap((x) => {
            return pipe(b(x), O.map((y) => x + y));
          }),
        );
      `,
      errors: [{ messageId: "noNestedPipe" }],
    },
    {
      code: `
        const res = pipe(
          val,
          (v) => match(v).with("a", () => pipe(v, f)).otherwise(() => v),
        );
      `,
      errors: [{ messageId: "noNestedPipe" }],
    },
    {
      code: `
        const res = pipe(
          x,
          (a) => pipe(a, (b) => pipe(b, f)),
        );
      `,
      errors: [{ messageId: "noNestedPipe" }, { messageId: "noNestedPipe" }],
    },
    {
      code: `const fn = flow(f, flow(g, h));`,
      errors: [{ messageId: "noNestedPipe" }],
    },
  ],
});

typeAwareRuleTester.run("no-fp-ts-chain", noFpTsChain, {
  valid: [
    // Idiomatic flatMap and Do-notation
    `
      import * as O from "fp-ts/lib/Option.js";
      import { pipe } from "fp-ts/lib/function.js";
      const res = pipe(O.some(1), O.flatMap((x) => O.some(x + 1)));
    `,
    `
      import * as E from "fp-ts/lib/Either.js";
      import { pipe } from "fp-ts/lib/function.js";
      const res = pipe(E.Do, E.bind("a", () => E.right(1)));
    `,
    `
      import { flatMap } from "fp-ts/lib/Option.js";
      import * as O from "fp-ts/lib/Option.js";
      import { pipe } from "fp-ts/lib/function.js";
      const res = pipe(O.some(1), flatMap((x) => O.some(x + 1)));
    `,
    // Non-fp-ts chain functions or methods are allowed
    `
      const chain = (x: number) => x + 1;
      const res = chain(1);
    `,
    `
      const builder = { chain: (x: number) => x + 1 };
      const res = builder.chain(1);
    `,
    // Shadowed parameter named O with non-fp-ts chain
    `
      import * as O from "fp-ts/lib/Option.js";
      const fn = (opt: { chain: (x: number) => number }) => opt.chain(1);
      const shadowed = (O: { chain: (x: number) => number }) => O.chain(1);
      const ok = O.some(1);
    `,
    // Type-only import or typeof query should not fail
    `
      import type * as O from "fp-ts/lib/Option.js";
      type OptionChain = typeof O.chain;
    `,
  ],
  invalid: [
    {
      code: `
        import * as O from "fp-ts/lib/Option.js";
        import { pipe } from "fp-ts/lib/function.js";
        const res = pipe(O.some(1), O.chain((x) => O.some(x + 1)));
      `,
      errors: [{ messageId: "noFpTsChain" }],
    },
    {
      code: `
        import * as E from "fp-ts/Either";
        import { pipe } from "fp-ts/function";
        const res = pipe(E.right(1), E.chain((x) => E.right(x + 1)));
      `,
      errors: [{ messageId: "noFpTsChain" }],
    },
    {
      code: `
        import * as TE from "fp-ts/lib/TaskEither.js";
        import { pipe } from "fp-ts/lib/function.js";
        const res = pipe(TE.right(1), TE.chain((x) => TE.right(x + 1)));
      `,
      errors: [{ messageId: "noFpTsChain" }],
    },
    {
      code: `
        import * as RA from "fp-ts/lib/ReadonlyArray.js";
        import { pipe } from "fp-ts/lib/function.js";
        const res = pipe([1, 2], RA.chain((x) => [x, x + 1]));
      `,
      errors: [{ messageId: "noFpTsChain" }],
    },
    {
      code: `
        import { chain, some } from "fp-ts/lib/Option.js";
        import { pipe } from "fp-ts/lib/function.js";
        const res = pipe(some(1), chain((x) => some(x + 1)));
      `,
      errors: [{ messageId: "noFpTsChain" }],
    },
    {
      code: `
        import { chain as bindOption, some } from "fp-ts/lib/Option.js";
        import { pipe } from "fp-ts/lib/function.js";
        const res = pipe(some(1), bindOption((x) => some(x + 1)));
      `,
      errors: [{ messageId: "noFpTsChain" }],
    },
    {
      code: `
        import * as O from "fp-ts/lib/Option.js";
        const step = O.chain;
      `,
      errors: [{ messageId: "noFpTsChain" }],
    },
    {
      code: `
        import * as O from "fp-ts/lib/Option.js";
        const res = O.Monad.chain(O.some(1), (x) => O.some(x + 1));
      `,
      errors: [{ messageId: "noFpTsChain" }],
    },
    {
      code: `export { chain } from "fp-ts/lib/Option.js";`,
      errors: [{ messageId: "noFpTsChain" }],
    },
    {
      code: `import { chain } from "fp-ts/lib/Option.js";`,
      errors: [{ messageId: "noFpTsChain" }],
    },
  ],
});

ruleTester.run("no-fp-ts-chain (ast fallback)", noFpTsChain, {
  valid: [
    `
      import * as O from "fp-ts/lib/Option.js";
      const res = pipe(O.some(1), O.flatMap((x) => O.some(x + 1)));
    `,
    `
      const custom = { chain: (x: number) => x + 1 };
      const res = custom.chain(1);
    `,
  ],
  invalid: [
    {
      code: `
        import * as O from "fp-ts/lib/Option.js";
        const res = pipe(O.some(1), O.chain((x) => O.some(x + 1)));
      `,
      errors: [{ messageId: "noFpTsChain" }],
    },
    {
      code: `
        import { chain as bindEither } from "fp-ts/Either";
        const res = pipe(x, bindEither((a) => E.right(a)));
      `,
      errors: [{ messageId: "noFpTsChain" }],
    },
  ],
});

typeAwareRuleTester.run("no-fp-ts-pipe", noFpTsPipe, {
  valid: [
    // Idiomatic flow composition
    `
      import * as O from "fp-ts/lib/Option.js";
      import { flow } from "fp-ts/lib/function.js";
      const fn = flow(O.some, O.map((x: number) => x + 1));
    `,
    `
      import * as F from "fp-ts/lib/function.js";
      const fn = F.flow((x: number) => x + 1, (x: number) => x * 2);
    `,
    // Non-fp-ts pipe functions or methods are allowed
    `
      const pipe = (x: number) => x + 1;
      const res = pipe(1);
    `,
    `
      const stream = { pipe: (x: number) => x + 1 };
      const res = stream.pipe(1);
    `,
    // Shadowed parameter named F with non-fp-ts pipe
    `
      import * as F from "fp-ts/lib/function.js";
      const shadowed = (F: { pipe: (x: number) => number }) => F.pipe(1);
      const ok = F.flow((x: number) => x + 1);
    `,
    // Type-only import or typeof query should not fail
    `
      import type * as F from "fp-ts/lib/function.js";
      type PipeFn = typeof F.pipe;
    `,
  ],
  invalid: [
    {
      code: `
        import * as O from "fp-ts/lib/Option.js";
        import { pipe } from "fp-ts/lib/function.js";
        const res = pipe(O.some(1), O.map((x) => x + 1));
      `,
      errors: [{ messageId: "noFpTsPipe" }],
    },
    {
      code: `
        import { pipe } from "fp-ts/function";
        const res = pipe(1, (x) => x + 1);
      `,
      errors: [{ messageId: "noFpTsPipe" }],
    },
    {
      code: `
        import { pipe as p } from "fp-ts/lib/function.js";
        const res = p(1, (x) => x + 1);
      `,
      errors: [{ messageId: "noFpTsPipe" }],
    },
    {
      code: `
        import * as F from "fp-ts/lib/function.js";
        const res = F.pipe(1, (x) => x + 1);
      `,
      errors: [{ messageId: "noFpTsPipe" }],
    },
    {
      code: `
        import * as F from "fp-ts/lib/function.js";
        const fn = F.pipe;
      `,
      errors: [{ messageId: "noFpTsPipe" }],
    },
    {
      code: `
        import { pipe } from "fp-ts/lib/function.js";
        const fn = pipe;
      `,
      errors: [{ messageId: "noFpTsPipe" }],
    },
    {
      code: `export { pipe } from "fp-ts/lib/function.js";`,
      errors: [{ messageId: "noFpTsPipe" }],
    },
    {
      code: `import { pipe } from "fp-ts/lib/function.js";`,
      errors: [{ messageId: "noFpTsPipe" }],
    },
  ],
});

ruleTester.run("no-fp-ts-pipe (ast fallback)", noFpTsPipe, {
  valid: [
    `
      import * as O from "fp-ts/lib/Option.js";
      import { flow } from "fp-ts/lib/function.js";
      const fn = flow(O.some, O.map((x: number) => x + 1));
    `,
    `
      const stream = { pipe: (x: number) => x + 1 };
      const res = stream.pipe(1);
    `,
  ],
  invalid: [
    {
      code: `
        import { pipe } from "fp-ts/lib/function.js";
        const res = pipe(1, (x) => x + 1);
      `,
      errors: [{ messageId: "noFpTsPipe" }],
    },
    {
      code: `
        import * as F from "fp-ts/function";
        const res = F.pipe(1, (x) => x + 1);
      `,
      errors: [{ messageId: "noFpTsPipe" }],
    },
    {
      code: `
        import { pipe as p } from "fp-ts/function";
        const res = p(1, (x) => x + 1);
      `,
      errors: [{ messageId: "noFpTsPipe" }],
    },
  ],
});

typeAwareRuleTester.run("no-fp-ts-hkt", noFpTsHkt, {
  valid: [
    // Concrete fp-ts data types and combinators (including Applicative/traverse/sequenceS)
    `
      import * as Ap from "fp-ts/lib/Apply.js";
      import * as O from "fp-ts/lib/Option.js";
      import * as RA from "fp-ts/lib/ReadonlyArray.js";
      import { flow } from "fp-ts/lib/function.js";
      const mapAndTraverse = flow(RA.traverse(O.Applicative)((x: number) => O.some(x + 1)));
      const combined = Ap.sequenceS(O.Applicative)({ a: O.some(1), b: O.some("ok") });
    `,
    // Ordinary generics and local types with similar names
    `
      type Kind = "a" | "b";
      type HKT<A> = { readonly tag: Kind; readonly payload: A };
      const wrap = <A>(payload: A): HKT<A> => ({ tag: "a", payload });
    `,
    // Non-hkt imports from fp-ts root barrel
    `
      import { option } from "fp-ts";
      const res = option.some(1);
    `,
    // Non-HKT ambient module augmentation
    `
      declare module "custom-registry" {
        interface Entries {
          readonly count: number;
        }
      }
    `,
    // Non-HKT inline import type
    `
      type MaybeNum = import("fp-ts/lib/Option.js").Option<number>;
    `,
    // Non-fp-ts object with hkt property
    `
      const bag = { hkt: 42 };
      const count = bag.hkt;
    `,
  ],
  invalid: [
    {
      code: `
        import type { Kind, URIS } from "fp-ts/lib/HKT.js";
        type Box<F extends URIS, A> = Kind<F, A>;
      `,
      errors: [{ messageId: "noFpTsHkt" }],
    },
    {
      code: `
        import { HKT, URItoKind } from "fp-ts/HKT";
        type Box<F, A> = HKT<F, A>;
      `,
      errors: [{ messageId: "noFpTsHkt" }],
    },
    {
      code: `
        import * as H from "fp-ts/lib/HKT.js";
        type Box<F extends H.URIS2, E, A> = H.Kind2<F, E, A>;
      `,
      errors: [{ messageId: "noFpTsHkt" }],
    },
    {
      code: `
        import type * as H from "fp-ts/es6/HKT";
        type Box<F extends H.URIS3, R, E, A> = H.Kind3<F, R, E, A>;
      `,
      errors: [{ messageId: "noFpTsHkt" }],
    },
    {
      code: `
        import { hkt } from "fp-ts";
        type Box<F extends hkt.URIS, A> = hkt.Kind<F, A>;
      `,
      errors: [{ messageId: "noFpTsHkt" }],
    },
    {
      code: `
        import type { hkt as H } from "fp-ts";
        type Box<F extends H.URIS, A> = H.Kind<F, A>;
      `,
      errors: [{ messageId: "noFpTsHkt" }],
    },
    {
      code: `
        import * as fpTs from "fp-ts";
        type Box<F extends fpTs.hkt.URIS, A> = fpTs.hkt.Kind<F, A>;
      `,
      errors: [{ messageId: "noFpTsHkt" }, { messageId: "noFpTsHkt" }],
    },
    {
      code: `
        import * as fpTs from "fp-ts";
        const hktModule = fpTs.hkt;
      `,
      errors: [{ messageId: "noFpTsHkt" }],
    },
    {
      code: `export type { Kind, URIS } from "fp-ts/lib/HKT.js";`,
      errors: [{ messageId: "noFpTsHkt" }],
    },
    {
      code: `export * from "fp-ts/lib/HKT.js";`,
      errors: [{ messageId: "noFpTsHkt" }],
    },
    {
      code: `export { hkt } from "fp-ts";`,
      errors: [{ messageId: "noFpTsHkt" }],
    },
    {
      code: `
        declare module "fp-ts/lib/HKT" {
          interface URItoKind<A> {
            readonly MyBox: { readonly item: A };
          }
        }
      `,
      errors: [{ messageId: "noFpTsHkt" }],
    },
    {
      code: `
        declare module "fp-ts/HKT" {
          interface URItoKind2<E, A> {
            readonly MyEither: E | A;
          }
        }
      `,
      errors: [{ messageId: "noFpTsHkt" }],
    },
    {
      code: `
        type Box<F extends import("fp-ts/lib/HKT").URIS, A> = import("fp-ts/lib/HKT").Kind<F, A>;
      `,
      errors: [{ messageId: "noFpTsHkt" }, { messageId: "noFpTsHkt" }],
    },
    {
      code: `
        type Box<F extends import("fp-ts").hkt.URIS, A> = import("fp-ts").hkt.Kind<F, A>;
      `,
      errors: [{ messageId: "noFpTsHkt" }, { messageId: "noFpTsHkt" }],
    },
  ],
});

ruleTester.run("no-fp-ts-hkt (ast fallback)", noFpTsHkt, {
  valid: [
    `
      import * as O from "fp-ts/lib/Option.js";
      import { flow } from "fp-ts/lib/function.js";
      const fn = flow(O.some, O.map((x: number) => x + 1));
    `,
    `
      type Kind = "ok" | "err";
      const k: Kind = "ok";
    `,
    `
      const bag = { hkt: 1 };
      const x = bag.hkt;
    `,
  ],
  invalid: [
    {
      code: `import type { Kind, URIS } from "fp-ts/lib/HKT.js";`,
      errors: [{ messageId: "noFpTsHkt" }],
    },
    {
      code: `
        import * as fpTs from "fp-ts";
        type Box<F extends fpTs.hkt.URIS, A> = fpTs.hkt.Kind<F, A>;
      `,
      errors: [{ messageId: "noFpTsHkt" }, { messageId: "noFpTsHkt" }],
    },
    {
      code: `
        import * as fpTs from "fp-ts";
        const hktModule = fpTs.hkt;
      `,
      errors: [{ messageId: "noFpTsHkt" }],
    },
    {
      code: `
        declare module "fp-ts/lib/HKT" {
          interface URItoKind<A> {
            readonly MyBox: { readonly item: A };
          }
        }
      `,
      errors: [{ messageId: "noFpTsHkt" }],
    },
  ],
});


