import fs from "node:fs";
import path from "node:path";
import { commonReuseCohesion } from "../src/rules/common-reuse-cohesion.js";
import { functionalCoreBoundary } from "../src/rules/functional-core-boundary.js";
import { moduleCohesion } from "../src/rules/module-cohesion.js";
import { noSingleCallerExport } from "../src/rules/no-single-caller-export.js";
import { createTsUnitSampleRuleTester, createTypeAwareRuleTester } from "./rule-tester.js";

const typeAwareRuleTester = createTypeAwareRuleTester();
const tsUnitSampleRuleTester = createTsUnitSampleRuleTester();

const samplePath = (...parts: ReadonlyArray<string>) =>
  path.resolve(import.meta.dirname, "ts-unit-sample", ...parts);

const readSample = (...parts: ReadonlyArray<string>) =>
  fs.readFileSync(samplePath(...parts), "utf8");

typeAwareRuleTester.run("module-cohesion", moduleCohesion, {
  valid: [
    // Single-export module is always cohesive
    `
      export const addTax = (amount: number, rate: number) => amount * (1 + rate);
    `,
    // Type-only module is exempt
    `
      export type Money = { readonly amount: number; readonly currency: string };
      export type CustomerId = string;
    `,
    // Exports linked via direct call
    `
      export const normalize = (s: string) => s.trim().toLowerCase();
      export const slugify = (s: string) => normalize(s).replace(/\\s+/g, "-");
    `,
    // Exports linked via shared unexported helper/constant
    `
      const CURRENCY_RE = /^(\\d+)\\s+([A-Z]{3})$/;
      export const isValidMoney = (raw: string) => CURRENCY_RE.test(raw);
      export const parseCurrency = (raw: string) => raw.match(CURRENCY_RE)?.[2] ?? "USD";
    `,
    // Exports linked via shared same-file domain type (including wrapped in ReadonlyArray)
    `
      export type Money = { readonly amount: number; readonly currency: string };
      export const addMoney = (a: Money, b: Money): Money => ({ amount: a.amount + b.amount, currency: a.currency });
      export const sumMoney = (items: ReadonlyArray<Money>): number => items.reduce((acc, m) => acc + m.amount, 0);
    `,
    // Exports linked via transitive shared unexported helper
    `
      const baseRate = 0.1;
      const computeFee = (x: number) => x * baseRate;
      export const estimateFee = (x: number) => computeFee(x);
      export const totalWithFee = (x: number) => x + x * baseRate;
    `,
  ],
  invalid: [
    // Unrelated grab-bag helpers form 2 disconnected clusters
    {
      code: `
        const CURRENCY_RE = /^\\d+/;
        export const formatMoney = (n: number) => \`$\${String(n)}\`;
        export const parseMoney = (s: string) => Number(s.match(CURRENCY_RE)?.[0] ?? "0");
        export const slugify = (s: string) => s.trim().toLowerCase().replace(/\\s+/g, "-");
        export const truncate = (s: string, len: number) => s.slice(0, len);
      `,
      errors: [{ messageId: "disconnectedExportClusters" }],
    },
    // Ubiquitous types like Logger / Context must NOT artificially link unrelated functions
    {
      code: `
        export type Logger = { readonly info: (msg: string) => void };
        export const parseInvoice = (raw: string, logger: Logger) => ({ raw, logger });
        export const computeDistance = (km: number, logger: Logger) => ({ km, logger });
      `,
      errors: [{ messageId: "disconnectedExportClusters" }],
    },
    // Unwrapped default object bag with unrelated methods
    {
      code: `
        const add = (a: number, b: number) => a + b;
        const shout = (s: string) => s.toUpperCase();
        export default { add, shout };
      `,
      errors: [{ messageId: "disconnectedExportClusters" }],
    },
  ],
});

