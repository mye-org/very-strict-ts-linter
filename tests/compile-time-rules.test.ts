import { noOptionalStateBags } from "../src/rules/no-optional-state-bags.js";
import { parseDontValidate } from "../src/rules/parse-dont-validate.js";
import { preferConstSatisfies } from "../src/rules/prefer-const-satisfies.js";
import { preferExhaustiveRecord } from "../src/rules/prefer-exhaustive-record.js";
import { preferNonemptyTuple } from "../src/rules/prefer-nonempty-tuple.js";
import { preferTemplateLiteralType } from "../src/rules/prefer-template-literal-type.js";
import { preferTypeLevelDispatch } from "../src/rules/prefer-type-level-dispatch.js";
import { requireKeyofPath } from "../src/rules/require-keyof-path.js";
import { createRuleTester, createTypeAwareRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();
const typeAwareRuleTester = createTypeAwareRuleTester();

ruleTester.run("prefer-const-satisfies", preferConstSatisfies, {
  valid: [
    `const HANDLERS = { create: 1, delete: 2 } as const satisfies Record<string, number>;`,
    `const ROLES = ["admin", "user"] as const satisfies ReadonlyArray<string>;`,
    `const BY_KIND: Record<"a" | "b", number> = { a: 1, b: 2 };`,
    `const EMPTY: Record<string, number> = {};`,
    `const EMPTY_ARR: ReadonlyArray<number> = [];`,
  ],
  invalid: [
    {
      code: `const HANDLERS: Record<string, number> = { create: 1, delete: 2 };`,
      errors: [{ messageId: "preferConstSatisfiesObject" }],
    },
    {
      code: `const HANDLERS: Readonly<Record<string, number>> = { create: 1 };`,
      errors: [{ messageId: "preferConstSatisfiesObject" }],
    },
    {
      code: `const MAP: { readonly [k: string]: number } = { a: 1 };`,
      errors: [{ messageId: "preferConstSatisfiesObject" }],
    },
    {
      code: `const ROLES: ReadonlyArray<string> = ["admin", "user"];`,
      errors: [{ messageId: "preferConstSatisfiesArray" }],
    },
    {
      code: `const NUMS: number[] = [1, 2, 3];`,
      errors: [{ messageId: "preferConstSatisfiesArray" }],
    },
  ],
});

ruleTester.run("no-optional-state-bags", noOptionalStateBags, {
  valid: [
    `
      type Order =
        | { readonly kind: "draft" }
        | { readonly kind: "shipped"; readonly trackingId: TrackingId };
    `,
    `type Profile = { readonly bio: O.Option<Bio>; readonly name: UserName };`,
    `type Config = { readonly timeout: TimeoutMs };`,
  ],
  invalid: [
    {
      code: `
        type Order = {
          readonly status: "draft" | "shipped";
          readonly trackingId: O.Option<TrackingId>;
        };
      `,
      errors: [{ messageId: "discriminatedOptionalBag" }],
    },
    {
      code: `
        type Order = {
          readonly kind: "active";
          readonly note?: string;
        };
      `,
      errors: [{ messageId: "discriminatedOptionalBag" }],
    },
    {
      code: `
        type Connection = {
          readonly token: O.Option<Token>;
          readonly apiKey: O.Option<ApiKey>;
        };
      `,
      errors: [{ messageId: "multipleOptionalBag" }],
    },
  ],
});

typeAwareRuleTester.run("prefer-type-level-dispatch", preferTypeLevelDispatch, {
  valid: [
    `
      type ResultMap = { readonly json: { readonly data: string }; readonly csv: ReadonlyArray<string> };
      declare const parse: <K extends keyof ResultMap>(fmt: K) => ResultMap[K];
    `,
    `
      declare const match: <T>(v: T) => {
        with: <R>(p: T, h: () => R) => {
          with: <R2>(p2: T, h2: () => R2) => {
            exhaustive: () => R | R2;
          };
        };
      };
      const label = (k: "a" | "b") =>
        match(k).with("a", () => "Alpha").with("b", () => "Beta").exhaustive();
    `,
    `
      type Option<A> = { readonly _tag: "None" } | { readonly _tag: "Some"; readonly value: A };
      declare const some: <A>(a: A) => Option<A>;
      declare const none: Option<never>;
      declare const match: <T>(v: T) => {
        with: <R>(p: T, h: () => R) => {
          with: <R2>(p2: T, h2: () => R2) => {
            exhaustive: () => R | R2;
          };
        };
      };
      const maybeNum = (k: "one" | "zero") =>
        match(k).with("one", () => some(1)).with("zero", () => none).exhaustive();
    `,
  ],
  invalid: [
    {
      code: `
        declare const match: <T>(v: T) => {
          with: <R>(p: T, h: () => R) => {
            with: <R2>(p2: T, h2: () => R2) => {
              exhaustive: () => R | R2;
            };
          };
        };
        const parse = (fmt: "json" | "num") =>
          match(fmt)
            .with("json", () => ({ ok: true }))
            .with("num", () => 42)
            .exhaustive();
      `,
      errors: [{ messageId: "preferTypeLevelDispatch" }],
    },
  ],
});

typeAwareRuleTester.run("prefer-template-literal-type", preferTemplateLiteralType, {
  valid: [
    `type EventName = \`\${"user" | "post"}:\${"read" | "write"}\`;`,
    `type Route = \`/\${string}\`;`,
    `const navigate = (route: \`/\${string}\`) => route;`,
    `const isUserPrefixed = (id: string) => id.startsWith("usr_");`,
    `const parseUserId = (raw: string) => raw.startsWith("usr_");`,
    `type Status = "open" | "closed" | "pending" | "archived";`,
  ],
  invalid: [
    {
      code: `type EventName = "user:read" | "user:write" | "post:read" | "post:write";`,
      errors: [{ messageId: "preferTemplateLiteralUnion" }],
    },
    {
      code: `const navigate = (route: string) => route.startsWith("/");`,
      errors: [{ messageId: "preferTemplateLiteralGuard" }],
    },
    {
      code: `const formatId = (id: string) => /^usr_/.test(id);`,
      errors: [{ messageId: "preferTemplateLiteralGuard" }],
    },
  ],
});

typeAwareRuleTester.run("prefer-exhaustive-record", preferExhaustiveRecord, {
  valid: [
    `
      type Kind = "a" | "b";
      type Handlers = Record<Kind, () => number>;
    `,
    `type MyOptions = Partial<Record<"a" | "b", number>>;`,
    `
      type Kind = "a" | "b";
      declare const handlers: Record<Kind, number>;
      declare const k: Kind;
      const v = handlers[k];
    `,
    `
      declare const headers: Record<string, string>;
      const ct = headers["content-type"];
    `,
  ],
  invalid: [
    {
      code: `
        type Kind = "a" | "b";
        type Handlers = Partial<Record<Kind, number>>;
      `,
      errors: [{ messageId: "noPartialFiniteRecord" }],
    },
    {
      code: `
        type Kind = "a" | "b";
        declare const handlers: Record<string, number>;
        declare const k: Kind;
        const v = handlers[k];
      `,
      errors: [{ messageId: "preferFiniteRecordLookup" }],
    },
    {
      code: `
        type Kind = "a" | "b";
        declare const handlers: ReadonlyMap<string, number>;
        declare const k: Kind;
        const v = handlers.get(k);
      `,
      errors: [{ messageId: "preferFiniteRecordLookup" }],
    },
    {
      code: `
        const obj = { a: 1, b: 2 } as const;
        const ks = Object.keys(obj);
      `,
      errors: [{ messageId: "noObjectKeysWidening" }],
    },
  ],
});

typeAwareRuleTester.run("prefer-nonempty-tuple", preferNonemptyTuple, {
  valid: [
    `const head = (xs: readonly [number, ...ReadonlyArray<number>]) => { const [h] = xs; return h; };`,
    `const nonEmpty = [1, 2, 3].filter((x) => x > 0);`,
    `
      declare const items: ReadonlyArray<ReadonlyArray<string>>;
      const valid = items.filter((f) => f.length > 0);
    `,
    `const isEmpty = (xs: ReadonlyArray<number>) => xs.length === 0;`,
    `const formatList = (xs: ReadonlyArray<string>) => xs.length === 0 ? "None" : xs.join(",");`,
  ],
  invalid: [
    {
      code: `const firstTwo = (xs: ReadonlyArray<number>) => { const [a, b] = xs; return a + b; };`,
      errors: [{ messageId: "preferTupleDestructuring" }],
    },
    {
      code: `const pairSum = (xs: ReadonlyArray<number>) => xs.length === 2 ? xs[0] + xs[1] : 0;`,
      errors: [{ messageId: "preferNonEmptyOrFixedTuple" }],
    },
    {
      code: `
        declare const O: { none: unknown; some: <A>(a: A) => unknown };
        const headOrNone = (xs: ReadonlyArray<number>) => xs.length === 0 ? O.none : O.some(xs[0]);
      `,
      errors: [{ messageId: "preferNonEmptyOrFixedTuple" }],
    },
    {
      code: `
        declare const E: { left: <E>(e: E) => unknown; right: <A>(a: A) => unknown };
        const headOrErr = (xs: ReadonlyArray<number>) => xs.length === 0 ? E.left("empty") : E.right(xs[0]);
      `,
      errors: [{ messageId: "preferNonEmptyOrFixedTuple" }],
    },
  ],
});

typeAwareRuleTester.run("require-keyof-path", requireKeyofPath, {
  valid: [
    `const pick = <T, K extends keyof T>(obj: T, key: K) => obj[key];`,
    `const pickUnsafe = <T extends Record<string, number>>(obj: T, key: string) => obj[key];`,
  ],
  invalid: [
    {
      code: `const pick = (obj: { readonly a: number } & Record<string, number>, key: string) => obj[key];`,
      errors: [{ messageId: "requireKeyofParam" }],
    },
    {
      code: `const hasKey = (obj: { readonly a: number }, key: string) => key in obj;`,
      errors: [{ messageId: "requireKeyofParam" }],
    },
    {
      code: `const getPath = (obj: { readonly a: { readonly b: number } }, path: string) => path.split(".");`,
      errors: [{ messageId: "requireTypedPathParam" }],
    },
  ],
});

typeAwareRuleTester.run("parse-dont-validate", parseDontValidate, {
  valid: [
    `
      type Email = { readonly _tag: "Email"; readonly value: string };
      const isEmail = (s: string): s is Email & string => s.includes("@");
    `,
    `
      type Either<E, A> = { readonly _tag: "Left"; readonly left: E } | { readonly _tag: "Right"; readonly right: A };
      declare const right: <A>(a: A) => Either<never, A>;
      const validateEmail = (s: string) => right(s);
    `,
    `
      type AstNode = { readonly kind: string };
      const isValidCallTarget = (n: AstNode) => n.kind === "call";
    `,
    `const parseAmount = (n: number) => n <= 0;`,
  ],
  invalid: [
    {
      code: `const validateEmail = (s: string) => s.includes("@");`,
      errors: [{ messageId: "parseDontValidateFunction" }],
    },
    {
      code: `const isValidEmail = (s: string) => s.includes("@");`,
      errors: [{ messageId: "parseDontValidateFunction" }],
    },
    {
      code: `const charge = (amount: number) => amount <= 0 ? 0 : amount;`,
      errors: [{ messageId: "noShotgunValidation" }],
    },
    {
      code: `const sendEmail = (email: string) => email.includes("@");`,
      errors: [{ messageId: "noShotgunValidation" }],
    },
  ],
});
