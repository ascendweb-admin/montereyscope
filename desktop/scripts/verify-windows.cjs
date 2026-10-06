"use strict";

/**
 * Windows artifact verification (desktop release stage 3). Runs on Windows
 * after electron-builder produced the NSIS installer:
 *
 * - the unpacked app is a Windows x64 build whose bundled runtime pieces
 *   match the target architecture,
 * - the installer has the versioned download name from the release table,
 * - the signing status matches the explicit signed/unsigned-friends-beta
 *   mode, so an unsigned build can never be mistaken for a signed one.
 *
 * Usage: node desktop/scripts/verify-windows.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  assertBinaryMatchesTarget,
  readBinaryArchitecture,
  resolveTarget,
} = require("../lib/target.cjs");
const { describeWindowsSigning, windowsSigningPlan } = require("./windows-signing.cjs");

if (process.platform !== "win32") {
  throw new Error("verify-windows.cjs verifies a Windows package and must run on Windows.");
}

const target = resolveTarget();
if (target.platform !== "win32") {
  throw new Error(`Expected a win32 target, got ${target.key}. Set SCOPE_DESKTOP_TARGET_* first.`);
}

const desktopRoot = path.resolve(__dirname, "..");
const distRoot = path.join(desktopRoot, "dist");
const version = JSON.parse(
  fs.readFileSync(path.join(desktopRoot, "..", "package.json"), "utf8"),
).version;
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

function requireFile(file, description) {
  if (!fs.existsSync(file)) {
    throw new Error(`${description} is missing: ${path.relative(desktopRoot, file)}`);
  }
  return file;
}

function signatureStatus(file) {
  // Pass the path as data: JSON string escaping is not PowerShell quoting.
  const script =
    "(Get-AuthenticodeSignature -LiteralPath $env:SCOPE_SIGNATURE_FILE -ErrorAction Stop).Status";
  // GitHub's pwsh step can pass a PowerShell 7-only PSModulePath to Windows
  // PowerShell 5.1. Let powershell.exe build its native module search path so
  // Microsoft.PowerShell.Security can autoload.
  const env = { ...process.env, SCOPE_SIGNATURE_FILE: file };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "psmodulepath") delete env[key];
  }
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env,
  }).trim();
}

check("unpacked app is a Windows x64 build", () => {
  const executable = requireFile(
    path.join(distRoot, "win-unpacked", "scope.exe"),
    "unpacked scope.exe",
  );
  assertBinaryMatchesTarget(executable, target);
});

check("bundled runtime pieces match the target", () => {
  const resources = path.join(distRoot, "win-unpacked", "resources");
  requireFile(path.join(resources, "app-server", "server.js"), "packaged app-server");
  for (const [relative, description] of [
    [path.join("bin", "yt-dlp.exe"), "bundled yt-dlp"],
    [path.join("x-worker", "scope-x-worker.exe"), "bundled X worker"],
  ]) {
    const file = requireFile(path.join(resources, relative), description);
    assertBinaryMatchesTarget(file, target);
  }
});

check("bundled yt-dlp notices are present", () => {
  for (const name of ["LICENSE", "THIRD_PARTY_LICENSES.txt"]) {
    requireFile(
      path.join(distRoot, "win-unpacked", "resources", "licenses", "yt-dlp", name),
      `yt-dlp ${name}`,
    );
  }
});

check("bundled Node.js notices are present", () => {
  requireFile(
    path.join(distRoot, "win-unpacked", "resources", "app-server", "THIRD_PARTY_NOTICES.md"),
    "Node.js runtime notices",
  );
});

check("installer uses the versioned download name", () => {
  const installer = requireFile(
    path.join(distRoot, `scope-${version}-windows-x64-setup.exe`),
    "Windows installer",
  );
  const { format } = readBinaryArchitecture(installer);
  if (format !== "pe") {
    throw new Error(`The installer is not a Windows executable (detected ${format}).`);
  }
});

const plan = windowsSigningPlan(process.env);
console.log(describeWindowsSigning(plan));

for (const relative of [
  `scope-${version}-windows-x64-setup.exe`,
  path.join("win-unpacked", "scope.exe"),
]) {
  check(`${relative} signature matches the declared signing mode`, () => {
    const status = signatureStatus(path.join(distRoot, relative));
    const expected = plan.signed ? "Valid" : "NotSigned";
    console.log(`${relative} Authenticode status: ${status}`);
    if (status !== expected) {
      throw new Error(`Expected ${expected} in ${plan.mode} mode, got "${status}".`);
    }
  });
}

if (failures.length > 0) {
  console.error(`Windows artifact verification failed for ${target.label}:`);
  for (const failure of failures) {
    console.error(` - ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Windows artifacts verified for ${target.label} (mode: ${plan.mode}).`);
}
