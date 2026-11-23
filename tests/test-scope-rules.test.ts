import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeTestScope, DEFAULT_TEST_SCOPE_OPTIONS } from "../src/analyzers/test-scope-analyzer.js";
import { noRedundantTestScope } from "../src/rules/no-redundant-test-scope.js";
import { preferLowestTestLevel } from "../src/rules/prefer-lowest-test-level.js";
import { singleTestResponsibility } from "../src/rules/single-test-responsibility.js";
import { createTestScopeSampleRuleTester } from "./rule-tester.js";

const testScopeSampleRuleTester = createTestScopeSampleRuleTester();

const samplePath = (...parts: ReadonlyArray<string>) =>
  path.resolve(import.meta.dirname, "test-scope-sample", ...parts);

const readSample = (...parts: ReadonlyArray<string>) =>
  fs.readFileSync(samplePath(...parts), "utf8");

const loadProgram = (tsconfigPath: string) => {
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(tsconfigPath, (f) => ts.sys.readFile(f)).config,
    ts.sys,
    path.dirname(tsconfigPath),
  );
  return ts.createProgram(parsed.fileNames, parsed.options);
};

// ---------------------------------------------------------------------------
// 1. Direct Analyzer Unit Tests (Classifications, Provenance, Mocks, Safety Guards)
// ---------------------------------------------------------------------------

