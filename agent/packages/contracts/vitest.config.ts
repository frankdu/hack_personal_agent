import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@agent/contracts",
    root: import.meta.dirname,
    environment: "node",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
