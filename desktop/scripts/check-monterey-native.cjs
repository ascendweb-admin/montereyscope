"use strict";

// Build verification only. Inspect the app and the native libraries embedded
// inside the two frozen Python tools before sharing a Monterey installer.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { collectMacNative, nativeMinimum } = require("../lib/mac-native.cjs");
const { compareVersionStrings } = require("../lib/target.cjs");

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "x64");
const app = path.resolve("desktop/dist/mac/scope.app");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scope-monterey-native-"));
try {
  const info = JSON.parse(execFileSync("plutil", [
    "-convert", "json", "-o", "-", path.join(app, "Contents", "Info.plist"),
  ], { encoding: "utf8" }));
  assert.equal(info.LSMinimumSystemVersion, "12.0");
  assert.equal(info.CFBundleIdentifier, "com.scope.desktop");
  const components = collectMacNative(app, scratch);
  assert(components.length > 10, "Expected a complete native dependency inventory");
  let highest = "0";
  for (const component of components) {
    const minimum = nativeMinimum(component, "x64", "12.0");
    console.log(`${component.label}: minimum macOS ${minimum}`);
    if (compareVersionStrings(minimum, highest) > 0) highest = minimum;
  }
  console.log(`PASS: ${components.length} native components fit macOS 12.0; highest minimum ${highest}.`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
