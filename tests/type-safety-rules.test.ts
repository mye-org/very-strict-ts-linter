import { noAnyOrUnknown } from "../src/rules/no-any-or-unknown.js";
import { noDomainRawPrimitives } from "../src/rules/no-domain-raw-primitives.js";
import { noNullUndefined } from "../src/rules/no-null-undefined.js";
import { preferReadonlyCollections } from "../src/rules/prefer-readonly-collections.js";
import { preferTypeOverInterface } from "../src/rules/prefer-type-over-interface.js";
import { createRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();

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
  ],
});

ruleTester.run("no-null-undefined", noNullUndefined, {
  valid: [
    `type MaybeCard = O.Option<Card>;`,
    `type User = { readonly name: UserName };`,
    `const empty = O.none;`,
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
  ],
});

ruleTester.run("prefer-readonly-collections", preferReadonlyCollections, {
  valid: [
    `type Cards = ReadonlyArray<Card>;`,
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
