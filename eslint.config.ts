import strictFp from "./dist/index.js";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "tests/fixtures/**"],
  },
  ...strictFp.createStrictFpConfig({
    testFiles: ["tests/**/*.ts"],
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
