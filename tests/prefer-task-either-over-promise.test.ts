import { preferTaskEitherOverPromise } from "../src/rules/prefer-task-either-over-promise.js";
import { createTypeAwareRuleTester } from "./rule-tester.js";

const typeAwareRuleTester = createTypeAwareRuleTester();

typeAwareRuleTester.run(
  "prefer-task-either-over-promise",
  preferTaskEitherOverPromise,
  {
    valid: [
      // fp-ts TaskEither / Task usage
      `
        declare const TE: {
          tryCatch: <E, A>(f: () => Promise<A>, onRejected: (reason: unknown) => E) => unknown;
          flatMap: <A, E, B>(f: (a: A) => unknown) => (ma: unknown) => unknown;
        };
        declare const flow: <A, B, C>(ab: (a: A) => B, bc: (b: B) => C) => (a: A) => C;
        const loadData = () =>
          TE.tryCatch(() => Promise.resolve(1), (e) => String(e));
      `,
      // Inside unsafe* prefixed function
      `
        function unsafeCreatePromise(): Promise<number> {
          return new Promise((resolve) => resolve(42));
        }
      `,
      `
        const unsafeChain = (p: Promise<number>): Promise<number> =>
          p.then((x) => x + 1).catch(() => 0);
      `,
      // Inside *Unsafe suffixed or must* prefixed function
      `
        const fetchUnsafe = (): Promise<number> =>
          new Promise((resolve) => resolve(1));
      `,
      `
        const mustResolve = (p: Promise<string>): Promise<string> =>
          p.then((s) => s.trim());
      `,
      // Non-Promise object with .then / .catch method
      `
        const customBuilder = {
          then: (fn: (n: number) => number) => fn(1),
          catch: (fn: () => number) => fn(),
        };
        const a = customBuilder.then((n) => n + 1);
        const b = customBuilder.catch(() => 0);
      `,
    ],
    invalid: [
      {
        code: `const p = new Promise<number>((resolve) => resolve(1));`,
        errors: [{ messageId: "preferTaskEitherNewPromise" }],
      },
      {
        code: `
          declare const p: Promise<number>;
          const next = p.then((x) => x + 1);
        `,
        errors: [{ messageId: "preferTaskEitherPromiseChain" }],
      },
      {
        code: `
          declare const p: Promise<number>;
          const safe = p.catch(() => 0);
        `,
        errors: [{ messageId: "preferTaskEitherPromiseChain" }],
      },
      {
        code: `
          const load = () =>
            Promise.resolve(1)
              .then((x) => x + 1)
              .catch(() => 0);
        `,
        errors: [
          { messageId: "preferTaskEitherPromiseChain" },
          { messageId: "preferTaskEitherPromiseChain" },
        ],
      },
    ],
  },
);
