import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/integration/**/*.test.ts",
      "apps/agent-backend/test/store.integration.test.ts",
    ],
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
