import path from "node:path";
import { RuleTester } from "@typescript-eslint/rule-tester";
import * as vitest from "vitest";

RuleTester.afterAll = vitest.afterAll;
RuleTester.describe = vitest.describe;
RuleTester.it = vitest.it;
RuleTester.itOnly = vitest.it.only;

export const createRuleTester = (() =>
  new RuleTester()) satisfies () => RuleTester;

export const createTypeAwareRuleTester = (() =>
  new RuleTester({
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: path.resolve(import.meta.dirname, "fixtures"),
      },
    },
  })) satisfies () => RuleTester;

export const createDddSampleRuleTester = (() =>
  new RuleTester({
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: path.resolve(import.meta.dirname, "ddd-sample"),
      },
    },
  })) satisfies () => RuleTester;

export const createTsUnitSampleRuleTester = (() =>
  new RuleTester({
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: path.resolve(import.meta.dirname, "ts-unit-sample"),
      },
    },
  })) satisfies () => RuleTester;

export const createTestScopeSampleRuleTester = (() =>
  new RuleTester({
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: path.resolve(import.meta.dirname, "test-scope-sample"),
      },
    },
  })) satisfies () => RuleTester;
