import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Avatars render directly from their remote URLs via plain <img>.
      // Routing them through next/image would make the server fetch and
      // cache image binaries on disk, which scope deliberately avoids.
      "@next/next/no-img-element": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-x-*/**",
    "desktop/.runtime/**",
    "desktop/dist/**",
    "desktop/vendor/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Standalone CommonJS tool scripts (the fake yt-dlp executables used by
    // the integration and e2e suites) legitimately use require().
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
