import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: [{ find: "node:test", replacement: fileURLToPath(new URL("./scripts/vitest-node-test.mjs", import.meta.url)) }],
  },
  test: {
    include: ["web-search.tests/*.test.mjs"],
    exclude: ["web-search.tests/raw-*.test.mjs"],
    setupFiles: ["./scripts/vitest-isolation.mjs"],
    isolate: true,
    pool: "forks",
    maxWorkers: 4,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
