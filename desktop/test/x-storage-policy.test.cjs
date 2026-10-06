"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  applyStorageBackendPreference,
  collectStorageDiagnostic,
  normalizeBackendChoice,
  readStorageConfig,
  secretServiceAvailable,
} = require("../lib/x-storage-policy.cjs");

function commandLineProbe() {
  const switches = [];
  return {
    switches,
    commandLine: { appendSwitch: (name, value) => switches.push([name, value]) },
  };
}

test("explicit supported backends are applied and unknown values are ignored", () => {
  assert.equal(normalizeBackendChoice(" Gnome_Libsecret "), "gnome_libsecret");
  assert.equal(normalizeBackendChoice("gnome-libsecret"), "gnome_libsecret");
  assert.equal(normalizeBackendChoice("kwallet6"), "kwallet6");
  assert.equal(normalizeBackendChoice("basic_text"), null);
  assert.equal(normalizeBackendChoice("--password-store=evil"), null);

  const probe = commandLineProbe();
  const applied = applyStorageBackendPreference({
    commandLine: probe.commandLine,
    platform: "linux",
    env: { SCOPE_X_STORAGE_BACKEND: "kwallet6" },
    chooseSecretService: () => false,
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.source, "explicit");
  assert.deepEqual(probe.switches, [["password-store", "kwallet6"]]);

  const ignored = commandLineProbe();
  const fallback = applyStorageBackendPreference({
    commandLine: ignored.commandLine,
    platform: "linux",
    env: { SCOPE_X_STORAGE_BACKEND: "basic_text" },
    config: { backend: "gnome_libsecret" },
    chooseSecretService: () => false,
  });
  assert.equal(fallback.applied, true);
  assert.equal(fallback.backend, "gnome_libsecret");
  // Chromium spells the switch with a hyphen; Electron's backend name uses one.
  assert.deepEqual(ignored.switches, [["password-store", "gnome-libsecret"]]);
});

test("a Secret Service provider selects gnome_libsecret when the desktop is unrecognized", () => {
  const probe = commandLineProbe();
  const policy = applyStorageBackendPreference({
    commandLine: probe.commandLine,
    platform: "linux",
    env: { XDG_CURRENT_DESKTOP: "Hyprland" },
    chooseSecretService: () => true,
  });
  assert.equal(policy.applied, true);
  assert.equal(policy.source, "secret_service");
  assert.deepEqual(probe.switches, [["password-store", "gnome-libsecret"]]);
});

test("KDE detection and missing services leave Chromium's own selection alone", () => {
  const kde = commandLineProbe();
  const kdePolicy = applyStorageBackendPreference({
    commandLine: kde.commandLine,
    platform: "linux",
    env: { XDG_CURRENT_DESKTOP: "KDE" },
    chooseSecretService: () => true,
  });
  assert.equal(kdePolicy.applied, false);
  assert.equal(kdePolicy.source, "kde");
  assert.deepEqual(kde.switches, []);

  const missing = commandLineProbe();
  const missingPolicy = applyStorageBackendPreference({
    commandLine: missing.commandLine,
    platform: "linux",
    env: { XDG_CURRENT_DESKTOP: "Hyprland" },
    chooseSecretService: () => false,
  });
  assert.equal(missingPolicy.applied, false);
  assert.equal(missingPolicy.reason, "no_secure_backend");
  assert.deepEqual(missing.switches, []);

  const windows = commandLineProbe();
  assert.equal(
    applyStorageBackendPreference({ commandLine: windows.commandLine, platform: "win32" }).source,
    "platform_native",
  );
  assert.deepEqual(windows.switches, []);
});

test("storage preferences are read from the profile and bounded", (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scope-x-policy-"));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const file = path.join(dataRoot, "x-storage.json");
  assert.deepEqual(readStorageConfig(file), {});
  fs.writeFileSync(file, JSON.stringify({ backend: "kwallet" }));
  assert.deepEqual(readStorageConfig(file), { backend: "kwallet" });
  fs.writeFileSync(file, JSON.stringify({ backend: "definitely-not" }));
  assert.deepEqual(readStorageConfig(file), {});
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(readStorageConfig(file), {});
});

test("secretServiceAvailable fails closed without a session bus or gdbus output", () => {
  assert.equal(secretServiceAvailable({ env: {} }), false);
  assert.equal(
    secretServiceAvailable({
      env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus" },
      spawn: () => {
        throw new Error("gdbus missing");
      },
    }),
    false,
  );
  const yes = { status: 0, stdout: "(true,)\n", error: undefined };
  assert.equal(
    secretServiceAvailable({
      env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus" },
      spawn: () => yes,
    }),
    true,
  );
  assert.equal(
    secretServiceAvailable({
      env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus" },
      spawn: () => ({ status: 0, stdout: "(false,)\n" }),
    }),
    false,
  );
});

test("diagnostics stay bounded and contain no credential values", () => {
  const diagnostic = collectStorageDiagnostic({
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "gnome_libsecret",
    },
    platform: "linux",
    electronVersion: "44.2.0",
    profileKind: "development",
    config: { backend: "auto" },
    policy: { source: "secret_service", reason: null },
  });
  assert.deepEqual(diagnostic, {
    platform: "linux",
    electron: "44.2.0",
    backend: "gnome_libsecret",
    protected: true,
    available: true,
    profile: "development",
    preference: "auto",
    switchSource: "secret_service",
    reason: null,
  });
  const serialized = JSON.stringify(diagnostic);
  assert(!serialized.includes("/home"));
  assert(!serialized.includes("token"));

  const deferred = collectStorageDiagnostic({
    safeStorage: {
      isEncryptionAvailable: () => {
        throw new Error("must not probe Keychain");
      },
      getSelectedStorageBackend: () => {
        throw new Error("must not probe Keychain");
      },
    },
    platform: "darwin",
    electronVersion: "44.2.0",
    profileKind: "smoke",
    probe: false,
  });
  assert.equal(deferred.reason, "probe_deferred");
  assert.equal(deferred.available, false);
  assert.equal(deferred.protected, false);

  const failing = collectStorageDiagnostic({
    safeStorage: {
      isEncryptionAvailable: () => {
        throw new Error("secret error text");
      },
      getSelectedStorageBackend: () => {
        throw new Error("secret error text");
      },
    },
    platform: "linux",
    electronVersion: "44.2.0",
    profileKind: "packaged",
  });
  assert.equal(failing.available, false);
  assert(!JSON.stringify(failing).includes("secret error text"));
});
