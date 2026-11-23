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
    entryPoints: [
      "**/src/index.ts",
      "**/src/rules/*.ts",
      "**/src/cli/strict-fp-init.ts",
      "**/src/cli/discovery-radar.ts",
      "**/src/cli/strict-fp-lint.ts",
      "**/src/cli/strict-fp-daemon.ts",
    ],
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
