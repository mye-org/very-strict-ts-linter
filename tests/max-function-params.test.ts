import { maxFunctionParams } from "../src/rules/max-function-params.js";
import { createRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();

ruleTester.run("max-function-params", maxFunctionParams, {
  valid: [
    `const zero = () => 1;`,
    `const one = (a: number) => a + 1;`,
    `function two(a: number, b: number) { return a + b; }`,
    `const curried = (a: number) => (b: number) => (c: number) => a + b + c;`,
    `function withThis(this: { x: number }, a: number, b: number) { return a + b; }`,
    {
      code: `const threeAllowed = (a: number, b: number, c: number) => a + b + c;`,
      options: [{ maxParams: 3, ignoreCallbacks: false }],
    },
    {
      code: `const sum = [1, 2, 3].reduce((acc, item, index) => acc + item + index, 0);`,
      options: [{ maxParams: 2, ignoreCallbacks: true }],
    },
  ],
  invalid: [
    {
      code: `function transfer(fromId: string, toId: string, amountCents: number) { return amountCents; }`,
      errors: [
        {
          messageId: "tooManyParams",
          data: { name: " 'transfer'", actual: "3", max: "2" },
        },
      ],
    },
    {
      code: `const createRange = (start: number, end: number, timezone: string) => ({ start, end, timezone });`,
      errors: [
        {
          messageId: "tooManyParams",
          data: { name: " 'createRange'", actual: "3", max: "2" },
        },
      ],
    },
    {
      code: `const fn = function (a: number, b: number, c: number) { return a + b + c; };`,
      errors: [
        {
          messageId: "tooManyParams",
          data: { name: " 'fn'", actual: "3", max: "2" },
        },
      ],
    },
    {
      code: `const sum = [1, 2, 3].reduce((acc, item, index) => acc + item + index, 0);`,
      errors: [
        {
          messageId: "tooManyParams",
          data: { name: "", actual: "3", max: "2" },
        },
      ],
    },
    {
      code: `const pair = (a: number, b: number) => [a, b];`,
      options: [{ maxParams: 1, ignoreCallbacks: false }],
      errors: [
        {
          messageId: "tooManyParams",
          data: { name: " 'pair'", actual: "2", max: "1" },
        },
      ],
    },
  ],
});