typeAwareRuleTester.run("functional-core-boundary", functionalCoreBoundary, {
  valid: [
    // All-pure module (including pure HOFs .map/.filter)
    `
      export const doubleAll = (xs: ReadonlyArray<number>) => xs.map((x) => x * 2);
      export const positiveOnly = (xs: ReadonlyArray<number>) => xs.filter((x) => x > 0);
    `,
    // All-impure thin imperative shell with small private pure helper
    `
      const formatMessage = (name: string, urgent: boolean) => (urgent ? \`!\${name}\` : name);
      export const notifyUser = async (name: string, urgent: boolean): Promise<string> => {
        const msg = formatMessage(name, urgent);
        console.log(msg);
        return msg;
      };
    `,
    // All-impure module where all exports are impure and thin (complexity <= 5)
    `
      export const getTimestamp = () => Date.now();
      export const getRandom = () => Math.random();
    `,
  ],
  invalid: [
    // Mixed pure & async impure export
    {
      code: `
        export const calculateTax = (amount: number) => amount * 0.1;
        export const saveOrder = async (amount: number) => Promise.resolve(amount);
      `,
      errors: [{ messageId: "mixedPurityExports" }],
    },
    // Mixed pure & local mutation (.push / let reassignment)
    {
      code: `
        export const pureAdd = (a: number, b: number) => a + b;
        export const impurePush = (items: number[], x: number) => {
          items.push(x);
          return items;
        };
      `,
      errors: [{ messageId: "mixedPurityExports" }],
    },
    // Mixed pure & throw exception
    {
      code: `
        export const safeDouble = (n: number) => n * 2;
        export const parseStrict = (n: number) => {
          if (n < 0) throw new Error("negative");
          return n;
        };
      `,
      errors: [{ messageId: "mixedPurityExports" }],
    },
    // Mixed pure & void return
    {
      code: `
        export const pureIdentity = (x: number) => x;
        export const doNothing = (x: number): void => {
          const _y = x + 1;
        };
      `,
      errors: [{ messageId: "mixedPurityExports" }],
    },
    // Mixed pure & impure HOF callback
    {
      code: `
        export const pureSum = (a: number, b: number) => a + b;
        export const logAll = (xs: ReadonlyArray<number>) =>
          xs.map((x) => {
            console.log(x);
            return x;
          });
      `,
      errors: [{ messageId: "mixedPurityExports" }],
    },
    // Impure shell exceeding maxImpureComplexity (default 5)
    {
      code: `
        export const complexShell = (a: number, b: number, c: number, d: number, e: number) => {
          console.log(a);
          if (a > 0) return 1;
          if (b > 0) return 2;
          if (c > 0) return 3;
          if (d > 0) return 4;
          if (e > 0) return 5;
          return 0;
        };
      `,
      errors: [{ messageId: "impureShellTooComplex" }],
    },
    // Private pure helper in an impure module exceeding maxPrivatePureHelperComplexity (default 6)
    {
      code: `
        const classifyHeavy = (n: number) => {
          if (n === 1) return "a";
          if (n === 2) return "b";
          if (n === 3) return "c";
          if (n === 4) return "d";
          if (n === 5) return "e";
          if (n === 6) return "f";
          return "other";
        };
        export const runShell = (n: number) => {
          const label = classifyHeavy(n);
          console.log(label);
          return label;
        };
      `,
      errors: [{ messageId: "privatePureHelperTooComplex" }],
    },
    // Mutual recursion tainting caller as impure
    {
      code: `
        const ping = (n: number): number => (n <= 0 ? 0 : pong(n - 1));
        const pong = (n: number): number => Date.now() + ping(n - 1);
        export const pureHelper = (x: number) => x + 1;
        export const startPing = (n: number) => ping(n);
      `,
      errors: [{ messageId: "mixedPurityExports" }],
    },
  ],
});

