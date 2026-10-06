import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Release-gate checks that are run explicitly (not as part of `npm test`):
 *   npx vitest run --config vitest.checks.config.ts
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/checks/**/*.test.ts"],
  },
});
