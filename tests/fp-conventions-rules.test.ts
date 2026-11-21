import { fpTsImportConvention } from "../src/rules/fp-ts-import-convention.js";
import { maxFunctionLines } from "../src/rules/max-function-lines.js";
import { noNestedTernary } from "../src/rules/no-nested-ternary.js";
import { noUnnecessaryLocalConst } from "../src/rules/no-unnecessary-local-const.js";
import { preferFpTsArrayMethods } from "../src/rules/prefer-fp-ts-array-methods.js";
import { createRuleTester, createTypeAwareRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();
const typeAwareRuleTester = createTypeAwareRuleTester();

typeAwareRuleTester.run("prefer-fp-ts-array-methods", preferFpTsArrayMethods, {
  valid: [
    `
      declare const xs: ReadonlyArray<number>;
      declare const RA: { map: <A, B>(f: (a: A) => B) => (as: ReadonlyArray<A>) => ReadonlyArray<B> };
      const ys = RA.map((x: number) => x + 1)(xs);
    `,
    `
      declare const o: { map: (fn: (x: number) => number) => number };
      const y = o.map((x) => x + 1);
    `,
  ],
  invalid: [
    {
      code: `
        const xs: ReadonlyArray<number> = [1, 2, 3];
        const ys = xs.map((x) => x + 1);
      `,
      errors: [{ messageId: "preferFpTsArray" }],
    },
    {
      code: `
        const xs = [1, 2, 3];
        const ys = xs.filter((x) => x > 1);
      `,
      errors: [{ messageId: "preferFpTsArray" }],
    },
  ],
});

ruleTester.run("max-function-lines", maxFunctionLines, {
  valid: [
    `const add = (a: number, b: number): number => a + b;`,
    {
      code: `const f = (): number => {\n  const a = 1;\n  return a;\n};`,
      options: [{ maxLines: 5 }],
    },
  ],
  invalid: [
    {
      code: `const f = (): number => {\n  const a = 1;\n  const b = 2;\n  return a + b;\n};`,
      options: [{ maxLines: 3 }],
      errors: [{ messageId: "tooManyLines" }],
    },
  ],
});

ruleTester.run("no-unnecessary-local-const", noUnnecessaryLocalConst, {
  valid: [
    `const topLevel = 1;`,
    `const f = (x: number): number => { const y = x + 1; return y + y; };`,
    `const f = (x: number): number => pipe(x, (n) => n + 1);`,
  ],
  invalid: [
    {
      code: `const f = (x: number): number => { const y = x + 1; return y * 2; };`,
      errors: [{ messageId: "unnecessaryLocalConst" }],
    },
  ],
});

ruleTester.run("no-nested-ternary", noNestedTernary, {
  valid: [`const x = a ? 1 : 2;`],
  invalid: [
    {
      code: `const x = a ? (b ? 1 : 2) : 3;`,
      errors: [{ messageId: "noNestedTernary" }],
    },
  ],
});

ruleTester.run("fp-ts-import-convention", fpTsImportConvention, {
  valid: [
    `import * as O from "fp-ts/lib/Option";`,
    `import { pipe, flow } from "fp-ts/lib/function";`,
    `import type { Option } from "fp-ts/lib/Option";`,
  ],
  invalid: [
    {
      code: `import * as O from "fp-ts/Option";`,
      errors: [{ messageId: "useLibPath" }],
    },
    {
      code: `import { some, none } from "fp-ts/lib/Option";`,
      errors: [{ messageId: "useNamespaceImport" }],
    },
  ],
});
