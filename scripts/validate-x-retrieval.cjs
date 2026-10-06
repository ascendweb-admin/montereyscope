"use strict";
// Maintainer-only probe. Reuses Electron's broker; never reads X cookies.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: npm run x:validate-retrieval -- --handle HANDLE [--desktop-pid BACKEND_PID] [--since ISO_INSTANT] [--until ISO_INSTANT] [--pages 2..20] [--reply-id ID] [--long-post-id ID] [--output PATH]\nSee docs/x-retrieval-validation.md. Reads only; default budget: 5 pages / 180 seconds.",
  );
  process.exit(0);
}
const env = { ...process.env, SCOPE_X_VALIDATE_LIVE: "1" };
const flags = {
  "--handle": "SCOPE_X_PROBE_HANDLE",
  "--since": "SCOPE_X_PROBE_SINCE",
  "--until": "SCOPE_X_PROBE_UNTIL",
  "--pages": "SCOPE_X_PROBE_PAGES",
  "--output": "SCOPE_X_PROBE_OUTPUT",
  "--reply-id": "SCOPE_X_PROBE_REPLY_ID",
  "--long-post-id": "SCOPE_X_PROBE_LONG_ID",
};
try {
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i],
      value = args[i + 1];
    if (!value) throw new Error("Missing probe option value");
    if (flag === "--desktop-pid") {
      if (process.platform !== "linux" || !/^\d+$/.test(value))
        throw new Error("Desktop PID attachment requires Linux");
      const entries = fs.readFileSync(`/proc/${value}/environ`, "utf8").split("\0");
      for (const key of ["SCOPE_X_BROKER_ORIGIN", "SCOPE_X_BROKER_TOKEN"]) {
        const entry = entries.find((entry) => entry.startsWith(`${key}=`));
        if (!entry) throw new Error("PID must identify Scope's Next backend process");
        env[key] = entry.slice(key.length + 1);
      }
    } else if (flags[flag]) env[flags[flag]] = value;
    else throw new Error("Unknown retrieval probe option");
  }
  // Credentials are inherited privately, never placed in argv or report output.
  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "../node_modules/vitest/vitest.mjs"),
      "run",
      "tests/integration/x-retrieval-live.test.ts",
    ],
    { env, stdio: "inherit", shell: false },
  );
  process.exitCode = result.status ?? 1;
} catch {
  console.error(
    "Could not start probe. See docs/x-retrieval-validation.md for options and desktop attachment.",
  );
  process.exitCode = 1;
}
