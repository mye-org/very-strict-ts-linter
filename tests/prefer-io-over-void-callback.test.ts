import { preferIoOverVoidCallback } from "../src/rules/prefer-io-over-void-callback.js";
import { createTypeAwareRuleTester } from "./rule-tester.js";

const ruleTester = createTypeAwareRuleTester();

ruleTester.run("prefer-io-over-void-callback", preferIoOverVoidCallback, {
  valid: [
    // Pure value-returning callbacks in RA.map / O.map
    `
      declare const RA: { map: <A, B>(f: (a: A) => B) => (as: ReadonlyArray<A>) => ReadonlyArray<B> };
      const doubled = RA.map((n: number) => n * 2);
    `,
    `
      declare const O: { map: <A, B>(f: (a: A) => B) => (fa: unknown) => unknown };
      const upper = O.map((s: string) => {
        const trimmed = s.trim();
        return trimmed.toUpperCase();
      });
    `,
    // Returning IO<void> (i.e. () => void) is valid
    `
      declare const RA: {
        map: <A, B>(f: (a: A) => B) => (as: ReadonlyArray<A>) => ReadonlyArray<B>;
        traverse: (app: unknown) => <A, B>(f: (a: A) => () => B) => (as: ReadonlyArray<A>) => () => ReadonlyArray<B>;
      };
      declare const IO: { Applicative: unknown };
      declare const report: (s: string) => void;
      const eff = RA.traverse(IO.Applicative)((s: string) => () => report(s));
      const mappedIo = RA.map((s: string) => () => report(s));
    `,
    // ts-pattern match returning values
    `
      declare function match<T>(v: T): {
        with: (p: unknown, fn: (x: T) => number) => { exhaustive: () => number };
      };
      const res = match("a").with("a", () => 1).exhaustive();
    `,
    // Empty no-op block () => {} is not flagged
    `
      declare function match<T>(v: T): {
        with: (p: unknown, fn: () => void) => { otherwise: (fn: () => void) => void };
      };
      const res = match("a").with("a", () => {}).otherwise(() => {});
    `,
    // Nested function with return does not confuse outer block without return? Wait: outer has return, valid
    `
      declare const O: { map: <A, B>(f: (a: A) => B) => (fa: unknown) => unknown };
      const fn = O.map((x: number) => {
        const inner = () => x + 1;
        return inner();
      });
    `,
    // Report function returning a value (non-void) in O.map
    `
      declare const O: { map: <A, B>(f: (a: A) => B) => (fa: unknown) => unknown };
      declare function report(x: number): string;
      const r = O.map((x: number) => report(x));
    `,
  ],
  invalid: [
    // RA.map with block statement without return
    {
      code: `
        declare const RA: { map: <A, B>(f: (a: A) => B) => (as: ReadonlyArray<A>) => ReadonlyArray<B> };
        declare const report: (s: string) => void;
        const r = RA.map((s: string) => {
          report(s);
        });
      `,
      errors: [{ messageId: "preferIoOverVoidCallback" }],
    },
    // O.map with block statement without return (and nested function that DOES return)
    {
      code: `
        declare const O: { map: <A, B>(f: (a: A) => B) => (fa: unknown) => unknown };
        declare const console: { log: (x: unknown) => void };
        const r = O.map((s: string) => {
          const fmt = (v: string) => {
            return v.trim();
          };
          console.log(fmt(s));
        });
      `,
      errors: [{ messageId: "preferIoOverVoidCallback" }],
    },
    // RA.map with void-returning expression (typed void)
    {
      code: `
        declare const RA: { map: <A, B>(f: (a: A) => B) => (as: ReadonlyArray<A>) => ReadonlyArray<B> };
        declare const console: { log: (x: unknown) => void };
        const r = RA.map((s: string) => console.log(s));
      `,
      errors: [{ messageId: "preferIoOverVoidCallback" }],
    },
    // O.map with void-returning expression (typed void)
    {
      code: `
        declare const O: { map: <A, B>(f: (a: A) => B) => (fa: unknown) => unknown };
        declare const fs: { writeFileSync: (p: string, d: string) => void };
        const r = O.map((s: string) => fs.writeFileSync("out.txt", s));
      `,
      errors: [{ messageId: "preferIoOverVoidCallback" }],
    },
    // RA.map with point-free void function reference
    {
      code: `
        declare const RA: { map: <A, B>(f: (a: A) => B) => (as: ReadonlyArray<A>) => ReadonlyArray<B> };
        declare const logItem: (s: string) => void;
        const r = RA.map(logItem);
      `,
      errors: [{ messageId: "preferIoOverVoidCallback" }],
    },
    // match(...).with(...) with block statement without return
    {
      code: `
        declare function match<T>(v: T): {
          with: (p: unknown, fn: (x: T) => void) => { exhaustive: () => void };
        };
        declare const report: (s: string) => void;
        const r = match("a").with("a", (v) => {
          report(v);
        }).exhaustive();
      `,
      errors: [{ messageId: "preferIoOverVoidCallback" }],
    },
    // match(...).otherwise(...) with block statement without return
    {
      code: `
        declare function match<T>(v: T): {
          with: (p: unknown, fn: () => void) => { otherwise: (fn: () => void) => void };
        };
        declare const console: { warn: (s: string) => void };
        const r = match("a")
          .with("a", () => {
            console.warn("a");
          })
          .otherwise(() => {
            console.warn("other");
          });
      `,
      errors: [
        { messageId: "preferIoOverVoidCallback" },
        { messageId: "preferIoOverVoidCallback" },
      ],
    },
  ],
});
