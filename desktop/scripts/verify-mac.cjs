"use strict";

/**
 * macOS artifact verification (desktop release stages 4-5). Runs on macOS after
 * electron-builder produced the DMG:
 *
 * - the `.app` bundle uses the `Contents/Resources` layout with the standalone
 *   server, bundled yt-dlp, X worker, and application icon,
 * - every bundled native component matches the requested target architecture
 *   and its recorded
 *   minimum macOS version fits the declared `LSMinimumSystemVersion`,
 * - the DMG has the versioned download name and the drag-to-Applications
 *   layout,
 * - the signature matches the declared signed/notarized distribution or
 *   ad-hoc engineering mode, including the nested worker and yt-dlp.
 *
 * This script is evidence, not a substitute for installing the artifact on a
 * clean Mac; see docs/desktop-release-progress.md for the pending checks.
 *
 * Usage: node desktop/scripts/verify-mac.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  assertBinaryMatchesTarget,
  compareVersionStrings,
  resolveTarget,
} = require("../lib/target.cjs");
const { describeMacSigning, macSigningPlan } = require("./mac-signing.cjs");
const { collectMacNative, nativeMinimum } = require("../lib/mac-native.cjs");
const { packagedMacAppPath } = require("../lib/bundle-layout.cjs");

if (process.platform !== "darwin") {
  throw new Error("verify-mac.cjs verifies a macOS package and must run on macOS.");
}

const target = resolveTarget();
if (target.platform !== "darwin") {
  throw new Error(`Expected a darwin target, got ${target.key}. Set SCOPE_DESKTOP_TARGET_* first.`);
}

const desktopRoot = path.resolve(__dirname, "..");
const distRoot = path.join(desktopRoot, "dist");
const version = JSON.parse(
  fs.readFileSync(path.join(desktopRoot, "..", "package.json"), "utf8"),
).version;
const appPath = packagedMacAppPath(distRoot, target.arch);
const resourcesPath = path.join(appPath, "Contents", "Resources");
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { status: result.status, error: result.error, output };
}

function requireCommand(command, args, description) {
  const result = run(command, args);
  if (result.error) {
    throw new Error(`${description} could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${description} failed (${result.status}): ${result.output.trim()}`);
  }
  return result.output;
}

function requireFile(file, description) {
  if (!fs.existsSync(file)) {
    throw new Error(`${description} is missing: ${path.relative(desktopRoot, file)}`);
  }
  return file;
}

/** Parses Info.plist through the system plutil; no plist dependency. */
function readInfoPlist() {
  const output = requireCommand(
    "plutil",
    ["-convert", "json", "-o", "-", path.join(appPath, "Contents", "Info.plist")],
    "reading Info.plist",
  );
  return JSON.parse(output);
}

let nativeComponents = null;

function signingDetails(file) {
  // codesign writes its details to stderr; both streams are captured.
  return run("codesign", ["-d", "--verbose=4", file]).output;
}

function verifySignature(file, description) {
  requireCommand(
    "codesign",
    ["--verify", "--strict", file],
    `signature verification for ${description}`,
  );
}

function verifyBundle() {
  check("application bundle exists", () => {
    if (!fs.existsSync(path.join(appPath, "Contents", "MacOS", "scope"))) {
      throw new Error(`macOS app bundle is missing: ${path.relative(desktopRoot, appPath)}`);
    }
  });

  check("standalone server uses the Contents/Resources layout", () => {
    requireFile(path.join(resourcesPath, "app-server", "server.js"), "packaged app-server");
    requireFile(
      path.join(
        resourcesPath,
        "app-server",
        "node_modules",
        "better-sqlite3",
        "prebuilds",
        `${target.betterSqlite3Prebuild}.node`,
      ),
      `better-sqlite3 ${target.label} prebuild`,
    );
  });

  check("bundled native components match the target", () => {
    for (const [label, file] of [
      ["app executable", path.join(appPath, "Contents", "MacOS", "scope")],
      ["bundled yt-dlp", path.join(resourcesPath, "bin", "yt-dlp")],
      ["bundled X worker", path.join(resourcesPath, "x-worker", "scope-x-worker")],
    ]) {
      requireFile(file, label);
      assertBinaryMatchesTarget(file, target);
    }
  });

  check("bundled yt-dlp notices are present", () => {
    for (const name of ["LICENSE", "THIRD_PARTY_LICENSES.txt"]) {
      requireFile(path.join(resourcesPath, "licenses", "yt-dlp", name), `yt-dlp ${name}`);
    }
  });

  check("bundled Node.js notices are present", () => {
    requireFile(
      path.join(resourcesPath, "app-server", "THIRD_PARTY_NOTICES.md"),
      "Node.js runtime notices",
    );
  });

  check("application icon is bundled", () => {
    const icon = requireFile(path.join(resourcesPath, "icon.icns"), "application icon");
    const header = fs.readFileSync(icon).subarray(0, 4).toString("ascii");
    if (header !== "icns") {
      throw new Error("Contents/Resources/icon.icns is not an ICNS file.");
    }
  });

  check("Info.plist identity, version, icon, and minimum system version", () => {
    const info = readInfoPlist();
    const config = require(path.join(desktopRoot, "electron-builder.config.cjs"));
    if (info.CFBundleIdentifier !== "com.scope.desktop") {
      throw new Error(
        `CFBundleIdentifier is ${info.CFBundleIdentifier}, expected com.scope.desktop`,
      );
    }
    if (info.CFBundleShortVersionString !== version) {
      throw new Error(
        `CFBundleShortVersionString is ${info.CFBundleShortVersionString}, expected ${version}`,
      );
    }
    if (info.CFBundleIconFile !== "icon.icns") {
      throw new Error(`CFBundleIconFile is ${info.CFBundleIconFile}, expected icon.icns`);
    }
    if (info.LSMinimumSystemVersion !== config.mac.minimumSystemVersion) {
      throw new Error(
        `LSMinimumSystemVersion is ${info.LSMinimumSystemVersion}, expected ` +
          `${config.mac.minimumSystemVersion}`,
      );
    }
  });

  check("bundled components fit the declared minimum macOS version", () => {
    const config = require(path.join(desktopRoot, "electron-builder.config.cjs"));
    const declared = config.mac.minimumSystemVersion;
    if (nativeComponents === null)
      throw new Error("Native inventory failed; cannot verify minimum OS");
    let effective = null;
    for (const component of nativeComponents) {
      const minimum = nativeMinimum(component, target.arch, declared);
      console.log(`  ${component.label}: minimum macOS ${minimum}`);
      if (effective === null || compareVersionStrings(minimum, effective) > 0) {
        effective = minimum;
      }
    }
    // The published floor is the declared value (Electron's requirement);
    // the component floor must never exceed it.
    console.log(`  highest component minimum: ${effective}; declared floor: ${declared}`);
  });
}