describe("TestScope analyzer — classifications & static dependency analysis", () => {
  const analysis = analyzeTestScope(loadProgram(samplePath("tsconfig.json")));

  const findTest = (substring: string) =>
    analysis.tests.find((t) => t.fullName.includes(substring));

  it("classifies component, composition, system-invariant, mocked, and potentially-redundant tests", () => {
    expect(findTest("parses valid dollar amounts")?.classification).toBe("component");
    expect(findTest("composes parsing, total calculation, and order saving")?.classification).toBe(
      "composition",
    );
    expect(findTest("preserves invariant that total is at least parsed price")?.classification).toBe(
      "system-invariant",
    );
    expect(findTest("checkout parses price via barrel")?.classification).toBe(
      "potentially-redundant",
    );
    expect(findTest("checkout rejects invalid price error")?.classification).toBe(
      "potentially-redundant",
    );
  });

  it("records mocked boundaries from vi.spyOn(...).mockReturnValue(...)", () => {
    const mockedTest = findTest("isolates checkout when parsePrice is stubbed");
    expect(mockedTest?.mockedTargets).toContain("parsePrice");
    expect(mockedTest?.classification).not.toBe("potentially-redundant");
  });

  it("flags repeated parsing cases in a single higher-level test even without a separate composition test", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-scope-repeated-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            lib: ["ES2022"],
            types: [],
            strict: true,
            skipLibCheck: true,
          },
          include: ["./**/*.ts"],
        }),
      );
      fs.writeFileSync(path.join(tmpDir, "test-env.d.ts"), readSample("test-env.d.ts"));
      fs.writeFileSync(
        path.join(tmpDir, "parser.ts"),
        `export const parseAmount = (raw: string): number => Number(raw.slice(1));\n`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "service.ts"),
        `import { parseAmount } from "./parser.js";
export const runOrder = (raw: string) => {
  const amount = parseAmount(raw);
  return { amount, ok: amount > 0 };
};
`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "parser.test.ts"),
        `import { parseAmount } from "./parser.js";
it("parses dollar string", () => {
  expect(parseAmount("$10")).toBe(10);
});
`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "service.test.ts"),
        `import { runOrder } from "./service.js";
it("repeats parsing cases through runOrder", () => {
  expect(runOrder("$10").amount).toBe(10);
  expect(runOrder("$20").amount).toBe(20);
});
`,
      );

      const prog = loadProgram(path.join(tmpDir, "tsconfig.json"));
      const result = analyzeTestScope(prog, DEFAULT_TEST_SCOPE_OPTIONS);
      const serviceTestFile = path.join(tmpDir, "service.test.ts").replace(/\\/g, "/");
      const findings = result.redundancyByFile[serviceTestFile] ?? [];
      expect(findings).toHaveLength(1);
      expect(findings[0]?.kind).toBe("redundantCrossLevelTest");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports vi.mock module-level mocking boundary exemption", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-scope-vimock-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            lib: ["ES2022"],
            types: [],
            strict: true,
            skipLibCheck: true,
          },
          include: ["./**/*.ts"],
        }),
      );
      fs.writeFileSync(path.join(tmpDir, "test-env.d.ts"), readSample("test-env.d.ts"));
      fs.writeFileSync(
        path.join(tmpDir, "parser.ts"),
        `export const parseAmount = (raw: string): number => Number(raw.slice(1));\n`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "service.ts"),
        `import { parseAmount } from "./parser.js";
export const runOrder = (raw: string) => {
  const amount = parseAmount(raw);
  return { amount, ok: amount > 0 };
};
`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "parser.test.ts"),
        `import { parseAmount } from "./parser.js";
it("parses dollar string", () => {
  expect(parseAmount("$10")).toBe(10);
});
`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "service.test.ts"),
        `import { runOrder } from "./service.js";
vi.mock("./parser.js");
it("returns mocked parser amount", () => {
  expect(runOrder("$10").amount).toBe(10);
  expect(runOrder("$20").amount).toBe(20);
});
`,
      );

      const prog = loadProgram(path.join(tmpDir, "tsconfig.json"));
      const result = analyzeTestScope(prog, DEFAULT_TEST_SCOPE_OPTIONS);
      const serviceTestFile = path.join(tmpDir, "service.test.ts").replace(/\\/g, "/");
      expect(result.redundancyByFile[serviceTestFile] ?? []).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects it.each repeated delegated cases and fp-ts Either Left delegated errors", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-scope-each-fp-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            lib: ["ES2022"],
            types: [],
            strict: true,
            skipLibCheck: true,
          },
          include: ["./**/*.ts"],
        }),
      );
      fs.writeFileSync(path.join(tmpDir, "test-env.d.ts"), readSample("test-env.d.ts"));
      fs.writeFileSync(
        path.join(tmpDir, "either.ts"),
        `export type Either<E, A> = { readonly _tag: "Left"; readonly left: E } | { readonly _tag: "Right"; readonly right: A };
export const E = {
  left: <E>(left: E): Either<E, never> => ({ _tag: "Left", left }),
  right: <A>(right: A): Either<never, A> => ({ _tag: "Right", right }),
  isLeft: <E, A>(ma: Either<E, A>): boolean => ma._tag === "Left",
};
`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "parser.ts"),
        `import { E, type Either } from "./either.js";
export const safeParsePrice = (raw: string): Either<string, number> =>
  raw.startsWith("$") ? E.right(Number(raw.slice(1))) : E.left("Invalid price");
`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "workflow.ts"),
        `import { safeParsePrice } from "./parser.js";
export const runWorkflow = (raw: string) => {
  const parsed = safeParsePrice(raw);
  return { parsed };
};
export const validateOrder = (raw: string) => safeParsePrice(raw);
`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "parser.test.ts"),
        `import { E } from "./either.js";
import { safeParsePrice } from "./parser.js";
it("returns Left on invalid input", () => {
  expect(E.isLeft(safeParsePrice("bad"))).toBe(true);
});
`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "workflow.test.ts"),
        `import { E } from "./either.js";
import { runWorkflow, validateOrder } from "./workflow.js";
it.each([["$10", 10], ["$20", 20]])("repeats parsing through workflow %s", (raw: string, expected: number) => {
  expect(runWorkflow(raw).parsed).toEqual({ _tag: "Right", right: expected });
});
it("delegates Left check through validateOrder", () => {
  expect(E.isLeft(validateOrder("bad"))).toBe(true);
});
it("delegates Left check again through validateOrder", () => {
  expect(E.isLeft(validateOrder("bad"))).toBe(true);
});
`,
      );

      const prog = loadProgram(path.join(tmpDir, "tsconfig.json"));
      const result = analyzeTestScope(prog, DEFAULT_TEST_SCOPE_OPTIONS);
      const workflowTestFile = path.join(tmpDir, "workflow.test.ts").replace(/\\/g, "/");
      const findings = result.redundancyByFile[workflowTestFile] ?? [];
      expect(findings.some((f) => f.testName.includes("repeats parsing through workflow"))).toBe(true);
      expect(findings.some((f) => f.testName.includes("delegates Left check again"))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. RuleTester — strict-fp/no-redundant-test-scope (TESTSCOPE-001)
// ---------------------------------------------------------------------------

testScopeSampleRuleTester.run("no-redundant-test-scope (TESTSCOPE-001)", noRedundantTestScope, {
  valid: [
    // Non-test production file is a fast no-op
    {
      filename: samplePath("checkout.ts"),
      code: readSample("checkout.ts"),
    },
    // Direct unit tests on leaf component
    {
      filename: samplePath("price-parser.test.ts"),
      code: readSample("price-parser.test.ts"),
    },
    // Composition test, system invariant test, and mocked-dependency test
    {
      filename: samplePath("checkout-valid.test.ts"),
      code: readSample("checkout-valid.test.ts"),
    },
    // Safety guard: sole wiring test on createInvoice -> computeTax is preserved!
    {
      filename: samplePath("invoice-sole-wiring.test.ts"),
      code: readSample("invoice-sole-wiring.test.ts"),
    },
    // Untested lower component (applyDiscount has 0 direct tests -> handled by prefer-lowest-test-level)
    {
      filename: samplePath("quote-lowest-level.test.ts"),
      code: readSample("quote-lowest-level.test.ts"),
    },
  ],
  invalid: [
    // Cross-level redundant assertions (barrel, delegated error, node assert) + duplicate same-level test
    {
      filename: samplePath("checkout-redundant.test.ts"),
      code: readSample("checkout-redundant.test.ts"),
      errors: [
        { messageId: "redundantCrossLevelTest" },
        { messageId: "redundantCrossLevelTest" },
        { messageId: "redundantCrossLevelTest" },
        { messageId: "duplicateSameLevelTest" },
      ],
    },
    // With checkSameLevelDuplicates disabled, only the 3 cross-level redundancies fire
    {
      filename: samplePath("checkout-redundant.test.ts"),
      code: readSample("checkout-redundant.test.ts"),
      options: [{ checkSameLevelDuplicates: false }],
      errors: [
        { messageId: "redundantCrossLevelTest" },
        { messageId: "redundantCrossLevelTest" },
        { messageId: "redundantCrossLevelTest" },
      ],
    },
  ],
});

// ---------------------------------------------------------------------------
// 3. RuleTester — strict-fp/prefer-lowest-test-level (TESTSCOPE-002)
// ---------------------------------------------------------------------------

testScopeSampleRuleTester.run("prefer-lowest-test-level (TESTSCOPE-002)", preferLowestTestLevel, {
  valid: [
    // Non-test file skipped
    {
      filename: samplePath("discount-engine.ts"),
      code: readSample("discount-engine.ts"),
    },
    // Direct unit tests on leaf
    {
      filename: samplePath("price-parser.test.ts"),
      code: readSample("price-parser.test.ts"),
    },
    // Valid composition & invariant tests
    {
      filename: samplePath("checkout-valid.test.ts"),
      code: readSample("checkout-valid.test.ts"),
    },
    // Encapsulation guard: unexported private helper formatLabel is NOT flagged even with 2 tests
    {
      filename: samplePath("invoice-sole-wiring.test.ts"),
      code: readSample("invoice-sole-wiring.test.ts"),
    },
    // Threshold option: minDelegatedCases = 3 allows 2 delegated cases
    {
      filename: samplePath("quote-lowest-level.test.ts"),
      code: readSample("quote-lowest-level.test.ts"),
      options: [{ minDelegatedCases: 3 }],
    },
  ],
  invalid: [
    // Exported untested applyDiscount verified repeatedly only through quoteOrder
    {
      filename: samplePath("quote-lowest-level.test.ts"),
      code: readSample("quote-lowest-level.test.ts"),
      errors: [
        { messageId: "preferLowestTestLevel" },
        { messageId: "preferLowestTestLevel" },
      ],
    },
  ],
});

// ---------------------------------------------------------------------------
// 4. RuleTester — strict-fp/single-test-responsibility (TESTSCOPE-003)
// ---------------------------------------------------------------------------

testScopeSampleRuleTester.run(
  "single-test-responsibility (TESTSCOPE-003)",
  singleTestResponsibility,
  {
    valid: [
      // Non-test file skipped
      {
        filename: samplePath("codec.ts"),
        code: readSample("codec.ts"),
      },
      // Focused component tests
      {
        filename: samplePath("price-parser.test.ts"),
        code: readSample("price-parser.test.ts"),
      },
      // Focused composition / invariant tests
      {
        filename: samplePath("checkout-valid.test.ts"),
        code: readSample("checkout-valid.test.ts"),
      },
      // Threshold option: 3 unrelated clusters passes when minUnrelatedComponents is 4
      {
        filename: samplePath("mixed-responsibility.test.ts"),
        code: readSample("mixed-responsibility.test.ts"),
        options: [{ minUnrelatedComponents: 4 }],
      },
    ],
    invalid: [
      // Flags the 1 test mixing parsePrice + formatEmail + computeShipping,
      // while allowing same-module round-trip (encodePayload/decodePayload)
      // and dataflow composition (parsePrice -> calculateTotal)
      {
        filename: samplePath("mixed-responsibility.test.ts"),
        code: readSample("mixed-responsibility.test.ts"),
        errors: [{ messageId: "multipleTestResponsibilities" }],
      },
    ],
  },
);
