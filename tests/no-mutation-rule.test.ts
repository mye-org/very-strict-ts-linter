import { noMutation } from "../src/rules/no-mutation.js";
import { createRuleTester, createTypeAwareRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();
const typeAwareRuleTester = createTypeAwareRuleTester();

typeAwareRuleTester.run("no-mutation (type-aware)", noMutation, {
  valid: [
    `
      const a = { x: 1 };
      const b = Object.assign({}, a);
    `,
    `
      const b = { y: 2 };
      const c = Object.assign({ a: 1 }, b);
    `,
    `
      declare const RA: { sort: (xs: ReadonlyArray<number>) => ReadonlyArray<number> };
      const xs: ReadonlyArray<number> = [3, 1, 2];
      const ys = RA.sort(xs);
    `,
    `
      const xs = [1, 2, 3];
      const ys = xs.map((x) => x + 1);
    `,
    `
      const custom = {
        push: (x: number) => x,
        splice: (a: number) => a,
        sort: () => 0,
        reverse: () => 0,
        fill: (x: number) => x,
        set: (k: string, v: number) => ({ k, v }),
        add: (v: number) => v,
        delete: (k: string) => k,
      };
      custom.push(1);
      custom.splice(0);
      custom.sort();
      custom.reverse();
      custom.fill(0);
      custom.set("a", 1);
      custom.add(1);
      custom.delete("a");
    `,
    `
      const m = new Map<string, number>();
      const v = m.get("a");
      const has = m.has("a");
    `,
    `
      const s = new Set<number>();
      const has = s.has(1);
    `,
  ],
  invalid: [
    {
      code: `
        const target = { a: 1 };
        Object.assign(target, { b: 2 });
      `,
      errors: [{ messageId: "noObjectAssignMutation" }],
    },
    {
      code: `
        const getTarget = () => ({ a: 1 });
        Object.assign(getTarget(), { b: 2 });
      `,
      errors: [{ messageId: "noObjectAssignMutation" }],
    },
    {
      code: `
        const target = { a: 1 };
        Reflect.set(target, "a", 2);
      `,
      errors: [{ messageId: "noReflectSet" }],
    },
    {
      code: `
        const target = { a: 1 };
        Object.defineProperty(target, "a", { value: 2 });
      `,
      errors: [{ messageId: "noObjectDefineProperty" }],
    },
    {
      code: `
        const xs = [1, 2, 3];
        xs.push(4);
        xs.splice(0, 1);
        xs.sort();
        xs.reverse();
        xs.fill(0);
      `,
      errors: [
        { messageId: "noMutatingMethod" },
        { messageId: "noMutatingMethod" },
        { messageId: "noMutatingMethod" },
        { messageId: "noMutatingMethod" },
        { messageId: "noMutatingMethod" },
      ],
    },
    {
      code: `
        declare const xs: ReadonlyArray<number>;
        (xs as unknown as Array<number>).push(1);
      `,
      errors: [{ messageId: "noMutatingMethod" }],
    },
    {
      code: `
        const pair: [number, number] = [2, 1];
        pair.sort();
      `,
      errors: [{ messageId: "noMutatingMethod" }],
    },
    {
      code: `
        declare const xs: Array<number> | ReadonlyArray<string>;
        xs.slice();
        (xs as Array<number>).reverse();
      `,
      errors: [{ messageId: "noMutatingMethod" }],
    },
    {
      code: `
        declare const unionArr: number[] | string[];
        unionArr.reverse();
      `,
      errors: [{ messageId: "noMutatingMethod" }],
    },
    {
      code: `
        const m = new Map<string, number>();
        m.set("a", 1);
        m.delete("a");
      `,
      errors: [
        { messageId: "noMutatingMethod" },
        { messageId: "noMutatingMethod" },
      ],
    },
    {
      code: `
        declare const rm: ReadonlyMap<string, number> & { set: (k: string, v: number) => void; delete: (k: string) => boolean };
        rm.set("a", 1);
        rm.delete("a");
      `,
      errors: [
        { messageId: "noMutatingMethod" },
        { messageId: "noMutatingMethod" },
      ],
    },
    {
      code: `
        const s = new Set<number>();
        s.add(1);
        s.delete(1);
      `,
      errors: [
        { messageId: "noMutatingMethod" },
        { messageId: "noMutatingMethod" },
      ],
    },
    {
      code: `
        declare const rs: ReadonlySet<number> & { add: (v: number) => void; delete: (v: number) => boolean };
        rs.add(1);
        rs.delete(1);
      `,
      errors: [
        { messageId: "noMutatingMethod" },
        { messageId: "noMutatingMethod" },
      ],
    },
    {
      code: `
        declare const col: Map<string, number> | Set<string>;
        col.delete("a");
      `,
      errors: [{ messageId: "noMutatingMethod" }],
    },
  ],
});

ruleTester.run("no-mutation (ast fallback)", noMutation, {
  valid: [
    `Object.assign({}, a);`,
    `Object.assign({ a: 1 }, b);`,
    `RA.sort(ord)(xs);`,
    `RA.reverse(xs);`,
    `custom.set("a", 1);`,
    `custom.delete("a");`,
    `custom.add(1);`,
  ],
  invalid: [
    {
      code: `Object.assign(target, a);`,
      errors: [{ messageId: "noObjectAssignMutation" }],
    },
    {
      code: `Reflect.set(target, "a", 1);`,
      errors: [{ messageId: "noReflectSet" }],
    },
    {
      code: `Object.defineProperty(target, "a", { value: 1 });`,
      errors: [{ messageId: "noObjectDefineProperty" }],
    },
    {
      code: `
        arr.push(1);
        arr.splice(0, 1);
        arr.sort();
        arr.reverse();
        arr.fill(0);
      `,
      errors: [
        { messageId: "noMutatingMethod" },
        { messageId: "noMutatingMethod" },
        { messageId: "noMutatingMethod" },
        { messageId: "noMutatingMethod" },
        { messageId: "noMutatingMethod" },
      ],
    },
    {
      code: `
        new Map().set("a", 1);
        new Map().delete("a");
      `,
      errors: [
        { messageId: "noMutatingMethod" },
        { messageId: "noMutatingMethod" },
      ],
    },
    {
      code: `
        new Set().add(1);
        new Set().delete(1);
      `,
      errors: [
        { messageId: "noMutatingMethod" },
        { messageId: "noMutatingMethod" },
      ],
    },
  ],
});
