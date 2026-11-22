import { singleLevelOfAbstraction } from "../src/rules/single-level-of-abstraction.js";
import { createRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();

ruleTester.run("single-level-of-abstraction", singleLevelOfAbstraction, {
  valid: [
    // Pure high-level pipe orchestration
    `const processUser = (raw: RawUser) => pipe(raw, parseUser, normalizeUser, saveUser);`,
    // Pure high-level flow orchestration
    `const processUser = flow(parseUser, normalizeUser, saveUser);`,
    // Pure high-level pipe with trivial property projection
    `const getUserEmail = (raw: RawUser) => pipe(raw, parseUser, (u) => u.email, sendWelcome);`,
    // Pure high-level statement-based orchestrator
    `function handleOrder(raw: RawOrder) {
      const order = parseOrder(raw);
      const priced = calculateTotals(order);
      return saveOrder(priced);
    }`,
    // Pure low-level leaf helper (string / regex manipulation only)
    `const normalizeSlug = (s: string) => s.trim().toLowerCase().replace(/\\s+/g, "-");`,
    // Pure low-level leaf helper using JSON + Math
    `const serializeScore = (n: number) => JSON.stringify({ score: Math.round(n) });`,
    // Pure low-level leaf helper using fp-ts combinators + string ops
    `const cleanTags = (tags: ReadonlyArray<string>) => pipe(tags, RA.map((t) => t.trim().toLowerCase()));`,
    // Trivial projection with ignoreTrivialProjections: false still valid when no high-level calls
    {
      code: `const getId = (u: User) => u.id;`,
      options: [{ ignoreTrivialProjections: false }],
    },
  ],
  invalid: [
    // Mixing high-level pipe steps with inline multi-op lambda
    {
      code: `const processUser = (raw: RawUser) =>
        pipe(
          raw,
          parseUser,
          (u) => ({ ...u, email: u.email.trim().toLowerCase() }),
          saveUser,
        );`,
      errors: [{ messageId: "mixedAbstractionLevels" }],
    },
    // Mixing high-level flow steps with inline lambda
    {
      code: `const processUser = flow(
        parseUser,
        (u) => u.email.trim(),
        saveUser,
      );`,
      errors: [{ messageId: "mixedAbstractionLevels" }],
    },
    // Mixing high-level domain calls with low-level JSON / string ops in function body
    {
      code: `function submitOrder(raw: string) {
        const parsed = JSON.parse(raw);
        const order = validateOrder(parsed);
        return saveOrder(order);
      }`,
      errors: [{ messageId: "mixedAbstractionLevels" }],
    },
    // Mixing high-level call with RegExp / string manipulation
    {
      code: `const registerEmail = (raw: string) => {
        const cleaned = raw.trim().toLowerCase();
        return createAccount(cleaned);
      };`,
      errors: [{ messageId: "mixedAbstractionLevels" }],
    },
    // Mixing imperative control flow with high-level domain calls
    {
      code: `function processPayment(order: Order) {
        if (order.total > 0) {
          return chargeCustomer(order);
        }
        return markFreeOrder(order);
      }`,
      errors: [{ messageId: "mixedAbstractionLevels" }],
    },
    // Mixing template literal assembly with high-level domain calls
    {
      code: `const notifyUser = (user: User) => {
        const msg = \`Hello \${user.name}\`;
        return sendNotification(user, msg);
      };`,
      errors: [{ messageId: "mixedAbstractionLevels" }],
    },
    // Trivial projection flagged when ignoreTrivialProjections: false
    {
      code: `const getUserEmail = (raw: RawUser) => pipe(raw, parseUser, (u) => u.email, sendWelcome);`,
      options: [{ ignoreTrivialProjections: false }],
      errors: [{ messageId: "mixedAbstractionLevels" }],
    },
  ],
});
