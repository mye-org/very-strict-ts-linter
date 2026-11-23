import strictFp from "./dist/index.js";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "tests/fixtures/**",
      "tests/ddd-sample/**",
      "tests/ts-unit-sample/**",
      "tests/test-scope-sample/**",
    ],
  },
  ...strictFp.createStrictFpConfig({
    boundaryFiles: ["src/cli/**"],
    testFiles: ["**/tests/**/*.ts"],
    domainFiles: ["**/src/**"],
    entryPoints: ["**/src/index.ts"],
  }),
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
