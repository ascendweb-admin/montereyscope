"use strict";
/**
 * Durable storage for one verified X (Twitter) session.
 *
 * The store owns the encrypted file only. X connection state is tracked by
 * the caller; a storage failure never deletes a previously saved login, and
 * only an explicit clear (Disconnect) removes the ciphertext. Encryption and
 * filesystem access are injected so the failure paths are testable without
 * Electron.
 *
 * File format: safeStorage-encrypted JSON. The current payload is
 * `{ version: 2, savedAt, cookies }`. The pre-migration format was the bare
 * cookie array; it is read, validated, and rewritten atomically only after a
 * successful validated replacement. The old file is preserved on failure.
 */

const nodeCrypto = require("node:crypto");
const nodeFs = require("node:fs");
const nodePath = require("node:path");

const X_COOKIE_DOMAINS = Object.freeze(["x.com", ".x.com", "twitter.com", ".twitter.com"]);
const SUPPORTED_LINUX_BACKENDS = Object.freeze([
  "gnome_libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
]);
const MAX_COOKIES = 200;
const MAX_COOKIE_NAME_LENGTH = 64;
const MAX_COOKIE_VALUE_LENGTH = 8_192;
const MAX_COOKIE_PATH_LENGTH = 256;
const PAYLOAD_VERSION = 2;

const STORAGE_STATES = Object.freeze([
  "checking",
  "saved",
  "locked",
  "unavailable",
  "save_failed",
  "delete_failed",
  "unreadable",
  "not_saved",
]);

const STORAGE_REASONS = Object.freeze([
  "missing_file",
  "no_secure_backend",
  "service_unavailable",
  "restart_required",
  "store_locked",
  "decrypt_failed",
  "corrupt_payload",
  "invalid_payload",
  "encrypt_failed",
  "write_failed",
  "delete_failed",
  "file_unreadable",
]);

function isXDomain(domain) {
  return X_COOKIE_DOMAINS.includes(domain);
}

function secureStorageAvailable(storage, platform = process.platform) {
  if (!storage || typeof storage.isEncryptionAvailable !== "function") return false;
  let encrypted = false;
  try {
    encrypted = storage.isEncryptionAvailable() === true;
  } catch {
    return false;
  }
  if (!encrypted) return false;
  if (platform !== "linux") return true;
  try {
    return SUPPORTED_LINUX_BACKENDS.includes(storage.getSelectedStorageBackend());
  } catch {
    return false;
  }
}

/** Normalizes one stored cookie. Returns null when the fields are not safe to keep. */
function normalizeCookie(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const name = typeof raw.name === "string" ? raw.name : "";
  const value = typeof raw.value === "string" ? raw.value : "";
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name) || name.length > MAX_COOKIE_NAME_LENGTH) return null;
  if (value.length === 0 || value.length > MAX_COOKIE_VALUE_LENGTH) return null;
  const domain = typeof raw.domain === "string" ? raw.domain.toLowerCase() : "";
  if (!isXDomain(domain)) return null;
  const path =
    typeof raw.path === "string" &&
    raw.path.startsWith("/") &&
    raw.path.length <= MAX_COOKIE_PATH_LENGTH
      ? raw.path
      : "/";
  const cookie = {
    name,
    value,
    domain,
    path,
    secure: raw.secure !== false,
    httpOnly: raw.httpOnly === true,
  };
  if (
    raw.sameSite === "unspecified" ||
    raw.sameSite === "no_restriction" ||
    raw.sameSite === "lax" ||
    raw.sameSite === "strict"
  ) {
    cookie.sameSite = raw.sameSite;
  }
  if (
    typeof raw.expirationDate === "number" &&
    Number.isFinite(raw.expirationDate) &&
    raw.expirationDate > 0
  ) {
    cookie.expirationDate = Math.floor(raw.expirationDate);
  }
  return cookie;
}

