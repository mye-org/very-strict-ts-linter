import strictFp from "./dist/index.js";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "tests/fixtures/**"],
  },
  ...strictFp.createStrictFpConfig({
    boundaryFiles: [
      "src/rules/**/*.ts",
      "src/utils/type-helpers.ts",
      "src/configs/recommended.ts",
      "src/index.ts",
      "eslint.config.ts",
    ],
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
