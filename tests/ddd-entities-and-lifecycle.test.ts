import path from "node:path";
import { noExternalEntityMutation } from "../src/rules/no-external-entity-mutation.js";
import { noInlineInfraSideEffects } from "../src/rules/no-inline-infra-side-effects.js";
import { noLifecycleFlagClusters } from "../src/rules/no-lifecycle-flag-clusters.js";
import { noMultiRepoOrchestration } from "../src/rules/no-multi-repo-orchestration.js";
import { noRepeatedGuardClauses } from "../src/rules/no-repeated-guard-clauses.js";
import { noTrainWreckNavigation } from "../src/rules/no-train-wreck-navigation.js";
import { createDddSampleRuleTester, createTypeAwareRuleTester } from "./rule-tester.js";

const typeAwareRuleTester = createTypeAwareRuleTester();
const dddSampleRuleTester = createDddSampleRuleTester();
const samplePath = (...parts: ReadonlyArray<string>) =>
  path.resolve(import.meta.dirname, "ddd-sample", ...parts);

typeAwareRuleTester.run("no-external-entity-mutation", noExternalEntityMutation, {
  valid: [
    `
      type Order = { readonly status: string };
      const approveOrder = (order: Order) => ({ ...order, status: "APPROVED" });
    `,
    `
      class Order {
        status = "DRAFT";
        updatedAt = 0;
        approve() {
          this.status = "APPROVED";
          this.updatedAt = 1;
        }
      }
    `,
  ],
  invalid: [],
});

dddSampleRuleTester.run("no-external-entity-mutation (cross-file)", noExternalEntityMutation, {
  valid: [],
  invalid: [
    {
      filename: samplePath("shipping.ts"),
      code: `
        import { Order } from "./models.js";
        const approve = (order: Order & { status: string; updatedAt: number }) => {
          order.status = "APPROVED";
          order.updatedAt = 1;
        };
      `,
      errors: [{ messageId: "externalMutation" }],
    },
    {
      filename: samplePath("shipping.ts"),
      code: `
        import { Order } from "./models.js";
        const update = (order: Order & { setStatus: (s: string) => void }) => {
          order.setStatus("PAID");
        };
      `,
      errors: [{ messageId: "setterAbuse" }],
    },
  ],
});

typeAwareRuleTester.run("no-repeated-guard-clauses", noRepeatedGuardClauses, {
  valid: [
    `
      type Order = { readonly status: string; readonly total: number };
      const canSubmit = (order: Order) => order.status === "OPEN" && order.total > 0;
      const submit = (order: Order) => canSubmit(order);
    `,
  ],
  invalid: [
    {
      code: `
        type Order = { readonly status: string; readonly items: ReadonlyArray<number> };
        const f1 = (order: Order) => order.status === "OPEN" && order.items.length > 0;
        const f2 = (o: Order) => o.status === "OPEN" && o.items.length > 0;
      `,
      errors: [
        { messageId: "repeatedGuardClause" },
        { messageId: "repeatedGuardClause" },
      ],
    },
  ],
});

typeAwareRuleTester.run("no-train-wreck-navigation", noTrainWreckNavigation, {
  valid: [
    `
      declare const order: { readonly customer: { readonly name: string } };
      const name = order.customer.name;
    `,
    `
      declare const match: <T>(v: T) => { with: (p: unknown, f: () => number) => { exhaustive: () => number } };
      const res = match(1).with(1, () => 1).exhaustive();
    `,
    `
      import * as O from "fp-ts/lib/Option";
      const val = O.some(1);
    `,
  ],
  invalid: [
    {
      code: `
        declare const order: {
          readonly customer: {
            readonly subscription: {
              readonly plan: { readonly discountRate: number };
            };
          };
        };
        const rate = order.customer.subscription.plan.discountRate;
      `,
      errors: [{ messageId: "trainWreckNavigation" }],
    },
  ],
});

typeAwareRuleTester.run("no-lifecycle-flag-clusters", noLifecycleFlagClusters, {
  valid: [
    `
      type Order =
        | { readonly kind: "draft" }
        | { readonly kind: "paid"; readonly paidAt: Date }
        | { readonly kind: "cancelled"; readonly cancelledAt: Date };
    `,
  ],
  invalid: [
    {
      code: `
        type Order = {
          readonly isDraft: boolean;
          readonly isPaid: boolean;
          readonly isShipped: boolean;
        };
      `,
      errors: [{ messageId: "booleanFlagCluster" }],
    },
    {
      code: `
        type Option<A> = { readonly _tag: "None" } | { readonly _tag: "Some"; readonly value: A };
        type Order = {
          readonly paidAt: Option<Date>;
          readonly cancelledAt: Option<Date>;
          readonly refundedAt: Option<Date>;
        };
      `,
      errors: [{ messageId: "nullableTimestampCluster" }],
    },
  ],
});

typeAwareRuleTester.run("no-multi-repo-orchestration", noMultiRepoOrchestration, {
  valid: [
    `
      declare const orderRepo: { save: (o: unknown) => void };
      const placeOrder = (order: unknown) => {
        orderRepo.save(order);
      };
    `,
  ],
  invalid: [
    {
      code: `
        declare const orderRepo: { save: (o: unknown) => void };
        declare const inventoryRepo: { update: (i: unknown) => void };
        const placeOrder = (order: unknown, inv: unknown) => {
          orderRepo.save(order);
          inventoryRepo.update(inv);
        };
      `,
      errors: [{ messageId: "multiRepoOrchestration" }],
    },
  ],
});

typeAwareRuleTester.run("no-inline-infra-side-effects", noInlineInfraSideEffects, {
  valid: [
    `
      declare const mailer: { send: (to: string) => void };
      const onOrderPlaced = (to: string) => {
        mailer.send(to);
      };
    `,
  ],
  invalid: [
    {
      code: `
        declare const orderRepo: { save: (o: unknown) => void };
        declare const mailer: { send: (to: string) => void };
        const completeOrder = (order: unknown, email: string) => {
          orderRepo.save(order);
          mailer.send(email);
        };
      `,
      errors: [{ messageId: "inlineInfraSideEffect" }],
    },
  ],
});
