import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Separate Vitest project for the end-to-end suite. These tests drive a
 * real production server (`next start` after `next build`) with a fake
 * yt-dlp executable, so they are slower and need the build artifacts —
 * run them via `npm run test:e2e`, not `npm test`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    // Server startup, readiness polling, restarts, and extraction retries
    // all happen inside one scenario.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // The scenario owns one server process; parallel files would fight
    // over ports and state directories.
    fileParallelism: false,
  },
});
