import { preferExpressiveTsPattern } from "../src/rules/prefer-expressive-ts-pattern.js";
import { createRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();

ruleTester.run("prefer-expressive-ts-pattern", preferExpressiveTsPattern, {
  valid: [
    // Expressive structural matching with P.select and wildcards
    `const html = match(result)
      .with({ type: "error" }, () => "oops")
      .with({ type: "ok", data: { type: "img", src: P.select() } }, (src) => src)
      .exhaustive();`,
    // Expressive type-specific wildcards
    `const toStr = (v: unknown) => match(v)
      .with(P.string, (s) => s)
      .with(P.number, (n) => n.toFixed(2))
      .with(P.boolean, (b) => String(b))
      .with(P.nullish, () => "empty")
      .otherwise(() => "other");`,
    // Expressive tuple + P._ wildcards
    `const evalExpr = (input: [number, string, number]) => match(input)
      .with([P._, "+", P._], ([x, , y]) => x + y)
      .with([P._, "-", P._], ([x, , y]) => x - y)
      .otherwise(() => 0);`,
    // Expressive predicates & combinators
    `const classify = (s: string) => match(s)
      .with(P.string.startsWith("TS"), () => "ts")
      .with(P.not("unknown"), () => "known")
      .otherwise(() => "unknown");`,
    // Multi-pattern .with()
    `const tagKind = (tag: string) => match(tag)
      .with("text", "span", "p", () => "inline")
      .with("btn", "button", () => "button")
      .otherwise(() => "other");`,
    // match(obj.prop) when obj itself is NOT referenced in handlers
    `const label = (node: { type: string }) => match(node.type)
      .with("Identifier", () => "id")
      .otherwise(() => "other");`,
    // Non-trivial .when() predicate (e.g. Set.has)
    `const check = (m: string) => match(m)
      .with(P.when((x) => SET.has(x)), () => true)
      .otherwise(() => false);`,
    // Duplicate handlers when P.select() is used (cannot be combined into multi-pattern .with)
    `const pick = (x: { a: string } | { b: string }) => match(x)
      .with({ a: P.select() }, (v) => v)
      .with({ b: P.select() }, (v) => v)
      .exhaustive();`,
    // String.prototype.match is not ts-pattern
    `const m = "hello".match(/ell/);`,
    // Multi-binding deep destructuring is allowed
    `const fmt = (x: { user: { first: string; last: string } }) => match(x)
      .with({ user: P._ }, ({ user: { first, last } }) => first + last)
      .exhaustive();`,
  ],
  invalid: [
    // 1. match(true) / match(false)
    {
      code: `const f = (a: number, b: string) => match(true)
        .when(() => a > 0, () => "pos")
        .when(() => b === "ok", () => "ok")
        .otherwise(() => "other");`,
      errors: [{ messageId: "noMatchTrue" }],
    },
    {
      code: `const f = (a: number) => match(false)
        .when(() => a > 0, () => "non-pos")
        .otherwise(() => "pos");`,
      errors: [{ messageId: "noMatchTrue" }],
    },
    // 2. typeof / instanceof / Array.isArray / nullish checks
    {
      code: `const f = (x: unknown) => match(typeof x)
        .with("string", () => "str")
        .otherwise(() => "other");`,
      errors: [{ messageId: "preferTypeWildcard" }],
    },
    {
      code: `const f = (x: unknown) => match(x)
        .when((v) => typeof v === "string", () => "str")
        .when((v) => v instanceof Error, () => "err")
        .when((v) => Array.isArray(v), () => "arr")
        .when((v) => v === null || v === undefined, () => "nil")
        .otherwise(() => "other");`,
      errors: [
        { messageId: "preferTypeWildcard" },
        { messageId: "preferTypeWildcard" },
        { messageId: "preferTypeWildcard" },
        { messageId: "preferTypeWildcard" },
      ],
    },
    {
      code: `const f = (x: unknown) => match(x)
        .when((v) => v != null, () => "present")
        .otherwise(() => "nil");`,
      errors: [{ messageId: "preferTypeWildcard" }],
    },
    // 3. Matching on obj.prop while reading obj in handler
    {
      code: `const f = (event: { type: "ok"; data: string } | { type: "err"; error: Error }) =>
        match(event.type)
          .with("ok", () => event.data)
          .with("err", () => event.error.message)
          .exhaustive();`,
      errors: [{ messageId: "preferWholeObjectMatch" }],
    },
    // 4. Nested match inside handler
    {
      code: `const f = (a: string, b: number) =>
        match(a)
          .with("x", () => match(b).with(1, () => "one").otherwise(() => "other"))
          .otherwise(() => "none");`,
      errors: [{ messageId: "noNestedMatch" }],
    },
    // 5. Trivial .when() predicates replaceable by P.* matchers
    {
      code: `const f = (s: string) => match(s)
        .when((v) => v !== "loading", () => "ready")
        .when((v) => v.startsWith("err:"), () => "error")
        .when((v) => /^[a-z]+$/.test(v), () => "word")
        .otherwise(() => "other");`,
      errors: [
        { messageId: "preferPatternOverWhen" },
        { messageId: "preferPatternOverWhen" },
        { messageId: "preferPatternOverWhen" },
      ],
    },
    {
      code: `const f = (n: number) => match(n)
        .when((v) => v > 10, () => "big")
        .when((v) => v >= 1 && v <= 5, () => "mid")
        .when((v) => Number.isInteger(v), () => "int")
        .otherwise(() => "other");`,
      errors: [
        { messageId: "preferPatternOverWhen" },
        { messageId: "preferPatternOverWhen" },
        { messageId: "preferPatternOverWhen" },
      ],
    },
    // 6. Consecutive .with() with identical handlers
    {
      code: `const f = (tag: string) => match(tag)
        .with("text", () => "inline")
        .with("span", () => "inline")
        .otherwise(() => "block");`,
      errors: [{ messageId: "preferMultiPatternWith" }],
    },
    // 7. Deep single-leaf destructuring instead of P.select()
    {
      code: `const f = (x: { user: { name: string } }) => match(x)
        .with({ user: P._ }, ({ user: { name } }) => name)
        .exhaustive();`,
      errors: [{ messageId: "preferSelectOverDeepDestructure" }],
    },
    // 8. Opt-in: preferOtherwiseOverCatchAll
    {
      code: `const f = (x: string) => match(x)
        .with("a", () => 1)
        .with(P._, () => 0)
        .exhaustive();`,
      options: [{ preferOtherwiseOverCatchAll: true }],
      errors: [{ messageId: "preferOtherwiseOverCatchAll" }],
    },
    // 9. Opt-in: preferTernaryOverBooleanMatch
    {
      code: `const f = (ok: boolean) => match(ok)
        .with(true, () => 1)
        .with(false, () => 0)
        .exhaustive();`,
      options: [{ preferTernaryOverBooleanMatch: true }],
      errors: [{ messageId: "preferTernaryOverBooleanMatch" }],
    },
  ],
});
