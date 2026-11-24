import { preferIoEitherOverTryCatch } from "../src/rules/prefer-io-either-over-try-catch.js";
import { createRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();

ruleTester.run("prefer-io-either-over-try-catch", preferIoEitherOverTryCatch, {
  valid: [
    // Monadic error handling
    `const res = E.tryCatch(() => JSON.parse(raw), (e) => e);`,
    `const ioRes = IOE.tryCatch(() => fs.readFileSync(path, "utf8"), (e) => e);`,
    // Async functions are exempt (handled by TaskEither / async rules)
    `async function loadAsync(path: string) {
      try {
        return await fetch(path);
      } catch {
        return null;
      }
    }`,
    `const fetchAsync = async () => {
      try {
        return await Promise.resolve(1);
      } catch {
        return 0;
      }
    };`,
    // *Unsafe* and unsafe* and must* scopes are exempt
    `function parseUnsafe(raw: string) {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }`,
    `const unsafeParse = (raw: string) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };`,
    `function mustParse(raw: string) {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }`,
    `const runUnsafeTask = () => {
      const inner = () => {
        try {
          return 1;
        } catch {
          return 0;
        }
      };
      return inner();
    };`,
  ],
  invalid: [
    {
      code: `function parse(raw: string) {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }`,
      errors: [{ messageId: "preferIoEitherOverTryCatch" }],
    },
    {
      code: `const readConfig = (path: string) => {
        try {
          return fs.readFileSync(path, "utf8");
        } catch (err) {
          return "";
        }
      };`,
      errors: [{ messageId: "preferIoEitherOverTryCatch" }],
    },
    // Top-level try/catch
    {
      code: `try {
        doWork();
      } catch {
        recover();
      }`,
      errors: [{ messageId: "preferIoEitherOverTryCatch" }],
    },
    // Non-async callback nested inside an async function
    {
      code: `async function outer() {
        const inner = () => {
          try {
            return 1;
          } catch {
            return 0;
          }
        };
        return inner();
      }`,
      errors: [{ messageId: "preferIoEitherOverTryCatch" }],
    },
  ],
});
