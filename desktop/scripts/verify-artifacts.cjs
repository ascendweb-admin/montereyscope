"use strict";

/**
 * Post-preparation artifact validation. Runs after the standalone runtime,
 * yt-dlp, and X worker are prepared and before electron-builder packs them,
 * so a stale or wrong-architecture artifact fails fast instead of shipping.
 */
const fs = require("node:fs");
const path = require("node:path");

const { verifyXWorker } = require("../lib/worker-artifacts.cjs");
const { assertBinaryMatchesTarget, resolveTarget } = require("../lib/target.cjs");

const target = resolveTarget();
const projectRoot = path.resolve(__dirname, "..", "..");
const desktopRoot = path.resolve(__dirname, "..");
const distDir = process.env.SCOPE_NEXT_DIST_DIR || ".next";
const standaloneRoot = path.join(projectRoot, distDir, "standalone");
const failures = [];

function check(label, fn) {
  try {
    fn();
    console.log(`ok - ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : error}`);
    console.error(`not ok - ${label}`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function requireFile(file, description) {
  if (!fs.existsSync(file)) {
    throw new Error(`${description} is missing: ${path.relative(projectRoot, file)}`);
  }
  return file;
}

function checkVersions() {
  const rootPackage = readJson(path.join(projectRoot, "package.json"));
  const desktopPackage = readJson(path.join(desktopRoot, "package.json"));
  if (rootPackage.version !== desktopPackage.version) {
    throw new Error(
      `root package.json is ${rootPackage.version} but desktop/package.json is ${desktopPackage.version}`,
    );
  }
  const version = rootPackage.version;
  for (const [label, lockPath, expectedName] of [
    ["package-lock.json", path.join(projectRoot, "package-lock.json"), rootPackage.name],
    ["desktop/package-lock.json", path.join(desktopRoot, "package-lock.json"), desktopPackage.name],
  ]) {
    const lock = readJson(lockPath);
    if (lock.version !== version || lock.packages?.[""]?.version !== version) {
      throw new Error(`${label} does not record version ${version}`);
    }
    if (lock.packages?.[""]?.name !== expectedName) {
      throw new Error(`${label} belongs to ${lock.packages?.[""]?.name}, expected ${expectedName}`);
    }
  }
}

function checkElectronVersion() {
  const desktopPackage = readJson(path.join(desktopRoot, "package.json"));
  const builderConfig = require(path.join(desktopRoot, "electron-builder.config.cjs"));
  const declared = desktopPackage.devDependencies?.electron;
  if (builderConfig.electronVersion !== declared) {
    throw new Error(
      `electron-builder.config.cjs pins ${builderConfig.electronVersion} but desktop/package.json uses ${declared}`,
    );
  }
}

function checkStandaloneRuntime() {
  requireFile(path.join(standaloneRoot, "server.js"), "Next.js standalone server");
  requireFile(path.join(standaloneRoot, "THIRD_PARTY_NOTICES.md"), "Node.js runtime notices");
  requireFile(
    path.join(
      standaloneRoot,
      "node_modules",
      "better-sqlite3",
      "prebuilds",
      `${target.betterSqlite3Prebuild}.node`,
    ),
    `better-sqlite3 ${target.label} prebuild`,
  );
  assertBinaryMatchesTarget(
    path.join(
      standaloneRoot,
      "node_modules",
      "better-sqlite3",
      "prebuilds",
      `${target.betterSqlite3Prebuild}.node`,
    ),
    target,
  );
  // The Claude catalog adapter imports the Agent SDK at request time; a
  // development import does not prove the standalone trace kept it.
  requireFile(
    path.join(standaloneRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs"),
    "Claude Agent SDK in the standalone trace",
  );
  // Dynamic filesystem probes once pulled the whole project (including the
  // developer's data directory and previous packaging output) into the trace.
  for (const forbidden of ["desktop", "data", "tests", "docs"]) {
    if (fs.existsSync(path.join(standaloneRoot, forbidden))) {
      throw new Error(`Standalone runtime wrongly includes ${forbidden}/`);
    }
  }
}

function checkYtDlpNotices() {
  for (const name of ["LICENSE", "THIRD_PARTY_LICENSES.txt"]) {
    requireFile(path.join(desktopRoot, "vendor", "yt-dlp-notices", name), `yt-dlp ${name}`);
  }
}

function checkYtDlp() {
  const asset = path.join(desktopRoot, "vendor", target.ytDlpLocal);
  requireFile(asset, `bundled yt-dlp for ${target.label}`);
  if (target.platform !== "win32") {
    const mode = fs.statSync(asset).mode & 0o111;
    if (mode === 0) {
      throw new Error(`${path.relative(projectRoot, asset)} is not executable`);
    }
  }
  assertBinaryMatchesTarget(asset, target);
}

function checkXWorker() {
  verifyXWorker({
    source: path.join(desktopRoot, "x-worker"),
    output: path.join(desktopRoot, "vendor", "x-worker"),
    target,
  });
}

check("package and lockfile versions agree", checkVersions);
check("electron versions agree", checkElectronVersion);
check("standalone runtime matches the target", checkStandaloneRuntime);
check("bundled yt-dlp matches the target", checkYtDlp);
check("pinned yt-dlp notices are available", checkYtDlpNotices);
check("X worker matches the target", checkXWorker);

if (failures.length > 0) {
  console.error(`Artifact verification failed for ${target.label}:`);
  for (const failure of failures) {
    console.error(` - ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Artifacts verified for ${target.label}.`);
}