tsUnitSampleRuleTester.run("functional-core-boundary (cross-file transitive purity)", functionalCoreBoundary, {
  valid: [
    {
      filename: samplePath("pure-core.ts"),
      code: readSample("pure-core.ts"),
    },
    {
      filename: samplePath("impure-shell.ts"),
      code: readSample("impure-shell.ts"),
    },
    {
      filename: samplePath("barrel.ts"),
      code: readSample("barrel.ts"),
    },
  ],
  invalid: [
    {
      filename: samplePath("transitive-caller.ts"),
      code: readSample("transitive-caller.ts"),
      errors: [{ messageId: "mixedPurityExports" }],
    },
  ],
});

tsUnitSampleRuleTester.run("no-single-caller-export (cross-file + barrel + deadlock guards)", noSingleCallerExport, {
  valid: [
    // Barrel files are skipped
    {
      filename: samplePath("barrel.ts"),
      code: readSample("barrel.ts"),
    },
    // Deadlock Guard 1: Pure export called only by 1 impure shell -> EXEMPT
    {
      filename: samplePath("pure-core.ts"),
      code: readSample("pure-core.ts"),
    },
    // Deadlock Guard 3: Symbol reachable via configured entryPoints (index.ts -> barrel.ts -> public-api.ts) -> EXEMPT
    {
      filename: samplePath("public-api.ts"),
      code: readSample("public-api.ts"),
      options: [{ entryPoints: ["**/index.ts"] }],
    },
    // Deadlock Guard 2: Merging into large-consumer.ts would exceed maxMergedFileLines: 20 -> EXEMPT
    {
      filename: samplePath("helper-for-large.ts"),
      code: readSample("helper-for-large.ts"),
      options: [{ maxMergedFileLines: 20 }],
    },
  ],
  invalid: [
    // Single pure caller traced transparently through barrel.ts -> FAIL
    {
      filename: samplePath("single-caller-pure.ts"),
      code: readSample("single-caller-pure.ts"),
      errors: [{ messageId: "singleCallerExport" }],
    },
    // Test-only export leak (internalParseHelper imported only by test-only-leak.test.ts; usedByMany has 2 prod callers)
    {
      filename: samplePath("test-only-leak.ts"),
      code: readSample("test-only-leak.ts"),
      errors: [{ messageId: "testOnlyExport" }],
    },
    // Without size guard exemption (default 300 lines), helper-for-large.ts has 1 pure consumer -> FAIL
    {
      filename: samplePath("helper-for-large.ts"),
      code: readSample("helper-for-large.ts"),
      errors: [{ messageId: "singleCallerExport" }],
    },
  ],
});

tsUnitSampleRuleTester.run("common-reuse-cohesion (cross-file CRP + barrel + namespace)", commonReuseCohesion, {
  valid: [
    // Small ADT (4 exports <= minExports 5) passes even with disjoint callers
    {
      filename: samplePath("small-adt.ts"),
      code: readSample("small-adt.ts"),
    },
    // Barrel files are skipped
    {
      filename: samplePath("barrel.ts"),
      code: readSample("barrel.ts"),
    },
    // Module with 6 exports is cohesive under Rule 1 (shared Order type)
    {
      filename: samplePath("pure-caller.ts"),
      code: readSample("pure-caller.ts"),
    },
  ],
  invalid: [
    // 6 exports split into Billing (via barrel) and Fulfillment (via `import * as OrderQueries`)
    {
      filename: samplePath("order-queries.ts"),
      code: readSample("order-queries.ts"),
      errors: [{ messageId: "disjointConsumerGroups" }],
    },
  ],
});

tsUnitSampleRuleTester.run("module-cohesion (cross-file barrel skip & ADT)", moduleCohesion, {
  valid: [
    // Barrel file skipped
    {
      filename: samplePath("barrel.ts"),
      code: readSample("barrel.ts"),
    },
    // order-queries.ts passes Rule 1 (all 6 exports share local Order type), while failing Rule 4 above
    {
      filename: samplePath("order-queries.ts"),
      code: readSample("order-queries.ts"),
    },
  ],
  invalid: [],
});
