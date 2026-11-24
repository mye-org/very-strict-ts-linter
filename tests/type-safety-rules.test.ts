import { noAnyOrUnknown } from "../src/rules/no-any-or-unknown.js";
import { noDomainRawPrimitives } from "../src/rules/no-domain-raw-primitives.js";
import { noExplicitReturnType } from "../src/rules/no-explicit-return-type.js";
import { noNullUndefined } from "../src/rules/no-null-undefined.js";
import { preferReadonlyCollections } from "../src/rules/prefer-readonly-collections.js";
import { preferTypeOverInterface } from "../src/rules/prefer-type-over-interface.js";
import { preferUnionOverBoolean } from "../src/rules/prefer-union-over-boolean.js";
import { createRuleTester, createTypeAwareRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();
const typeAwareRuleTester = createTypeAwareRuleTester();

ruleTester.run("no-domain-raw-primitives", noDomainRawPrimitives, {
  valid: [
    `type CardId = Newtype<{ readonly CardId: unique symbol }, string>;`,
    `type Card = { readonly id: CardId; readonly status: { readonly kind: "learned" } | { readonly kind: "forgot" } };`,
    `const isEven = (n: number): boolean => n % 2 === 0;`,
  ],
  invalid: [
    {
      code: `type Card = { readonly id: string; readonly count: number; readonly isLearned: boolean };`,
      errors: [
        { messageId: "rawStringOrNumber" },
        { messageId: "rawStringOrNumber" },
        { messageId: "rawBoolean" },
      ],
    },
    {
      code: `class Card { readonly id: string = ""; constructor(public readonly count: number) {} }`,
      errors: [
        { messageId: "rawStringOrNumber" },
        { messageId: "rawStringOrNumber" },
      ],
    },
  ],
});

ruleTester.run("no-null-undefined", noNullUndefined, {
  valid: [
    `type MaybeCard = O.Option<Card>;`,
    `type User = { readonly name: UserName };`,
    `const empty = O.none;`,
    `const isStr = (x: unknown) => typeof x === "string";`,
    `const isEq = (a: number, b: number) => a === b;`,
    `const name = O.map((u: User) => u.name)(maybeUser);`,
  ],
  invalid: [
    {
      code: `type MaybeName = string | null;`,
      errors: [{ messageId: "noNullType" }],
    },
    {
      code: `type MaybeAge = number | undefined;`,
      errors: [{ messageId: "noUndefinedType" }],
    },
    {
      code: `type User = { readonly nickname?: string };`,
      errors: [{ messageId: "noOptionalProperty" }],
    },
    {
      code: `const x = null;`,
      errors: [{ messageId: "noNullLiteral" }],
    },
    {
      code: `const n = user?.name;`,
      errors: [{ messageId: "noOptionalChaining" }],
    },
    {
      code: `const first = items?.[0];`,
      errors: [{ messageId: "noOptionalChaining" }],
    },
    {
      code: `const res = fn?.();`,
      errors: [{ messageId: "noOptionalChaining" }],
    },
    {
      code: `const city = user?.address?.city;`,
      errors: [
        { messageId: "noOptionalChaining" },
        { messageId: "noOptionalChaining" },
      ],
    },
    {
      code: `const isNil = x === null;`,
      errors: [{ messageId: "noNullishCheck" }],
    },
    {
      code: `const isPresent = null !== x;`,
      errors: [{ messageId: "noNullishCheck" }],
    },
    {
      code: `const isLooseNil = x == null;`,
      errors: [{ messageId: "noNullishCheck" }],
    },
    {
      code: `const isUndef = x === undefined;`,
      errors: [{ messageId: "noNullishCheck" }],
    },
    {
      code: `const isDef = undefined !== x;`,
      errors: [{ messageId: "noNullishCheck" }],
    },
    {
      code: `const isVoid = x === void 0;`,
      errors: [{ messageId: "noNullishCheck" }],
    },
    {
      code: `const isTypeofUndef = typeof x === "undefined";`,
      errors: [{ messageId: "noNullishCheck" }],
    },
    {
      code: `const isTypeofDef = "undefined" !== typeof x;`,
      errors: [{ messageId: "noNullishCheck" }],
    },
    {
      code: `const val = a ?? b;`,
      errors: [{ messageId: "noNullishCheck" }],
    },
    {
      code: `a ??= b;`,
      errors: [{ messageId: "noNullishCheck" }],
    },
  ],
});

ruleTester.run("prefer-readonly-collections", preferReadonlyCollections, {
  valid: [
    `type Cards = ReadonlyArray<Card>;`,
    `type ReadonlyCards = readonly Card[];`,
    `type NonEmptyCards = readonly [Card, ...Card[]];`,
    `type Index = ReadonlyMap<CardId, Card>;`,
    `type Tags = ReadonlySet<Tag>;`,
  ],
  invalid: [
    {
      code: `type Cards = Card[];`,
      errors: [{ messageId: "preferReadonlyArray" }],
    },
    {
      code: `type Cards = Array<Card>;`,
      errors: [{ messageId: "preferReadonlyArray" }],
    },
    {
      code: `type Index = Map<CardId, Card>;`,
      errors: [{ messageId: "preferReadonlyMap" }],
    },
    {
      code: `type Tags = Set<Tag>;`,
      errors: [{ messageId: "preferReadonlySet" }],
    },
  ],
});

ruleTester.run("prefer-type-over-interface", preferTypeOverInterface, {
  valid: [
    `type Card = { readonly id: CardId };`,
    `type Status = { readonly kind: "open" } | { readonly kind: "closed" };`,
  ],
  invalid: [
    {
      code: `interface Card { readonly id: CardId }`,
      errors: [{ messageId: "preferType" }],
    },
    {
      code: `enum Status { Open, Closed }`,
      errors: [{ messageId: "preferUnionOverEnum" }],
    },
  ],
});

ruleTester.run("no-any-or-unknown", noAnyOrUnknown, {
  valid: [
    `const identity = <A>(a: A): A => a;`,
    `type Value = string | number;`,
  ],
  invalid: [
    {
      code: `const bad = (x: any): unknown => x;`,
      errors: [{ messageId: "noAny" }, { messageId: "noUnknown" }],
    },
  ],
});

ruleTester.run("no-explicit-return-type", noExplicitReturnType, {
  valid: [
    `const add = (a: number, b: number) => a + b;`,
    `const add = ((a: number, b: number) => a + b) satisfies (a: number, b: number) => number;`,
    `function greet(name: string) { return \`Hello \${name}\` as const; }`,
    `const fn = function (x: number) { return x * 2; };`,
    `class Foo { bar(x: number) { return x; } }`,
    `const obj = { bar(x: number) { return x; } };`,
    `const isString = (x: string | number): x is string => typeof x === "string";`,
    `type Mapper = (x: number) => string;`,
    `declare function parse(s: string): number;`,
    `
      function id(x: string): string;
      function id(x: number): number;
      function id(x: string | number) { return x; }
    `,
    `export const greet = ((name: string) => name) satisfies (name: string) => string;`,
    `
      type Greet = (name: string) => string;
      export const greet = ((name: string) => name) satisfies Greet;
    `,
    `export default ((a: number, b: number) => a + b) satisfies (a: number, b: number) => number;`,
    `export default (function (x: number) { return x * 2; }) satisfies (x: number) => number;`,
    `export const add = ((a: number, b: number) => a + b) satisfies (a: number, b: number) => number;`,
    `export const fn = (function (x: number) { return x * 2; }) satisfies (x: number) => number;`,
    `
      const add = ((a: number, b: number) => a + b) satisfies (a: number, b: number) => number;
      export { add };
    `,
    `
      const add = ((a: number, b: number) => a + b) satisfies (a: number, b: number) => number;
      export { add as sum };
    `,
    `
      const add = ((a: number, b: number) => a + b) satisfies (a: number, b: number) => number;
      export default add;
    `,
    `export const isString = ((x: unknown): x is string => typeof x === "string") satisfies (x: unknown) => x is string;`,
  ],
  invalid: [
    {
      code: `const add = (a: number, b: number): number => a + b;`,
      errors: [{ messageId: "noExplicitReturnType" }],
    },
    {
      code: `
        type Result = { readonly kind: "ok" } | { readonly kind: "err" };
        const ok = (): Result => ({ kind: "ok" });
      `,
      errors: [{ messageId: "noExplicitReturnType" }],
    },
    {
      code: `function greet(name: string): string { return name; }`,
      errors: [{ messageId: "noExplicitReturnType" }],
    },
    {
      code: `const fn = function (x: number): number { return x * 2; };`,
      errors: [{ messageId: "noExplicitReturnType" }],
    },
    {
      code: `class Foo { bar(x: number): number { return x; } }`,
      errors: [{ messageId: "noExplicitReturnType" }],
    },
    {
      code: `const obj = { bar(x: number): number { return x; } };`,
      errors: [{ messageId: "noExplicitReturnType" }],
    },
    {
      code: `const fetchVal = async (): Promise<number> => 1;`,
      errors: [{ messageId: "noExplicitReturnType" }],
    },
    {
      code: `
        export const outer = ((x: number) => {
          const helper = (y: number): number => y + 1;
          return helper(x);
        }) satisfies (x: number) => number;
      `,
      errors: [{ messageId: "noExplicitReturnType" }],
    },
    {
      code: `
        export const foo = ((x: number) => {
          const foo = (y: number): number => y;
          return foo(x);
        }) satisfies (x: number) => number;
      `,
      errors: [{ messageId: "noExplicitReturnType" }],
    },
    {
      code: `export const add = ((a: number, b: number): number => a + b) satisfies (a: number, b: number) => number;`,
      errors: [{ messageId: "noExplicitReturnType" }],
    },
    {
      code: `export function greet(name: string): string { return name; }`,
      errors: [{ messageId: "requireSatisfiesOnExportedFunction" }],
    },
    {
      code: `export function greet(name: string) { return name; }`,
      errors: [{ messageId: "requireSatisfiesOnExportedFunction" }],
    },
    {
      code: `export default function greet(name: string): string { return name; }`,
      errors: [{ messageId: "requireSatisfiesOnExportedFunction" }],
    },
    {
      code: `export default (a: number, b: number): number => a + b;`,
      errors: [{ messageId: "requireSatisfiesOnExportedFunction" }],
    },
    {
      code: `export default (a: number, b: number) => a + b;`,
      errors: [{ messageId: "requireSatisfiesOnExportedFunction" }],
    },
    {
      code: `export default function (x: number): number { return x * 2; }`,
      errors: [{ messageId: "requireSatisfiesOnExportedFunction" }],
    },
    {
      code: `export const add = (a: number, b: number): number => a + b;`,
      errors: [{ messageId: "requireSatisfiesOnExportedFunction" }],
    },
    {
      code: `export const add = (a: number, b: number) => a + b;`,
      errors: [{ messageId: "requireSatisfiesOnExportedFunction" }],
    },
    {
      code: `export const add: (a: number, b: number) => number = (a, b) => a + b;`,
      errors: [{ messageId: "requireSatisfiesOnExportedFunction" }],
    },
    {
      code: `export const fn = function (x: number): number { return x * 2; };`,
      errors: [{ messageId: "requireSatisfiesOnExportedFunction" }],
    },
    {
      code: `
        const add = (a: number, b: number): number => a + b;
        export { add };
      `,
      errors: [{ messageId: "requireSatisfiesOnExportedFunction" }],
    },
    {
      code: `
        const add = (a: number, b: number) => a + b;
        export { add };
      `,
      errors: [{ messageId: "requireSatisfiesOnExportedFunction" }],
    },
    {
      code: `
        const add = (a: number, b: number): number => a + b;
        export { add as sum };
      `,
      errors: [{ messageId: "requireSatisfiesOnExportedFunction" }],
    },
    {
      code: `
        const add = (a: number, b: number): number => a + b;
        export default add;
      `,
      errors: [{ messageId: "requireSatisfiesOnExportedFunction" }],
    },
    {
      code: `
        function greet(name: string): string { return name; }
        export { greet };
      `,
      errors: [{ messageId: "requireSatisfiesOnExportedFunction" }],
    },
    {
      code: `
        function greet(name: string): string { return name; }
        export default greet;
      `,
      errors: [{ messageId: "requireSatisfiesOnExportedFunction" }],
    },
  ],
});

typeAwareRuleTester.run("prefer-union-over-boolean", preferUnionOverBoolean, {
  valid: [
    `
      type AuthState =
        | { readonly kind: "authenticated"; readonly userId: string }
        | { readonly kind: "unauthenticated" };
      const render = (state: AuthState) => state.kind;
    `,
    `
      type Result<E, A> =
        | { readonly ok: true; readonly value: A }
        | { readonly ok: false; readonly error: E };
      const ok = <A>(value: A) => ({ ok: true as const, value });
    `,
    `type Card = { readonly isLearned: boolean };`,
    `const checkString = (x: string | number): x is string => typeof x === "string";`,
    `const isEven = (n: number) => n % 2 === 0;`,
    `function hasPermission(role: string) { return role === "admin"; }`,
    `const canEdit = (age: number) => age >= 18;`,
    `const shouldRetry = (code: number) => code >= 500;`,
    `
      type Predicate<A> = (a: A) => boolean;
      const validatePositive: Predicate<number> = (n) => n > 0;
    `,
    `
      type IsAdmin = (role: string) => boolean;
      type UserPredicate = (role: string) => boolean;
    `,
    `
      declare const RA: { filter: <A>(f: (a: A) => boolean) => (as: ReadonlyArray<A>) => ReadonlyArray<A> };
      const positives = RA.filter((n: number) => n > 0)([1, -1]);
    `,
    `
      declare const match: <T>(v: T) => { when: (p: (v: T) => unknown, h: () => number) => number };
      const res = match(1).when((n) => n > 0, () => 1);
    `,
    `
      declare const match: <T>(v: T) => { with: (p: T, h: () => number) => { exhaustive: () => number } };
      const sign = (n: number) => match(n > 0).with(true, () => 1).exhaustive();
    `,
    `
      declare const match: <T>(v: T) => {
        with: <R>(p: T, h: () => R) => {
          otherwise: <R2>(h: () => R2) => R | R2;
        };
      };
      const isPositive = (n: number) => match(n).with(0, () => false).otherwise(() => n > 0);
    `,
    `
      type Predicate<A> = (a: A) => boolean;
      declare const flow: <A, B>(ab: (a: A) => B) => (a: A) => B;
      declare const RA: { every: <A>(p: Predicate<A>) => Predicate<ReadonlyArray<A>> };
      const hasAllPositive = (xs: ReadonlyArray<number>) => RA.every(flow((n: number) => n > 0))(xs);
    `,
    `
      declare const pipe: <A, B>(a: A, ab: (a: A) => B) => B;
      const isPositive = (n: number) => pipe(n, (x) => x > 0);
    `,
  ],
  invalid: [
    {
      code: `const render = (isError: boolean) => (isError ? "err" : "ok");`,
      errors: [{ messageId: "preferUnionOverBooleanParam" }],
    },
    {
      code: `const render = (isError = false) => (isError ? "err" : "ok");`,
      errors: [{ messageId: "preferUnionOverBooleanParam" }],
    },
    {
      code: `type Flag = boolean;`,
      errors: [{ messageId: "preferUnionOverBooleanType" }],
    },
    {
      code: `type Pair = readonly [string, boolean];`,
      errors: [{ messageId: "preferUnionOverBooleanType" }],
    },
    {
      code: `
        type Box<A> = { readonly value: A };
        type BoxedBool = Box<boolean>;
      `,
      errors: [{ messageId: "preferUnionOverBooleanType" }],
    },
    {
      code: `
        type Newtype<URI, A> = { readonly URI: URI; readonly value: A };
        type BrandedFlag = Newtype<{ readonly F: unique symbol }, boolean>;
      `,
      errors: [{ messageId: "preferUnionOverBooleanType" }],
    },
    {
      code: `const validateUser = (age: number) => age >= 18;`,
      errors: [{ messageId: "preferUnionOverBooleanReturn" }],
    },
    {
      code: `function checkAccess(role: string) { return role === "admin"; }`,
      errors: [{ messageId: "preferUnionOverBooleanReturn" }],
    },
    {
      code: `
        declare const RA: { map: <A, B>(f: (a: A) => B) => (as: ReadonlyArray<A>) => ReadonlyArray<B> };
        const flags = RA.map((x: number) => x > 0)([1, 2]);
      `,
      errors: [{ messageId: "preferUnionOverBooleanReturn" }],
    },
    {
      code: `type ValidateUser = (age: number) => boolean;`,
      errors: [{ messageId: "preferUnionOverBooleanReturn" }],
    },
    {
      code: `const ok = true;`,
      errors: [{ messageId: "preferUnionOverBooleanVar" }],
    },
    {
      code: `const isValid = 1 > 0;`,
      errors: [{ messageId: "preferUnionOverBooleanVar" }],
    },
    {
      code: `const explicitFlag: boolean = false;`,
      errors: [{ messageId: "preferUnionOverBooleanVar" }],
    },
  ],
});