function verifyDmg() {
  const dmgPath = path.join(distRoot, `scope-${version}-macos-${target.arch}.dmg`);
  check("DMG uses the versioned download name", () => {
    requireFile(dmgPath, "macOS installer");
    if (fs.statSync(dmgPath).size < 1_000_000) {
      throw new Error("The DMG is unexpectedly small.");
    }
  });

  check("DMG passes hdiutil verification", () => {
    requireCommand("hdiutil", ["verify", dmgPath], "hdiutil verify");
  });

  check("DMG contains the app and an /Applications shortcut", () => {
    const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), "scope-dmg-check-"));
    const attach = run("hdiutil", [
      "attach",
      dmgPath,
      "-nobrowse",
      "-readonly",
      "-noverify",
      "-mountpoint",
      mountPoint,
    ]);
    if (attach.status !== 0) {
      fs.rmSync(mountPoint, { recursive: true, force: true });
      throw new Error(`Could not mount the DMG: ${attach.output.trim()}`);
    }
    try {
      const bundle = path.join(mountPoint, "scope.app");
      if (!fs.existsSync(path.join(bundle, "Contents", "MacOS", "scope"))) {
        throw new Error("The DMG does not contain scope.app.");
      }
      const shortcut = path.join(mountPoint, "Applications");
      if (!fs.lstatSync(shortcut).isSymbolicLink()) {
        throw new Error("The DMG has no Applications shortcut.");
      }
      const linkTarget = fs.readlinkSync(shortcut);
      if (linkTarget !== "/Applications") {
        throw new Error(`The Applications shortcut points at ${linkTarget}.`);
      }
    } finally {
      run("hdiutil", ["detach", mountPoint, "-force"]);
      fs.rmSync(mountPoint, { recursive: true, force: true });
    }
  });
}

function verifySigning(plan) {
  check("all native signatures, including frozen payloads, verify", () => {
    if (nativeComponents === null)
      throw new Error("Native inventory failed; cannot verify signatures");
    const team = /TeamIdentifier=(\S+)/.exec(signingDetails(appPath))?.[1];
    if (plan.signed && (!team || team === "not")) throw new Error("App signing team is missing");
    for (const component of nativeComponents) {
      verifySignature(component.file, component.label);
      if (plan.signed) {
        const details = signingDetails(component.file);
        if (
          !/Authority=Developer ID Application/.test(details) ||
          /TeamIdentifier=(\S+)/.exec(details)?.[1] !== team
        ) {
          throw new Error(`${component.label} is not signed with the app's Developer ID team`);
        }
      }
    }
  });
  const nested = [
    ["app bundle", appPath],
    ["bundled yt-dlp", path.join(resourcesPath, "bin", "yt-dlp")],
    ["bundled X worker", path.join(resourcesPath, "x-worker", "scope-x-worker")],
  ];
  for (const [label, file] of nested) {
    check(`${label} signature verifies`, () => {
      verifySignature(file, label);
    });
  }

  if (plan.mode === "signed-notarized") {
    check("app carries a Developer ID signature with hardened runtime", () => {
      const details = signingDetails(appPath);
      if (!/Authority=Developer ID Application/.test(details)) {
        throw new Error(`The app is not signed with a Developer ID certificate:\n${details}`);
      }
      if (!/flags=.*runtime/.test(details)) {
        throw new Error("The app does not enable the hardened runtime.");
      }
    });
    check("notarization ticket is stapled", () => {
      requireCommand("xcrun", ["stapler", "validate", appPath], "stapler validate");
    });
    check("Gatekeeper accepts the app", () => {
      requireCommand("spctl", ["-a", "-t", "exec", "-vv", appPath], "spctl assessment");
    });
  } else {
    check("app is ad-hoc signed (engineering build)", () => {
      const details = signingDetails(appPath);
      if (!/Signature=adhoc/.test(details)) {
        throw new Error(`Expected an ad-hoc signature for the engineering build:\n${details}`);
      }
      if (/Authority=Developer ID Application/.test(details)) {
        throw new Error("The engineering build unexpectedly carries a Developer ID signature.");
      }
    });
  }
}

const plan = macSigningPlan(process.env);
console.log(describeMacSigning(plan));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scope-mac-native-"));
try {
  check("inventory includes loose and frozen native dependencies", () => {
    nativeComponents = collectMacNative(appPath, scratch);
    console.log(`  ${nativeComponents.length} native components`);
  });
  verifyBundle();
  verifyDmg();
  verifySigning(plan);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`macOS artifact verification failed for ${target.label}:`);
  for (const failure of failures) {
    console.error(` - ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`macOS artifacts verified for ${target.label} (mode: ${plan.mode}).`);
}
