import strictFp from "./dist/index.js";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "tests/fixtures/**", "tests/ddd-sample/**"],
  },
  ...strictFp.createStrictFpConfig({
    boundaryFiles: ["src/cli/**"],
    testFiles: ["tests/**/*.ts"],
  }),
  {
    files: ["src/rules/**/*.ts", "src/utils/**/*.ts", "src/analyzers/**/*.ts"],
    rules: {
      "strict-fp/no-train-wreck-navigation": "off",
      "strict-fp/no-stringly-typed-discriminants": "off",
      "strict-fp/single-level-of-abstraction": "off",
    },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
