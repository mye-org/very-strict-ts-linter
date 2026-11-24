import { preferCurriedFunctions } from "../src/rules/prefer-curried-functions.js";
import { createRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();

ruleTester.run("prefer-curried-functions", preferCurriedFunctions, {
  valid: [
    `const zero = () => 1;`,
    `const one = (a: number) => a + 1;`,
    `function identity<T>(x: T): T { return x; }`,
    `const curried = (ctx: Ctx) => (data: Data) => data.value + ctx.offset;`,
    `function withThis(this: Ctx, a: number) { return a; }`,
    `const variadic = (...args: ReadonlyArray<number>) => args.length;`,
    `const withThisAndRest = function (this: Ctx, ...args: ReadonlyArray<number>) { return args.length; };`,
    `const sum = [1, 2, 3].reduce((acc, item) => acc + item, 0);`,
    `const mapped = RA.map((item: number, index: number) => item + index);`,
    `
      class Calculator {
        add(a: number, b: number) {
          return a + b;
        }
      }
    `,
    `
      const obj = {
        add(a: number, b: number) {
          return a + b;
        },
        set pair(value: readonly [number, number]) {
          void value;
        },
      };
    `,
    `
      export const myRule = createRule({
        name: "my-rule",
        meta: { type: "suggestion", docs: { description: "x" }, messages: {}, schema: [] },
        create: (context, [options]) => ({
          onCodePathStart: (codePath, node) => {
            void context;
            void options;
            void codePath;
            void node;
          },
        }),
      });
    `,
  ],
  invalid: [
    {
      code: `function add(a: number, b: number) { return a + b; }`,
      errors: [
        {
          messageId: "preferCurried",
          data: { name: " 'add'", actual: "2" },
        },
      ],
    },
    {
      code: `const multiply = (a: number, b: number) => a * b;`,
      errors: [
        {
          messageId: "preferCurried",
          data: { name: " 'multiply'", actual: "2" },
        },
      ],
    },
    {
      code: `const fn = function (a: number, b: number, c: number) { return a + b + c; };`,
      errors: [
        {
          messageId: "preferCurried",
          data: { name: " 'fn'", actual: "3" },
        },
      ],
    },
    {
      code: `function withThisAndTwo(this: Ctx, a: number, b: number) { return a + b; }`,
      errors: [
        {
          messageId: "preferCurried",
          data: { name: " 'withThisAndTwo'", actual: "2" },
        },
      ],
    },
    {
      code: `const withRest = (a: number, ...rest: ReadonlyArray<number>) => a + rest.length;`,
      errors: [
        {
          messageId: "preferCurried",
          data: { name: " 'withRest'", actual: "2" },
        },
      ],
    },
    {
      code: `const handlers = { compute: (ctx: Ctx, data: Data) => data.value + ctx.offset };`,
      errors: [
        {
          messageId: "preferCurried",
          data: { name: "", actual: "2" },
        },
      ],
    },
  ],
});
