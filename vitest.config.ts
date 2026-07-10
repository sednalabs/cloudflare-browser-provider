import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        "src/browser/client.ts",
        "src/cli/index.ts",
        "src/cli/io.ts",
        "src/index.ts",
        "src/version.ts",
        "src/worker/index.ts",
      ],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      thresholds: {
        branches: 85,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
  },
});