/** Validates and narrows a cookie list to the approved X domains and fields. */
function normalizeCookies(rawCookies) {
  if (!Array.isArray(rawCookies) || rawCookies.length === 0 || rawCookies.length > MAX_COOKIES) {
    return { ok: false, reason: "invalid_payload" };
  }
  const seen = new Set();
  const cookies = [];
  for (const raw of rawCookies) {
    const cookie = normalizeCookie(raw);
    if (!cookie) continue;
    const key = `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cookies.push(cookie);
  }
  if (cookies.length === 0) return { ok: false, reason: "invalid_payload" };
  return { ok: true, cookies };
}

/**
 * Creates the session store bound to one profile directory.
 *
 * Injected dependencies (all optional but `safeStorage`):
 * - `safeStorage`: `isEncryptionAvailable`, `getSelectedStorageBackend`,
 *   `encryptString`, `decryptString`.
 * - `isServicePresent`: evidence that the OS secret service owns the session
 *   bus name. Presence alone cannot establish that its keyring is locked.
 */
function createXSessionStore({
  safeStorage,
  dataRoot,
  platform = process.platform,
  fs = nodeFs,
  path = nodePath,
  crypto = nodeCrypto,
  filename = "x-session.enc",
  backendAllowlist = SUPPORTED_LINUX_BACKENDS,
  isServicePresent = () => false,
} = {}) {
  if (
    !safeStorage ||
    typeof safeStorage.encryptString !== "function" ||
    typeof safeStorage.decryptString !== "function"
  ) {
    throw new TypeError("x-session-store requires a safeStorage implementation");
  }
  const filePath = path.join(dataRoot, filename);
  let state = "checking";
  let reason = null;
  let savedAt = null;

  function backendName() {
    try {
      const backend = safeStorage.getSelectedStorageBackend();
      return typeof backend === "string" && backend.length > 0 ? backend : null;
    } catch {
      return null;
    }
  }
  function encryptionAvailable() {
    try {
      return safeStorage.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  }
  function protectedBackend() {
    if (!encryptionAvailable()) return false;
    if (platform !== "linux") return true;
    const backend = backendName();
    return backend !== null && backendAllowlist.includes(backend);
  }
  function unavailableReason() {
    if (platform === "linux" && backendAllowlist.includes(backendName()) && isServicePresent()) {
      return "service_unavailable";
    }
    return "no_secure_backend";
  }
  function fileExists() {
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }
  function cleanupTemps() {
    let entries;
    try {
      entries = fs.readdirSync(dataRoot);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(`${filename}.`) && entry.endsWith(".tmp")) {
        try {
          fs.rmSync(path.join(dataRoot, entry), { force: true });
        } catch {
          /* a stale temp file is harmless */
        }
      }
    }
  }
  function selfTest() {
    try {
      const marker = `scope-storage-probe-${crypto.randomUUID()}`;
      return safeStorage.decryptString(safeStorage.encryptString(marker)) === marker;
    } catch {
      return false;
    }
  }
  function syncDirectory() {
    if (platform === "win32") return;
    let fd;
    try {
      fd = fs.openSync(dataRoot, "r");
      fs.fsyncSync(fd);
    } catch {
      /* directory fsync is best effort */
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }
  function replaceFile(temp, target) {
    let attempts = 0;
    for (;;) {
      try {
        fs.renameSync(temp, target);
        return;
      } catch (error) {
        attempts += 1;
        // Windows can hold a transient lock on the destination during a replace.
        if (platform === "win32" && attempts < 3) continue;
        throw error;
      }
    }
  }

  function status() {
    return {
      state,
      reason,
      backend: backendName(),
      savedAt,
    };
  }

  /** Re-reads runtime availability. Callers use this before a recovery retry. */
  function refresh() {
    if (state === "delete_failed") return status();
    if (protectedBackend()) {
      if (!fileExists()) {
        state = "not_saved";
        reason = "missing_file";
      } else if (state === "unavailable" || state === "locked") {
        state = "checking";
        reason = null;
      }
      return status();
    }
    // Service presence does not establish whether a keyring is locked.
    state = "unavailable";
    reason = unavailableReason();
    return status();
  }

  function initialize() {
    state = "checking";
    reason = null;
    cleanupTemps();
    refresh();
    return status();
  }

  /**
   * Reads and validates the saved session. Never deletes the file.
   * Result: `{ ok: true, cookies, migrated, savedAt }` or
   * `{ ok: false, reason: "missing" | "locked" | "unavailable" | "unreadable" }`.
   */
  function load() {
    if (!protectedBackend()) {
      if (state !== "locked" && state !== "unavailable") refresh();
      if (state === "locked") return { ok: false, reason: "locked" };
      state = "unavailable";
      reason = unavailableReason();
      return { ok: false, reason: "unavailable" };
    }
    if (!fileExists()) {
      state = "not_saved";
      reason = "missing_file";
      return { ok: false, reason: "missing" };
    }
    let encrypted;
    try {
      encrypted = fs.readFileSync(filePath);
    } catch {
      state = "unreadable";
      reason = "file_unreadable";
      return { ok: false, reason: "unreadable" };
    }
    let text;
    try {
      text = safeStorage.decryptString(encrypted);
    } catch {
      if (encryptionAvailable() && selfTest()) {
        state = "unreadable";
        reason = "decrypt_failed";
        return { ok: false, reason: "unreadable" };
      }
      if (encryptionAvailable()) {
        state = "unavailable";
        reason = "service_unavailable";
        return { ok: false, reason: "unavailable" };
      }
      state = "unavailable";
      reason = unavailableReason();
      return { ok: false, reason: "unavailable" };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      state = "unreadable";
      reason = "corrupt_payload";
      return { ok: false, reason: "unreadable" };
    }
    const legacy = Array.isArray(parsed);
    const candidate = legacy
      ? parsed
      : parsed && typeof parsed === "object"
        ? parsed.cookies
        : null;
    if (
      !legacy &&
      (typeof parsed !== "object" || parsed === null || parsed.version !== PAYLOAD_VERSION)
    ) {
      state = "unreadable";
      reason = "corrupt_payload";
      return { ok: false, reason: "unreadable" };
    }
    const normalized = normalizeCookies(candidate);
    if (!normalized.ok) {
      state = "unreadable";
      reason = "corrupt_payload";
      return { ok: false, reason: "unreadable" };
    }
    if (legacy) {
      // Migrate only after a successful, validated replacement write. On
      // failure the old file stays and the session still works this run.
      const migration = save(normalized.cookies);
      return {
        ok: true,
        cookies: normalized.cookies,
        migrated: migration.ok === true,
        savedAt: migration.ok === true ? migration.savedAt : null,
      };
    }
    state = "saved";
    reason = null;
    savedAt = typeof parsed.savedAt === "string" ? parsed.savedAt : null;
    return { ok: true, cookies: normalized.cookies, migrated: false, savedAt };
  }

  /**
   * Encrypts and atomically replaces the saved session. Never touches the
   * existing file unless the replacement was written and validated.
   * Result: `{ ok: true, savedAt }` or `{ ok: false, reason }`.
   */
  function save(rawCookies) {
    const normalized = normalizeCookies(rawCookies);
    if (!normalized.ok) {
      state = "save_failed";
      reason = "invalid_payload";
      return { ok: false, reason: "invalid_payload" };
    }
    if (!protectedBackend()) {
      state = "unavailable";
      reason = unavailableReason();
      return { ok: false, reason: "unavailable" };
    }
    const savedAtValue = new Date().toISOString();
    let encrypted;
    try {
      encrypted = safeStorage.encryptString(
        JSON.stringify({
          version: PAYLOAD_VERSION,
          savedAt: savedAtValue,
          cookies: normalized.cookies,
        }),
      );
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0)
        throw new Error("empty ciphertext");
    } catch {
      state = "save_failed";
      reason = "encrypt_failed";
      return { ok: false, reason: "encrypt_failed" };
    }
    const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, encrypted, { mode: 0o600, flag: "wx" });
      let fd;
      try {
        fd = fs.openSync(temp, "r+");
        fs.fsyncSync(fd);
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
      // Validate the exact bytes about to replace the live file.
      const check = JSON.parse(safeStorage.decryptString(fs.readFileSync(temp)));
      if (
        check === null ||
        typeof check !== "object" ||
        check.version !== PAYLOAD_VERSION ||
        !Array.isArray(check.cookies) ||
        check.cookies.length === 0
      ) {
        throw new Error("replacement validation failed");
      }
      replaceFile(temp, filePath);
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        /* Windows ignores POSIX modes */
      }
      syncDirectory();
      cleanupTemps();
      state = "saved";
      reason = null;
      savedAt = savedAtValue;
      return { ok: true, savedAt: savedAtValue };
    } catch {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        /* ignore */
      }
      state = "save_failed";
      reason = "write_failed";
      return { ok: false, reason: "write_failed" };
    }
  }

  /** Removes the saved session and any temporary files. Only Disconnect calls this. */
  function clear() {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      state = "delete_failed";
      reason = "delete_failed";
      return { ...status(), ok: false };
    }
    cleanupTemps();
    state = "not_saved";
    reason = "missing_file";
    savedAt = null;
    return { ...status(), ok: true };
  }

  return {
    initialize,
    refresh,
    load,
    save,
    clear,
    status,
    hasFile: fileExists,
    filePath,
  };
}

module.exports = {
  createXSessionStore,
  secureStorageAvailable,
  isXDomain,
  normalizeCookie,
  normalizeCookies,
  STORAGE_STATES,
  STORAGE_REASONS,
  SUPPORTED_LINUX_BACKENDS,
};
