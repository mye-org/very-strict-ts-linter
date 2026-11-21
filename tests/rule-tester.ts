import path from "node:path";
import { RuleTester } from "@typescript-eslint/rule-tester";
import * as vitest from "vitest";

RuleTester.afterAll = vitest.afterAll;
RuleTester.describe = vitest.describe;
RuleTester.it = vitest.it;
RuleTester.itOnly = vitest.it.only;

export const createRuleTester = () =>
  new RuleTester();

export const createTypeAwareRuleTester = () =>
  new RuleTester({
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: path.resolve(import.meta.dirname, "fixtures"),
      },
    },
  });

export const createDddSampleRuleTester = () =>
  new RuleTester({
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: path.resolve(import.meta.dirname, "ddd-sample"),
      },
    },
  });
