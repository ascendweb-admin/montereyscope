"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { resolveTarget } = require("../lib/target.cjs");

const target = resolveTarget();
const projectRoot = path.resolve(__dirname, "..", "..");
const distDir = process.env.SCOPE_NEXT_DIST_DIR || ".next";
const standaloneRoot = path.join(projectRoot, distDir, "standalone");
const standaloneServer = path.join(standaloneRoot, "server.js");

if (!fs.existsSync(standaloneServer)) {
  throw new Error(
    "Next.js standalone output is missing. Run this script only after a successful npm run build.",
  );
}

function replaceGeneratedDirectory(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`Required build directory is missing: ${source}`);
  }
  if (!destination.startsWith(`${standaloneRoot}${path.sep}`)) {
    throw new Error(`Refusing to replace a directory outside standalone output: ${destination}`);
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true });
}

replaceGeneratedDirectory(path.join(projectRoot, "public"), path.join(standaloneRoot, "public"));
replaceGeneratedDirectory(
  path.join(projectRoot, distDir, "static"),
  path.join(standaloneRoot, distDir, "static"),
);

// Turbopack's standalone tracing still follows some dynamic filesystem probes
// into the checkout (a previous package under desktop/dist and the local
// data/ directory with its database, transcripts, and reports). The server
// never reads them: it runs from compiled output and the desktop host always
// points SCOPE_DB_PATH/SCOPE_AI_JOBS_ROOT at the user data directory. Remove
// them here so they cannot ship, and keep the check in verify-artifacts.
for (const unexpected of ["desktop", "data", "tests", "docs"]) {
  fs.rmSync(path.join(standaloneRoot, unexpected), { recursive: true, force: true });
}

const sqlitePackage = path.join(standaloneRoot, "node_modules", "better-sqlite3");
if (!fs.existsSync(sqlitePackage)) {
  throw new Error("The standalone build did not trace better-sqlite3.");
}
const sqlitePrebuild = path.join(
  sqlitePackage,
  "prebuilds",
  `${target.betterSqlite3Prebuild}.node`,
);
if (!fs.existsSync(sqlitePrebuild)) {
  throw new Error(
    `The standalone build is missing the better-sqlite3 native prebuild for ${target.label} ` +
      `(${path.relative(projectRoot, sqlitePrebuild)}).`,
  );
}

console.log(`Prepared desktop runtime for ${target.label}: ${standaloneRoot}`);
