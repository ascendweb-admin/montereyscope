"use strict";
/**
 * Linux storage backend policy and bounded diagnostics.
 *
 * Electron/Chromium auto-detects the `--password-store` backend from the
 * desktop environment. Compositors Chromium does not recognize (for example
 * Hyprland on Omarchy) fall back to `basic_text`, which Electron reports as
 * "encryption unavailable". When a freedesktop Secret Service owns the session
 * bus, selecting `gnome_libsecret` explicitly restores OS-backed encryption.
 * The switch must be set before the `ready` event, so this module runs during
 * startup, before `app.whenReady()`.
 *
 * KDE sessions are left to Chromium's own detection, and an explicit user
 * choice (`SCOPE_X_STORAGE_BACKEND` or `x-storage.json` in the profile) always
 * wins. Nothing here reads, writes, or logs credentials.
 */

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const { secureStorageAvailable, SUPPORTED_LINUX_BACKENDS } = require("./x-session-store.cjs");

const STORAGE_CONFIG_FILENAME = "x-storage.json";
const BACKEND_CHOICES = Object.freeze(["auto", ...SUPPORTED_LINUX_BACKENDS]);
const SECRET_SERVICE_NAME = "org.freedesktop.secrets";

/** Electron reports backend names with underscores; Chromium's switch uses a hyphen. */
const CHROMIUM_PASSWORD_STORE_VALUES = Object.freeze({
  gnome_libsecret: "gnome-libsecret",
  kwallet: "kwallet",
  kwallet5: "kwallet5",
  kwallet6: "kwallet6",
});

function passwordStoreValue(backend) {
  return CHROMIUM_PASSWORD_STORE_VALUES[backend] ?? null;
}

function normalizeBackendChoice(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "gnome-libsecret") return "gnome_libsecret";
  return BACKEND_CHOICES.includes(normalized) ? normalized : null;
}

/** Reads the optional per-profile preference. Unknown values are ignored. */
function readStorageConfig(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const backend = normalizeBackendChoice(parsed.backend);
      if (backend) return { backend };
    }
  } catch {
    /* a missing or malformed preference uses automatic selection */
  }
  return {};
}

/**
 * Whether a freedesktop Secret Service provider owns the session bus name.
 * Uses `gdbus` (part of glib2, required by Electron on Linux). Any failure is
 * reported as unavailable rather than guessed.
 */
function secretServiceAvailable({ spawn = spawnSync, env = process.env, timeoutMs = 1_500 } = {}) {
  if (
    typeof env.DBUS_SESSION_BUS_ADDRESS !== "string" ||
    env.DBUS_SESSION_BUS_ADDRESS.length === 0
  ) {
    return false;
  }
  let result;
  try {
    result = spawn(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.DBus",
        "--object-path",
        "/org/freedesktop/DBus",
        "--method",
        "org.freedesktop.DBus.NameHasOwner",
        SECRET_SERVICE_NAME,
      ],
      {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
  } catch {
    return false;
  }
  if (!result || result.error || result.status !== 0) return false;
  return /\(\s*true\s*,?\s*\)/.test(String(result.stdout ?? ""));
}

/**
 * Chooses and applies the Chromium password-store switch. Returns a bounded
 * record for the startup diagnostic. `source` explains the decision without
 * exposing profile paths or environment values.
 */
function applyStorageBackendPreference({
  commandLine,
  platform = process.platform,
  env = process.env,
  config = {},
  chooseSecretService = secretServiceAvailable,
}) {
  if (platform !== "linux") {
    return { applied: false, source: "platform_native", backend: null, reason: null };
  }
  const explicit =
    normalizeBackendChoice(env.SCOPE_X_STORAGE_BACKEND) ?? normalizeBackendChoice(config.backend);
  if (explicit && explicit !== "auto") {
    commandLine.appendSwitch("password-store", passwordStoreValue(explicit));
    return { applied: true, source: "explicit", backend: explicit, reason: null };
  }
  if (explicit === "auto") {
    return { applied: false, source: "explicit_auto", backend: null, reason: null };
  }
  const desktop = String(env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();
  if (desktop.includes("kde")) {
    return { applied: false, source: "kde", backend: null, reason: null };
  }
  if (chooseSecretService()) {
    commandLine.appendSwitch("password-store", passwordStoreValue("gnome_libsecret"));
    return { applied: true, source: "secret_service", backend: "gnome_libsecret", reason: null };
  }
  return { applied: false, source: "none", backend: null, reason: "no_secure_backend" };
}

/**
 * Bounded startup diagnostic: platform, Electron version, selected backend,
 * encryption availability, profile kind, preference source, and a fixed
 * reason. The native probe may be deferred where Keychain can prompt during
 * startup. Never records cookies, key material, paths, or exception text.
 */
function collectStorageDiagnostic({
  safeStorage,
  platform = process.platform,
  electronVersion,
  profileKind,
  config = {},
  policy = null,
  probe = true,
}) {
  let backend = null;
  let available = false;
  let reason = probe ? (policy?.reason ?? null) : "probe_deferred";
  if (probe) {
    try {
      const selected = safeStorage.getSelectedStorageBackend();
      backend = typeof selected === "string" ? selected.slice(0, 32) : null;
    } catch {
      reason = reason ?? "backend_unavailable";
    }
    try {
      available = safeStorage.isEncryptionAvailable() === true;
    } catch {
      reason = reason ?? "availability_check_failed";
    }
  }
  return {
    platform,
    electron: String(electronVersion ?? "").slice(0, 24),
    backend,
    protected: probe && available && secureStorageAvailable(safeStorage, platform),
    available,
    profile: profileKind,
    preference: normalizeBackendChoice(config.backend) ?? "auto",
    switchSource: policy?.source ?? null,
    reason,
  };
}

module.exports = {
  applyStorageBackendPreference,
  collectStorageDiagnostic,
  normalizeBackendChoice,
  readStorageConfig,
  secretServiceAvailable,
  STORAGE_CONFIG_FILENAME,
};
