import path from "node:path";
import { noDataClumps } from "../src/rules/no-data-clumps.js";
import { noScatteredValidation } from "../src/rules/no-scattered-validation.js";
import { noStringlyTypedDiscriminants } from "../src/rules/no-stringly-typed-discriminants.js";
import { noUnitSuffixedPrimitives } from "../src/rules/no-unit-suffixed-primitives.js";
import { createTypeAwareRuleTester } from "./rule-tester.js";

const typeAwareRuleTester = createTypeAwareRuleTester();
const fixturePath = (...parts: ReadonlyArray<string>) =>
  path.resolve(import.meta.dirname, "fixtures", ...parts);

typeAwareRuleTester.run("no-data-clumps", noDataClumps, {
  valid: [
    `
      type Money = { readonly amount: number; readonly currency: string };
      const charge = (m: Money) => m;
      const refund = (m: Money) => m;
    `,
    `
      const f1 = (amount: number, currency: string) => amount;
      const f2 = (lat: number, lng: number) => lat;
    `,
  ],
  invalid: [
    {
      code: `
        const formatMoney = (amount: number, currency: string) => \`\${amount} \${currency}\`;
        const addTax = (amount: number, currency: string) => amount * 1.1;
        type InvoiceDto = { readonly amount: number; readonly currency: string };
      `,
      errors: [
        { messageId: "dataClump" },
        { messageId: "dataClump" },
        { messageId: "dataClump" },
      ],
    },
    {
      code: `
        class GeoService {
          distance(lat: number, lng: number) { return lat + lng; }
          locate(lat: number, lng: number) { return lat; }
        }
        type PointDto = { readonly lat: number; readonly lng: number };
      `,
      options: [{ minSize: 2, minOccurrences: 3 }],
      errors: [
        { messageId: "dataClump" },
        { messageId: "dataClump" },
        { messageId: "dataClump" },
      ],
    },
  ],
});

typeAwareRuleTester.run("no-unit-suffixed-primitives", noUnitSuffixedPrimitives, {
  valid: [
    `
      type Newtype<URI, A> = { readonly URI: URI; readonly value: A };
      type Cents = Newtype<{ readonly Cents: unique symbol }, number>;
      type Product = { readonly priceInCents: Cents };
    `,
    `
      type EmailAddress = string & { readonly __brand: "EmailAddress" };
      const send = (userEmail: EmailAddress) => userEmail;
    `,
    `const double = (n: number) => n * 2;`,
  ],
  invalid: [
    {
      code: `type Item = { readonly priceInCents: number; readonly userEmail: string };`,
      errors: [
        { messageId: "unitSuffixedPrimitive" },
        { messageId: "unitSuffixedPrimitive" },
      ],
    },
    {
      code: `class Shipment { weightKg: number = 0; }`,
      errors: [{ messageId: "unitSuffixedPrimitive" }],
    },
    {
      code: `const timeoutMs = 5000;`,
      errors: [{ messageId: "unitSuffixedPrimitive" }],
    },
    {
      code: `const applyDiscount = (discountPercent: number) => discountPercent;`,
      errors: [{ messageId: "unitSuffixedPrimitive" }],
    },
  ],
});

typeAwareRuleTester.run("no-scattered-validation", noScatteredValidation, {
  valid: [
    {
      filename: fixturePath("domain/value-objects/email.ts"),
      code: `export const normalizeEmail = (raw: string) => /^[^@]+@[^@]+$/.test(raw.trim().toLowerCase());`,
    },
    `
      type Email = string & { readonly __brand: "Email" };
      const createEmail = (raw: string): Email => raw.trim().toLowerCase() as Email;
    `,
    `
      class EmailAddress {
        readonly value: string;
        constructor(raw: string) {
          this.value = raw.trim().toLowerCase();
        }
      }
    `,
    `const EMAIL_RE = /^[^@]+@[^@]+$/;`,
  ],
  invalid: [
    {
      code: `const check = (s: string) => /^[^@]+@[^@]+$/.test(s);`,
      errors: [{ messageId: "scatteredRegex" }],
    },
    {
      code: `const handleSignup = (email: string) => email.trim().toLowerCase();`,
      errors: [{ messageId: "scatteredNormalization" }],
    },
    {
      code: `
        declare const isValidEmail: (s: string) => boolean;
        const submit = (email: string) => isValidEmail(email);
      `,
      errors: [{ messageId: "scatteredValidationCall" }],
    },
  ],
});

typeAwareRuleTester.run("no-stringly-typed-discriminants", noStringlyTypedDiscriminants, {
  valid: [
    `
      type Status = "PENDING" | "PAID";
      const describe = (status: Status) =>
        status === "PENDING" ? 0 : status === "PAID" ? 1 : 2;
    `,
    `
      type OrderState = { readonly kind: "pending" } | { readonly kind: "paid" };
      declare const match: <T>(v: T) => { with: (p: unknown, f: () => number) => { exhaustive: () => number } };
      const label = (s: OrderState) => match(s).with({ kind: "pending" }, () => 1).exhaustive();
    `,
  ],
  invalid: [
    {
      code: `
        const label = (status: string) => {
          if (status === "PENDING") return 0;
          if (status === "PAID") return 1;
          return 2;
        };
      `,
      errors: [
        { messageId: "stringlyTypedDiscriminant" },
        { messageId: "stringlyTypedDiscriminant" },
      ],
    },
    {
      code: `
        const label = (status: string) => {
          switch (status) {
            case "PENDING": return 0;
            case "PAID": return 1;
            default: return 2;
          }
        };
      `,
      errors: [
        { messageId: "stringlyTypedDiscriminant" },
        { messageId: "stringlyTypedDiscriminant" },
      ],
    },
    {
      code: `
        declare const match: <T>(v: T) => {
          with: (p: unknown, f: () => number) => {
            with: (p: unknown, f: () => number) => { otherwise: (f: () => number) => number };
          };
        };
        const label = (status: string) =>
          match(status).with("PENDING", () => 0).with("PAID", () => 1).otherwise(() => 2);
      `,
      errors: [
        { messageId: "stringlyTypedDiscriminant" },
        { messageId: "stringlyTypedDiscriminant" },
      ],
    },
  ],
});
