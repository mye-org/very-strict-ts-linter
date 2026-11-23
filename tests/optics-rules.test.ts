import { preferLensOverNestedSpread } from "../src/rules/prefer-lens-over-nested-spread.js";
import { preferPrismOverGuardedUpdate } from "../src/rules/prefer-prism-over-guarded-update.js";
import { preferTraversalOverNestedCollectionUpdate } from "../src/rules/prefer-traversal-over-nested-collection-update.js";
import { createRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();

ruleTester.run("prefer-lens-over-nested-spread", preferLensOverNestedSpread, {
  valid: [
    `const rename = (user: User) => ({ ...user, name: "Alice" });`,
    `const mergeConfig = (cfg: Config, defaults: Rules) => ({ ...cfg, rules: { ...defaults, strict: true } });`,
    `const compose = (a: Obj, b: Obj, cond: boolean) => ({ ...a, ...(cond ? { ...b } : {}) });`,
    {
      code: `const updateCity = (order: Order) => ({ ...order, shipping: { ...order.shipping, city: "NYC" } });`,
      options: [{ minDepth: 3 }],
    },
  ],
  invalid: [
    {
      code: `const updateCity = (order: Order) => ({ ...order, shipping: { ...order.shipping, city: "NYC" } });`,
      errors: [{ messageId: "preferLens" }],
    },
    {
      code: `
        const updateZip = (order: Order) => ({
          ...order,
          shipping: {
            ...order.shipping,
            address: {
              ...order.shipping.address,
              zip: "10001",
            },
          },
        });
      `,
      errors: [{ messageId: "preferLens" }],
    },
    {
      code: `
        const updateZip = (order: Order) => ({
          ...order,
          shipping: {
            ...order.shipping,
            address: {
              ...order.shipping.address,
              zip: "10001",
            },
          },
        });
      `,
      options: [{ minDepth: 3 }],
      errors: [{ messageId: "preferLens" }],
    },
  ],
});

ruleTester.run("prefer-prism-over-guarded-update", preferPrismOverGuardedUpdate, {
  valid: [
    `const label = (s: State) => (s._tag === "Active" ? "on" : "off");`,
    `const toggle = (s: State) => (s._tag === "Active" ? { _tag: "Idle" } : { _tag: "Active", count: 0 });`,
    `const bump = (x: Counter) => (x.count > 0 ? { ...x, count: x.count + 1 } : x);`,
    `
      const handle = (s: State) =>
        match(s)
          .with({ _tag: "Active" }, (v) => ({ ...v, count: v.count + 1 }))
          .with({ _tag: "Paused" }, (v) => ({ ...v, count: 0 }))
          .exhaustive();
    `,
    `
      const handle = (s: State) =>
        match(s)
          .with({ _tag: "Active" }, (v) => v.count)
          .otherwise(() => 0);
    `,
  ],
  invalid: [
    {
      code: `const bumpActive = (s: State) => (s._tag === "Active" ? { ...s, count: s.count + 1 } : s);`,
      errors: [{ messageId: "preferPrism" }],
    },
    {
      code: `const bumpActive = (s: State) => (s.kind !== "Active" ? s : { ...s, count: s.count + 1 });`,
      errors: [{ messageId: "preferPrism" }],
    },
    {
      code: `const bumpActive = (s: State) => (isActive(s) ? { ...s, count: s.count + 1 } : s);`,
      errors: [{ messageId: "preferPrism" }],
    },
    {
      code: `
        const bumpActive = (s: State) =>
          match(s)
            .with({ _tag: "Active" }, (v) => ({ ...v, count: v.count + 1 }))
            .otherwise(() => s);
      `,
      errors: [{ messageId: "preferPrism" }],
    },
  ],
});

ruleTester.run(
  "prefer-traversal-over-nested-collection-update",
  preferTraversalOverNestedCollectionUpdate,
  {
    valid: [
      `const doublePrices = (items: ReadonlyArray<Item>) => pipe(items, RA.map((item) => ({ ...item, price: item.price * 2 })));`,
      `const extractNames = (order: Order) => ({ ...order, itemNames: pipe(order.items, RA.map((item) => item.name)) });`,
      `const replaceItems = (order: Order, next: ReadonlyArray<Item>) => ({ ...order, items: next });`,
      `const filterAndUpdate = (order: Order) => ({ ...order, items: pipe(order.items, RA.filter(isActive), RA.map((item) => ({ ...item, seen: true }))) });`,
    ],
    invalid: [
      {
        code: `
          const doubleOrderPrices = (order: Order) => ({
            ...order,
            items: pipe(
              order.items,
              RA.map((item) => ({ ...item, price: item.price * 2 })),
            ),
          });
        `,
        errors: [{ messageId: "preferTraversal" }],
      },
      {
        code: `
          const doubleOrderPrices = (order: Order) => ({
            ...order,
            items: flow(
              RA.map((item: Item) => ({ ...item, price: item.price * 2 })),
            )(order.items),
          });
        `,
        errors: [{ messageId: "preferTraversal" }],
      },
      {
        code: `
          const doubleOrderPrices = (order: Order) => ({
            ...order,
            items: RA.map((item: Item) => ({ ...item, price: item.price * 2 }))(order.items),
          });
        `,
        errors: [{ messageId: "preferTraversal" }],
      },
      {
        code: `
          const doubleOrderPrices = (order: Order) => ({
            ...order,
            items: order.items.map((item) => ({ ...item, price: item.price * 2 })),
          });
        `,
        errors: [{ messageId: "preferTraversal" }],
      },
    ],
  },
);
