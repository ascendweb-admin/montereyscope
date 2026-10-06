"use strict";

/**
 * Offline macOS packaging checks (desktop release stages 4-5): target metadata
 * for both Mac architectures, Mach-O architecture and minimum-OS parsing, the
 * bundled-layout helper, and the electron-builder macOS/DMG configuration in
 * both signing modes.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { packagedMacAppPath, packagedResourcesDirectory } = require("../lib/bundle-layout.cjs");
const { Arch } = require("builder-util");
const { Platform } = require("app-builder-lib");
const { PlatformPackager } = require("app-builder-lib/out/platformPackager");
const {
  RELEASE_TARGETS,
  TARGETS,
  assertBinaryMatchesTarget,
  compareVersionStrings,
  readBinaryArchitecture,
  readMachOMinimumOS,
  requireHostTarget,
  resolveTarget,
} = require("../lib/target.cjs");
const { macSigningPlan } = require("../scripts/mac-signing.cjs");
const { nativeFiles, nativeMinimum } = require("../lib/mac-native.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const configPath = require.resolve("../electron-builder.config.cjs");

function encodeVersion(major, minor, patch = 0) {
  return (major << 16) | (minor << 8) | patch;
}

function loadCommand(kind, values) {
  const size = kind === 0x32 ? 24 : 16;
  const buffer = Buffer.alloc(size);
  buffer.writeUInt32LE(kind, 0);
  buffer.writeUInt32LE(size, 4);
  if (kind === 0x32) {
    buffer.writeUInt32LE(1, 8);
    buffer.writeUInt32LE(values[0], 12);
    buffer.writeUInt32LE(encodeVersion(26, 2), 16);
  } else {
    buffer.writeUInt32LE(values[0], 8);
    buffer.writeUInt32LE(encodeVersion(26, 2), 12);
  }
  return buffer;
}

function thinMachO(cpuType, command) {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpuType, 4);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(1, 16);
  header.writeUInt32LE(command.length, 20);
  return Buffer.concat([header, command]);
}

function universalMachO(slices) {
  const entrySize = 20;
  const tableSize = slices.length * entrySize;
  const firstOffset = 0x100;
  const entries = [];
  const bodies = [];
  let offset = firstOffset;
  for (const [cpuType, body] of slices) {
    entries.push({ cpuType, offset, size: body.length });
    bodies.push(body);
    offset += body.length + 0x100;
  }
  const header = Buffer.alloc(8 + tableSize);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(slices.length, 4);
  entries.forEach((entry, index) => {
    const base = 8 + index * entrySize;
    header.writeUInt32BE(entry.cpuType, base);
    header.writeUInt32BE(0, base + 4);
    header.writeUInt32BE(entry.offset, base + 8);
    header.writeUInt32BE(entry.size, base + 12);
    header.writeUInt32BE(0, base + 16);
  });
  const total = offset;
  const file = Buffer.alloc(total);
  header.copy(file, 0);
  entries.forEach((entry, index) => bodies[index].copy(file, entry.offset));
  return file;
}

const ARM64 = 0x0100000c;
const X64 = 0x01000007;

test("the darwin-arm64 target pins the verified universal yt-dlp asset", () => {
  const target = resolveTarget({
    env: { SCOPE_DESKTOP_TARGET_PLATFORM: "darwin", SCOPE_DESKTOP_TARGET_ARCH: "arm64" },
    platform: "linux",
    arch: "x64",
  });
  assert.equal(target.key, "darwin-arm64");
  assert.equal(target.ytDlpRemote, "yt-dlp_macos");
  assert.equal(target.ytDlpLocal, "yt-dlp");
  assert.equal(target.workerName, "scope-x-worker");
  assert.equal(target.betterSqlite3Prebuild, "darwin-arm64");
  assert.equal(target.minimumMacOS, "13.0");
});

test("the darwin-x64 target is a release target with its own SQLite prebuild", () => {
  const target = resolveTarget({
    env: { SCOPE_DESKTOP_TARGET_PLATFORM: "darwin", SCOPE_DESKTOP_TARGET_ARCH: "x64" },
    platform: "darwin",
    arch: "x64",
  });
  assert.equal(target.key, "darwin-x64");
  assert.equal(target.label, "macOS x64 (Intel)");
  assert.equal(target.ytDlpRemote, "yt-dlp_macos");
  assert.equal(target.ytDlpLocal, "yt-dlp");
  assert.equal(target.workerName, "scope-x-worker");
  assert.equal(target.betterSqlite3Prebuild, "darwin-x64");
  assert.equal(target.minimumMacOS, TARGETS["darwin-arm64"].minimumMacOS);
  assert.ok(RELEASE_TARGETS.includes("darwin-x64"));
  assert.ok(RELEASE_TARGETS.includes("darwin-arm64"));
});

test("native Intel builds refuse an Apple Silicon host and the reverse", () => {
  assert.throws(
    () => requireHostTarget(TARGETS["darwin-x64"], { platform: "darwin", arch: "arm64" }),
    /Cannot build native macOS x64 \(Intel\) artifacts on darwin\/arm64/,
  );
  assert.throws(
    () => requireHostTarget(TARGETS["darwin-arm64"], { platform: "darwin", arch: "x64" }),
    /Cannot build native macOS arm64 \(Apple Silicon\) artifacts on darwin\/x64/,
  );
  assert.equal(
    requireHostTarget(TARGETS["darwin-x64"], { platform: "darwin", arch: "x64" }).key,
    "darwin-x64",
  );
});

test("a universal Mach-O with an arm64 slice satisfies the arm64 target", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scope-macho-test-"));
  const file = path.join(directory, "universal");
  fs.writeFileSync(
    file,
    universalMachO([
      [X64, thinMachO(X64, loadCommand(0x24, [encodeVersion(10, 15)]))],
      [ARM64, thinMachO(ARM64, loadCommand(0x32, [encodeVersion(11, 0)]))],
    ]),
  );
  try {
    assert.deepEqual(readBinaryArchitecture(file), { format: "macho", arch: "universal" });
    assert.doesNotThrow(() => assertBinaryMatchesTarget(file, TARGETS["darwin-arm64"]));
    assert.doesNotThrow(() => assertBinaryMatchesTarget(file, TARGETS["darwin-x64"]));
    assert.equal(readMachOMinimumOS(file, "arm64"), "11.0");
    assert.equal(readMachOMinimumOS(file, "x64"), "10.15");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a thin arm64 leftover is rejected for the Intel target and the reverse", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scope-macho-test-"));
  const armOnly = path.join(directory, "arm64-only");
  const x64Only = path.join(directory, "x64-only");
  fs.writeFileSync(armOnly, thinMachO(ARM64, loadCommand(0x32, [encodeVersion(13, 0)])));
  fs.writeFileSync(x64Only, thinMachO(X64, loadCommand(0x24, [encodeVersion(10, 15)])));
  try {
    assert.throws(
      () => assertBinaryMatchesTarget(armOnly, TARGETS["darwin-x64"]),
      /Wrong architecture: .* is arm64, expected x64/,
    );
    assert.throws(
      () => assertBinaryMatchesTarget(x64Only, TARGETS["darwin-arm64"]),
      /Wrong architecture: .* is x64, expected arm64/,
    );
    assert.throws(
      () => nativeMinimum({ file: armOnly, label: "leftover" }, "x64", "13.0"),
      /missing x64/,
    );
    assert.equal(nativeMinimum({ file: x64Only, label: "intel-dep" }, "x64", "13.0"), "10.15");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Mach-O minimum-OS parsing reads build-version and legacy commands", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scope-macho-test-"));
  const buildVersion = path.join(directory, "build-version");
  const legacy = path.join(directory, "legacy");
  const text = path.join(directory, "notes.txt");
  fs.writeFileSync(buildVersion, thinMachO(ARM64, loadCommand(0x32, [encodeVersion(13, 0)])));
  fs.writeFileSync(legacy, thinMachO(X64, loadCommand(0x24, [encodeVersion(10, 15)])));
  fs.writeFileSync(text, "not a binary");
  try {
    assert.equal(readMachOMinimumOS(buildVersion, "arm64"), "13.0");
    assert.equal(readMachOMinimumOS(legacy, "x64"), "10.15");
    assert.equal(readMachOMinimumOS(text), null);
    assert.deepEqual(readBinaryArchitecture(text), { format: "unknown", arch: null });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("version comparison orders dotted versions numerically", () => {
  assert.equal(compareVersionStrings("13.0", "12.7.6"), 1);
  assert.equal(compareVersionStrings("13", "13.0"), 0);
  assert.equal(compareVersionStrings("11.0", "13.0"), -1);
});

test("native inventory finds SQLite and rejects a newer dependency or missing arm64 slice", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-native-inventory-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(
    path.join(root, "scope"),
    thinMachO(ARM64, loadCommand(0x32, [encodeVersion(13, 0)])),
  );
  fs.writeFileSync(path.join(root, "notes"), "not native");
  const sqlite = path.join(root, "node_modules", "sqlite.node");
  fs.writeFileSync(sqlite, thinMachO(ARM64, loadCommand(0x32, [encodeVersion(14, 0)])));
  const components = nativeFiles(root);
  assert.equal(components.length, 2);
  assert.throws(
    () =>
      nativeMinimum(
        components.find((entry) => entry.file === fs.realpathSync(sqlite)),
        "arm64",
        "13.0",
      ),
    /sqlite.node requires macOS 14.0/,
  );
  fs.writeFileSync(
    sqlite,
    universalMachO([[X64, thinMachO(X64, loadCommand(0x32, [encodeVersion(13, 0)]))]]),
  );
  assert.throws(
    () => nativeMinimum({ file: sqlite, label: "sqlite" }, "arm64", "13.0"),
    /missing arm64/,
  );
  fs.writeFileSync(sqlite, "foreign native module");
  assert.throws(() => nativeFiles(root), /Native dependency is not Mach-O/);
});

test("64-bit universal headers use the full slice offset", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-fat64-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "fat64");
  const binary = Buffer.alloc(512);
  binary.writeUInt32BE(0xcafebabf, 0);
  binary.writeUInt32BE(1, 4);
  binary.writeUInt32BE(ARM64, 8);
  binary.writeBigUInt64BE(256n, 16);
  thinMachO(ARM64, loadCommand(0x32, [encodeVersion(13, 0)])).copy(binary, 256);
  fs.writeFileSync(file, binary);
  assert.equal(readMachOMinimumOS(file, "arm64"), "13.0");
});

test("packaged resources resolve to Contents/Resources on macOS only", () => {
  const context = {
    electronPlatformName: "darwin",
    appOutDir: "/build/dist/mac-arm64",
    packager: { appInfo: { productFilename: "scope" } },
  };
  assert.equal(
    packagedResourcesDirectory(context),
    path.join("/build/dist/mac-arm64", "scope.app", "Contents", "Resources"),
  );
  assert.equal(
    packagedResourcesDirectory({ ...context, electronPlatformName: "linux" }),
    path.join("/build/dist/mac-arm64", "resources"),
  );
});

function loadConfig(env) {
  // Config normalizes MAC_* aliases in process.env for electron-builder.
  const overrides = { CSC_LINK: "", CSC_KEY_PASSWORD: "", CSC_NAME: "", ...env };
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    delete require.cache[configPath];
    return require(configPath);
  } finally {
    console.warn = originalWarn;
    delete require.cache[configPath];
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

const MAC_TARGET_ENV = {
  SCOPE_DESKTOP_TARGET_PLATFORM: "darwin",
  SCOPE_DESKTOP_TARGET_ARCH: "arm64",
};

const MAC_X64_TARGET_ENV = {
  SCOPE_DESKTOP_TARGET_PLATFORM: "darwin",
  SCOPE_DESKTOP_TARGET_ARCH: "x64",
};

for (const arch of ["x64", "arm64"]) {
  test(`macOS ${arch} verification layout matches installed electron-builder output`, () => {
    const config = loadConfig({ ...MAC_TARGET_ENV, SCOPE_DESKTOP_TARGET_ARCH: arch });
    const distRoot = path.join(desktopRoot, "dist");
    // Exercise the installed packager's real directory calculation, so a
    // dependency upgrade or defaultArch change cannot silently break checks.
    const appOutDir = PlatformPackager.prototype.computeAppOutDir.call(
      { platform: Platform.MAC, packagerOptions: {}, platformSpecificBuildOptions: config.mac },
      distRoot,
      Arch[arch],
    );
    assert.equal(packagedMacAppPath(distRoot, arch), path.join(appOutDir, "scope.app"));
    assert.equal(
      path.join(packagedMacAppPath(distRoot, arch), "Contents", "Resources"),
      packagedResourcesDirectory({
        electronPlatformName: "darwin",
        appOutDir,
        packager: { appInfo: { productFilename: config.productName } },
      }),
    );
  });
}

test("macOS packaging uses the versioned arm64 DMG layout", () => {
  const config = loadConfig(MAC_TARGET_ENV);
  assert.deepEqual(config.mac.target, ["dmg"]);
  assert.equal(config.mac.artifactName, "scope-${version}-macos-${arch}.${ext}");
  assert.equal(config.dmg.artifactName, "scope-${version}-macos-${arch}.${ext}");
  assert.equal(config.mac.minimumSystemVersion, TARGETS["darwin-arm64"].minimumMacOS);
  assert.equal(config.dmg.contents.length, 2);
  const link = config.dmg.contents.find((entry) => entry.type === "link");
  assert.equal(link.path, "/Applications");
  // The bundle helper is what afterPack uses; both entitlement files ship.
  assert(fs.existsSync(path.join(desktopRoot, "assets", "entitlements.mac.plist")));
  assert(fs.existsSync(path.join(desktopRoot, "assets", "entitlements.mac.inherit.plist")));
});

test("macOS Intel packaging shares the arm64 app identity, data paths, and DMG layout", () => {
  const config = loadConfig(MAC_X64_TARGET_ENV);
  assert.deepEqual(config.mac.target, ["dmg"]);
  assert.equal(config.mac.artifactName, "scope-${version}-macos-${arch}.${ext}");
  assert.equal(config.dmg.artifactName, "scope-${version}-macos-${arch}.${ext}");
  assert.equal(config.mac.minimumSystemVersion, TARGETS["darwin-x64"].minimumMacOS);
  assert.equal(config.mac.minimumSystemVersion, TARGETS["darwin-arm64"].minimumMacOS);
  assert.equal(config.dmg.contents.length, 2);
  const link = config.dmg.contents.find((entry) => entry.type === "link");
  assert.equal(link.path, "/Applications");
  assert.equal(config.appId, loadConfig(MAC_TARGET_ENV).appId);
  assert.equal(config.productName, loadConfig(MAC_TARGET_ENV).productName);
  assert.deepEqual(config.mac.binaries, loadConfig(MAC_TARGET_ENV).mac.binaries);
  assert.equal(
    config.mac.entitlements,
    loadConfig(MAC_TARGET_ENV).mac.entitlements,
    "both Mac architectures use the same narrow entitlements",
  );
});

test("an unconfigured macOS build is ad-hoc and never notarized", () => {
  const config = loadConfig(MAC_TARGET_ENV);
  assert.equal(config.mac.identity, "-");
  assert.equal(config.mac.hardenedRuntime, false);
  assert.equal(config.mac.notarize, false);
  assert.deepEqual(config.mac.binaries, [
    "Contents/Resources/bin/yt-dlp",
    "Contents/Resources/x-worker/scope-x-worker",
  ]);
});

test("a configured macOS build uses Developer ID signing and notarization", () => {
  const config = loadConfig({
    ...MAC_TARGET_ENV,
    MAC_CSC_LINK: "base64:certificate",
    MAC_CSC_KEY_PASSWORD: "password",
    APPLE_ID: "release@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "app-password",
    APPLE_TEAM_ID: "TEAMID123",
  });
  assert.equal(config.mac.identity, undefined);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.notarize, true);
  assert.equal(config.mac.forceCodeSigning, true);
  assert.equal(config.mac.sign, path.join(desktopRoot, "scripts", "sign-mac.cjs"));
  assert(
    !JSON.stringify(config).includes("base64:certificate"),
    "effective config must not contain secrets",
  );
});

test("a half-configured macOS secret set fails the build", () => {
  assert.throws(
    () => loadConfig({ ...MAC_TARGET_ENV, MAC_CSC_LINK: "base64:certificate" }),
    /half-configured/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...MAC_TARGET_ENV,
        MAC_CSC_LINK: "base64:certificate",
        MAC_CSC_KEY_PASSWORD: "password",
      }),
    /no notarization credentials/,
  );
  assert.throws(
    () => loadConfig({ ...MAC_TARGET_ENV, SCOPE_DESKTOP_MAC_REQUIRE_SIGNING: "1" }),
    /signing is required/i,
  );
});

test("macOS signing plans never echo credential material", () => {
  const plan = macSigningPlan({
    MAC_CSC_LINK: "base64:very-secret-certificate",
    MAC_CSC_KEY_PASSWORD: "very-secret-password",
    APPLE_ID: "release@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "very-secret-app-password",
    APPLE_TEAM_ID: "TEAMID123",
  });
  assert.equal(plan.mode, "signed-notarized");
  assert.equal(plan.notarize, true);
  assert(!JSON.stringify(plan).includes("very-secret"));
});

test("the desktop workflow builds both Mac architectures on native runners", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "../../.github/workflows/desktop-build.yml"),
    "utf8",
  );
  assert.match(workflow, /name: macOS Apple Silicon DMG/);
  assert.match(workflow, /name: macOS Intel DMG/);
  assert.match(workflow, /os: macos-15\b/);
  assert.match(workflow, /os: macos-15-intel/);
  assert.match(workflow, /target_arch: arm64/);
  assert.match(workflow, /target_arch: x64/);
  assert.match(workflow, /package_script: dist:mac\b/);
  assert.match(workflow, /package_script: dist:mac:x64/);
  // Runner architecture is asserted from uname -m instead of trusted from the
  // image label, so a mislabeled runner fails instead of producing a wrong
  // architecture artifact.
  assert.match(workflow, /test "\$\(uname -m\)" = "\$\{\{ matrix\.runner_uname_m \}\}"/);
  assert.match(workflow, /runner_uname_m: arm64/);
  assert.match(workflow, /runner_uname_m: x86_64/);
  // Verification and smoke runs follow the matrix target, so the Intel job
  // cannot silently verify an arm64 bundle.
  const targetArchValues = [...workflow.matchAll(/SCOPE_DESKTOP_TARGET_ARCH: (.+)/g)].map((match) =>
    match[1].trim(),
  );
  assert.ok(targetArchValues.includes("${{ matrix.target_arch }}"));
  assert.ok(
    !targetArchValues.includes("arm64"),
    "no hardcoded arm64 target arch remains in the workflow",
  );
});
