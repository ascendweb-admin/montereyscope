import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // The end-to-end suite drives a production server and runs separately
    // via `npm run test:e2e` (see vitest.e2e.config.ts).
    exclude: ["tests/e2e/**"],
  },
});
