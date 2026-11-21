import path from "node:path";
import { domainLayerPurity } from "../src/rules/domain-layer-purity.js";
import { noCrossAggregateReference } from "../src/rules/no-cross-aggregate-reference.js";
import { noModelPolysemy } from "../src/rules/no-model-polysemy.js";
import { repositoryAggregateRootOnly } from "../src/rules/repository-aggregate-root-only.js";
import { ubiquitousLanguage } from "../src/rules/ubiquitous-language.js";
import { createDddSampleRuleTester, createTypeAwareRuleTester } from "./rule-tester.js";

const typeAwareRuleTester = createTypeAwareRuleTester();
const dddSampleRuleTester = createDddSampleRuleTester();
const fixturePath = (...parts: ReadonlyArray<string>) =>
  path.resolve(import.meta.dirname, "fixtures", ...parts);
const samplePath = (...parts: ReadonlyArray<string>) =>
  path.resolve(import.meta.dirname, "ddd-sample", ...parts);

typeAwareRuleTester.run("no-model-polysemy", noModelPolysemy, {
  valid: [
    `
      type Address = { readonly street: string; readonly city: string };
      const format = (a: Address) => a.street + a.city;
    `,
  ],
  invalid: [],
});

dddSampleRuleTester.run("no-model-polysemy (cross-file)", noModelPolysemy, {
  valid: [],
  invalid: [
    {
      filename: samplePath("models.ts"),
      code: `
        export type Customer = {
          readonly id: string;
          readonly taxId: string;
          readonly billingAddress: string;
          readonly passwordHash: string;
          readonly mfaEnabled: boolean;
        };
      `,
      errors: [{ messageId: "modelPolysemy" }],
    },
  ],
});

typeAwareRuleTester.run("ubiquitous-language", ubiquitousLanguage, {
  valid: [
    {
      filename: fixturePath("domain/order.ts"),
      code: `
        type PricingPolicy = { readonly rate: number };
        const fulfillOrder = (p: PricingPolicy) => p;
      `,
    },
  ],
  invalid: [
    {
      filename: fixturePath("domain/order.ts"),
      code: `
        type OrderManager = { readonly id: string };
        const updateOrderStatus = (id: string) => id;
      `,
      errors: [
        { messageId: "genericSuffix" },
        { messageId: "crudVerb" },
      ],
    },
    {
      filename: fixturePath("domain/customer.ts"),
      code: `
        type ClientProfile = { readonly id: string };
        type CustomerAccount = { readonly id: string };
      `,
      errors: [
        { messageId: "synonymCollision" },
        { messageId: "synonymCollision" },
      ],
    },
  ],
});

typeAwareRuleTester.run("domain-layer-purity", domainLayerPurity, {
  valid: [
    {
      filename: fixturePath("domain/clock.ts"),
      code: `
        type Clock = { readonly now: () => number };
        const expireAt = (clock: Clock, ttlMs: number) => clock.now() + ttlMs;
      `,
    },
    {
      filename: fixturePath("infra/server.ts"),
      code: `
        import fs from "node:fs";
        const ts = Date.now();
        export { fs, ts };
      `,
    },
  ],
  invalid: [
    {
      filename: fixturePath("domain/order.ts"),
      code: `
        import fs from "node:fs";
        const now = Date.now();
        const env = process.env.NODE_ENV;
        const rand = Math.random();
        const d = new Date();
        export { fs, now, env, rand, d };
      `,
      errors: [
        { messageId: "forbiddenDomainImport" },
        { messageId: "impureDomainRuntime" },
        { messageId: "impureDomainRuntime" },
        { messageId: "impureDomainRuntime" },
        { messageId: "impureDomainRuntime" },
      ],
    },
  ],
});

typeAwareRuleTester.run("no-cross-aggregate-reference", noCrossAggregateReference, {
  valid: [
    `
      type CustomerId = string & { readonly __brand: "CustomerId" };
      /** @aggregateRoot */
      type Customer = { readonly id: CustomerId };
      /** @aggregateRoot */
      type Order = { readonly customerId: CustomerId };
    `,
  ],
  invalid: [
    {
      code: `
        /** @aggregateRoot */
        type Customer = { readonly id: string };
        /** @aggregateRoot */
        type Order = { readonly customer: Customer };
      `,
      errors: [{ messageId: "crossAggregateReference" }],
    },
  ],
});

typeAwareRuleTester.run("repository-aggregate-root-only", repositoryAggregateRootOnly, {
  valid: [
    `
      /** @aggregateRoot */
      type Order = { readonly id: string; readonly items: ReadonlyArray<OrderItem> };
      type OrderItem = { readonly sku: string };
      type OrderRepository = { readonly save: (order: Order) => void };
    `,
  ],
  invalid: [
    {
      code: `
        /** @aggregateRoot */
        type Order = { readonly id: string; readonly items: ReadonlyArray<OrderItem> };
        type OrderItem = { readonly sku: string };
        type OrderItemRepository = { readonly save: (item: OrderItem) => void };
      `,
      errors: [{ messageId: "nonAggregateRepository" }],
    },
  ],
});
