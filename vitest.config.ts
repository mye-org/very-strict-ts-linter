import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/ts-unit-sample/**", "tests/test-scope-sample/**"],
    pool: "threads",
    isolate: false,
    maxWorkers: 4,
    experimental: {
      fsModuleCache: true,
    },
  },
});
