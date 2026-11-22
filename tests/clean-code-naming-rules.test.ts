import { noGenericUtilityNames } from "../src/rules/no-generic-utility-names.js";
import { createRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();

ruleTester.run("no-generic-utility-names", noGenericUtilityNames, {
  valid: [
    // Descriptive module names from Clean Code guidelines
    {
      filename: "src/lib/formatting/date_formatting.ts",
      code: `export const formatIsoDate = (d: Date) => d.toISOString();`,
    },
    {
      filename: "src/lib/calendar/business_days.ts",
      code: `export const addBusinessDays = (n: number) => n + 1;`,
    },
    {
      filename: "src/users/user_validation.ts",
      code: `export const validateEmail = (email: string) => email.includes("@");`,
    },
    {
      filename: "src/users/permissions.ts",
      code: `export const canEditOrder = (role: string) => role === "admin";`,
    },
    {
      filename: "src/http/retry.ts",
      code: `export const withRetry = (attempts: number) => attempts;`,
    },
    {
      filename: "src/http/pagination.ts",
      code: `export const nextPageCursor = (page: number) => page + 1;`,
    },
    {
      filename: "src/http/auth_headers.ts",
      code: `export const buildBearerHeader = (token: string) => \`Bearer \${token}\`;`,
    },
    {
      filename: "src/text/slugify.ts",
      code: `export const slugify = (text: string) => text.toLowerCase();`,
    },
    {
      filename: "src/text/sanitization.ts",
      code: `export const sanitizeHtml = (raw: string) => raw.trim();`,
    },
    {
      filename: "tests/factories.ts",
      code: `export const buildOrder = () => ({ id: "1" });`,
    },
    {
      filename: "tests/fakes.ts",
      code: `export const fakeClock = () => 0;`,
    },
    {
      filename: "tests/assertions.ts",
      code: `export const assertValidOrder = (id: string) => id.length > 0;`,
    },
    // Cohesive folders by pure capability
    {
      filename: "src/lib/crypto/hash.ts",
      code: `export const hashPayload = (input: string) => input;`,
    },
    {
      filename: "src/lib/collections/group-by.ts",
      code: `export const groupByKey = (xs: ReadonlyArray<string>) => xs;`,
    },
    // Substring lookalikes must not trigger false positives
    {
      filename: "src/math/find-common-prefix.ts",
      code: `export const findCommonElements = (a: ReadonlyArray<string>) => a;`,
    },
    {
      filename: "src/domain/uncommon.ts",
      code: `export const uncommonValue = 1;`,
    },
    {
      filename: "src/cache/utilize.ts",
      code: `export const utilizeCache = () => true;`,
    },
    {
      filename: "src/errors/helpful-errors.ts",
      code: `export const helpfulMessage = "ok";`,
    },
    {
      filename: "src/config/misconfigured.ts",
      code: `export const misconfiguredFlag = false;`,
    },
    // Focused collaborators and legitimate domain/predicate identifiers
    `export type OrderPriceCalculator = { readonly calculate: (n: number) => number };
     export type OrderValidator = { readonly validate: (id: string) => boolean };
     export const commonPrefix = (a: string) => a;
     export const utilityBill = 42;
     const isLocalHelperFunction = (n: string) => n.length > 0;
     const isValidationHelperCall = (n: string) => n.length > 0;`,
    // Third-party package imports containing utils are allowed
    `import { ESLintUtils } from "@typescript-eslint/utils";
     import * as formatting from "./date-formatting.js";
     export const runner = () => [ESLintUtils, formatting];`,
    // allowedNames exempts explicit files, directories, and identifiers
    {
      filename: "src/utils/date_helpers.ts",
      code: `export const UserHelper = () => 1;`,
      options: [
        {
          bannedTerms: ["helper", "helpers", "util", "utils", "common", "misc"],
          allowedNames: ["utils", "date_helpers", "UserHelper"],
          targets: ["file", "directory", "identifier"],
        },
      ],
    },
    // Individual targets can be scoped
    {
      filename: "src/utils/date_helpers.ts",
      code: `export const UserHelper = () => 1;`,
      options: [
        {
          bannedTerms: ["helper", "helpers", "util", "utils", "common", "misc"],
          allowedNames: [],
          targets: [],
        },
      ],
    },
    {
      filename: "src/utils/date_helpers.ts",
      code: `export const formatIsoDate = (d: Date) => d.toISOString();`,
      options: [
        {
          bannedTerms: ["helper", "helpers", "util", "utils", "common", "misc"],
          allowedNames: [],
          targets: ["identifier"],
        },
      ],
    },
  ],
  invalid: [
    // Banned file names from the article (various naming styles)
    {
      filename: "src/date_helpers.ts",
      code: `export const formatIso = (d: Date) => d.toISOString();`,
      errors: [{ messageId: "genericFileName", data: { fileName: "date_helpers.ts", term: "helpers" } }],
    },
    {
      filename: "src/user_utils.ts",
      code: `export const validateUser = (id: string) => id.length > 0;`,
      errors: [{ messageId: "genericFileName", data: { fileName: "user_utils.ts", term: "utils" } }],
    },
    {
      filename: "src/api_helpers.ts",
      code: `export const retryRequest = () => true;`,
      errors: [{ messageId: "genericFileName", data: { fileName: "api_helpers.ts", term: "helpers" } }],
    },
    {
      filename: "src/string_utils.ts",
      code: `export const slugify = (s: string) => s.toLowerCase();`,
      errors: [{ messageId: "genericFileName", data: { fileName: "string_utils.ts", term: "utils" } }],
    },
    {
      filename: "tests/test_helpers.ts",
      code: `export const buildOrder = () => ({ id: "1" });`,
      errors: [{ messageId: "genericFileName", data: { fileName: "test_helpers.ts", term: "helpers" } }],
    },
    {
      filename: "src/helpers.ts",
      code: `export const formatDate = (s: string) => s;`,
      errors: [{ messageId: "genericFileName", data: { fileName: "helpers.ts", term: "helpers" } }],
    },
    {
      filename: "src/utils.ts",
      code: `export const slugify = (s: string) => s;`,
      errors: [{ messageId: "genericFileName", data: { fileName: "utils.ts", term: "utils" } }],
    },
    {
      filename: "src/common.ts",
      code: `export type Currency = "USD" | "EUR";`,
      errors: [{ messageId: "genericFileName", data: { fileName: "common.ts", term: "common" } }],
    },
    {
      filename: "src/misc.ts",
      code: `export const clamp = (n: number) => n;`,
      errors: [{ messageId: "genericFileName", data: { fileName: "misc.ts", term: "misc" } }],
    },
    {
      filename: "src/order.helpers.ts",
      code: `export const priceOrder = (n: number) => n;`,
      errors: [{ messageId: "genericFileName", data: { fileName: "order.helpers.ts", term: "helpers" } }],
    },
    {
      filename: "src/dateHelpers.ts",
      code: `export const formatDate = (s: string) => s;`,
      errors: [{ messageId: "genericFileName", data: { fileName: "dateHelpers.ts", term: "helpers" } }],
    },
    {
      filename: "src/common-types.ts",
      code: `export type Id = string;`,
      errors: [{ messageId: "genericFileName", data: { fileName: "common-types.ts", term: "common" } }],
    },
    {
      filename: "src/misc-functions.ts",
      code: `export const noop = () => undefined;`,
      errors: [{ messageId: "genericFileName", data: { fileName: "misc-functions.ts", term: "misc" } }],
    },
    // Compound suffixes (.test.ts, .spec.ts, .d.ts) still flag underlying junk-drawer basename
    {
      filename: "tests/date_helpers.test.ts",
      code: `export const run = () => true;`,
      errors: [{ messageId: "genericFileName", data: { fileName: "date_helpers.test.ts", term: "helpers" } }],
    },
    {
      filename: "src/user-utils.spec.ts",
      code: `export const run = () => true;`,
      errors: [{ messageId: "genericFileName", data: { fileName: "user-utils.spec.ts", term: "utils" } }],
    },
    {
      filename: "src/string-utils.d.ts",
      code: `export declare const slugify: (s: string) => string;`,
      errors: [{ messageId: "genericFileName", data: { fileName: "string-utils.d.ts", term: "utils" } }],
    },
    // Banned directory names
    {
      filename: "src/utils/date-formatting.ts",
      code: `export const formatDate = (s: string) => s;`,
      errors: [{ messageId: "genericDirectoryName", data: { directory: "utils", term: "utils" } }],
    },
    {
      filename: "src/helpers/retry.ts",
      code: `export const retry = () => true;`,
      errors: [{ messageId: "genericDirectoryName", data: { directory: "helpers", term: "helpers" } }],
    },
    {
      filename: "src/common/errors.ts",
      code: `export type DomainError = string;`,
      errors: [{ messageId: "genericDirectoryName", data: { directory: "common", term: "common" } }],
    },
    {
      filename: "src/misc/slugify.ts",
      code: `export const slugify = (s: string) => s;`,
      errors: [{ messageId: "genericDirectoryName", data: { directory: "misc", term: "misc" } }],
    },
    {
      filename: "tests/test_helpers/factories.ts",
      code: `export const buildOrder = () => ({ id: "1" });`,
      errors: [{ messageId: "genericDirectoryName", data: { directory: "test_helpers", term: "helpers" } }],
    },
    // Both bad directory and bad file name
    {
      filename: "src/utils/date_helpers.ts",
      code: `export const formatDate = (s: string) => s;`,
      errors: [
        { messageId: "genericDirectoryName", data: { directory: "utils", term: "utils" } },
        { messageId: "genericFileName", data: { fileName: "date_helpers.ts", term: "helpers" } },
      ],
    },
    // Banned identifier declarations
    {
      code: `class UserHelper {}`,
      errors: [{ messageId: "genericIdentifierName", data: { name: "UserHelper", term: "helper" } }],
    },
    {
      code: `function dateHelpers() { return 1; }`,
      errors: [{ messageId: "genericIdentifierName", data: { name: "dateHelpers", term: "helpers" } }],
    },
    {
      code: `export const stringUtils = { slugify: (s: string) => s };`,
      errors: [{ messageId: "genericIdentifierName", data: { name: "stringUtils", term: "utils" } }],
    },
    {
      code: `const utils = { a: 1 };`,
      errors: [{ messageId: "genericIdentifierName", data: { name: "utils", term: "utils" } }],
    },
    {
      code: `const common = { version: 1 };`,
      errors: [{ messageId: "genericIdentifierName", data: { name: "common", term: "common" } }],
    },
    {
      code: `const misc = { flag: true };`,
      errors: [{ messageId: "genericIdentifierName", data: { name: "misc", term: "misc" } }],
    },
    {
      code: `type OrderHelper = { readonly total: number };`,
      errors: [{ messageId: "genericIdentifierName", data: { name: "OrderHelper", term: "helper" } }],
    },
    {
      code: `interface ApiUtils { readonly retries: number; }`,
      errors: [{ messageId: "genericIdentifierName", data: { name: "ApiUtils", term: "utils" } }],
    },
    {
      code: `namespace StringUtilities { export const a = 1; }`,
      errors: [{ messageId: "genericIdentifierName", data: { name: "StringUtilities", term: "utilities" } }],
    },
    {
      code: `const APIHelpers = {};`,
      errors: [{ messageId: "genericIdentifierName", data: { name: "APIHelpers", term: "helpers" } }],
    },
    {
      code: `const user_utils = {};`,
      errors: [{ messageId: "genericIdentifierName", data: { name: "user_utils", term: "utils" } }],
    },
    {
      code: `const utils2 = {};`,
      errors: [{ messageId: "genericIdentifierName", data: { name: "utils2", term: "utils" } }],
    },
    // Namespace imports and aliased exports
    {
      code: `import * as utils from "./date-formatting.js"; export const x = utils;`,
      errors: [{ messageId: "genericIdentifierName", data: { name: "utils", term: "utils" } }],
    },
    {
      code: `import * as dateHelpers from "./date-formatting.js"; export const x = dateHelpers;`,
      errors: [{ messageId: "genericIdentifierName", data: { name: "dateHelpers", term: "helpers" } }],
    },
    {
      code: `const formatDate = (s: string) => s; export { formatDate as dateHelper };`,
      errors: [{ messageId: "genericIdentifierName", data: { name: "dateHelper", term: "helper" } }],
    },
    // Custom bannedTerms option
    {
      filename: "src/shared/order-stuff.ts",
      code: `export const orderStuff = () => 1;`,
      options: [
        {
          bannedTerms: ["stuff", "shared"],
          allowedNames: [],
          targets: ["file", "directory", "identifier"],
        },
      ],
      errors: [
        { messageId: "genericDirectoryName", data: { directory: "shared", term: "shared" } },
        { messageId: "genericFileName", data: { fileName: "order-stuff.ts", term: "stuff" } },
        { messageId: "genericIdentifierName", data: { name: "orderStuff", term: "stuff" } },
      ],
    },
  ],
});
