"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createXSessionStore,
  secureStorageAvailable,
  normalizeCookies,
  isXDomain,
} = require("../lib/x-session-store.cjs");

const X_COOKIES = [
  {
    domain: ".x.com",
    name: "auth_token",
    value: "synthetic-auth",
    path: "/",
    secure: true,
    httpOnly: true,
  },
  {
    domain: ".x.com",
    name: "ct0",
    value: "synthetic-csrf",
    path: "/",
    secure: true,
    httpOnly: true,
  },
];

function fakeSafeStorage(overrides = {}) {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (text) => Buffer.from(`enc:${text}`),
    decryptString: (bytes) => {
      const text = Buffer.from(bytes).toString();
      if (!text.startsWith("enc:")) throw new Error("could not decrypt");
      return text.slice(4);
    },
    ...overrides,
  };
}

/** Real filesystem with switchable write and rename failures. */
function faultFs() {
  const proxy = Object.create(fs);
  proxy.failWrites = false;
  proxy.renameFailures = 0;
  proxy.writeFileSync = (...args) => {
    if (proxy.failWrites) throw new Error("disk full");
    return fs.writeFileSync(...args);
  };
  proxy.renameSync = (...args) => {
    if (proxy.renameFailures > 0) {
      proxy.renameFailures -= 1;
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    }
    return fs.renameSync(...args);
  };
  return proxy;
}

function setup(t, options = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scope-x-store-"));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const store = createXSessionStore({
    safeStorage: options.safeStorage ?? fakeSafeStorage(),
    dataRoot,
    fs: options.fs,
    platform: options.platform ?? process.platform,
    isServicePresent: options.isServicePresent ?? (() => false),
  });
  return { store, dataRoot, file: path.join(dataRoot, "x-session.enc") };
}

test("secureStorageAvailable rejects basic_text and missing encryption", () => {
  assert(
    !secureStorageAvailable(
      { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text" },
      "linux",
    ),
  );
  assert(
    !secureStorageAvailable(
      { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => "gnome_libsecret" },
      "linux",
    ),
  );
  assert(
    secureStorageAvailable(
      { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "kwallet6" },
      "linux",
    ),
  );
});

test("plaintext fallback storage is rejected and never writes a file", (t) => {
  const { store, dataRoot, file } = setup(t, {
    safeStorage: fakeSafeStorage({
      isEncryptionAvailable: () => false,
      getSelectedStorageBackend: () => "basic_text",
    }),
  });
  assert.equal(store.initialize().state, "unavailable");
  const result = store.save(X_COOKIES);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unavailable");
  assert.equal(store.status().state, "unavailable");
  assert(!fs.existsSync(file));
  assert.deepEqual(fs.readdirSync(dataRoot), []);
});

test("save and load round-trip a versioned payload with restrictive permissions", (t) => {
  const { store, file } = setup(t);
  store.initialize();
  assert.equal(store.save(X_COOKIES).ok, true);
  assert.equal(store.status().state, "saved");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")),
    [],
  );
  const loaded = store.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.migrated, false);
  assert.equal(loaded.cookies.length, 2);
  assert.equal(loaded.cookies[0].name, "auth_token");
  assert.equal(loaded.cookies[0].value, "synthetic-auth");
  const parsed = JSON.parse(fs.readFileSync(file).toString().slice(4));
  assert.equal(parsed.version, 2);
  assert.ok(parsed.savedAt);
  assert(!JSON.stringify(store.status()).includes("synthetic"));
});

test("legacy cookie-array files migrate only after a validated replacement", (t) => {
  const { store, file } = setup(t);
  const encrypted = Buffer.from(`enc:${JSON.stringify(X_COOKIES)}`);
  fs.writeFileSync(file, encrypted, { mode: 0o600 });
  store.initialize();
  const loaded = store.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.cookies.length, 2);
  const rewritten = JSON.parse(fs.readFileSync(file).toString().slice(4));
  assert.equal(rewritten.version, 2);
});

test("a failed legacy migration preserves the old file and keeps the session usable", (t) => {
  const fault = faultFs();
  const { store, file } = setup(t, { fs: fault });
  fs.writeFileSync(file, Buffer.from(`enc:${JSON.stringify(X_COOKIES)}`), { mode: 0o600 });
  const original = fs.readFileSync(file);
  store.initialize();
  fault.failWrites = true;
  const loaded = store.load();
  fault.failWrites = false;
  assert.equal(loaded.ok, true);
  assert.equal(loaded.migrated, false);
  assert.equal(loaded.cookies.length, 2);
  assert.equal(store.status().state, "save_failed");
  assert.deepEqual(fs.readFileSync(file), original);
});

test("corrupt, truncated, and invalid-domain files are unreadable but preserved", (t) => {
  const { store, file } = setup(t);
  fs.writeFileSync(file, Buffer.from("not-encrypted"), { mode: 0o600 });
  store.initialize();
  const decryptFailure = store.load();
  assert.equal(decryptFailure.ok, false);
  assert.equal(store.status().state, "unreadable");
  assert.equal(store.status().reason, "decrypt_failed");
  assert(fs.existsSync(file));

  fs.writeFileSync(file, Buffer.from("enc:{not json"), { mode: 0o600 });
  store.refresh();
  assert.equal(store.load().ok, false);
  assert.equal(store.status().reason, "corrupt_payload");

  fs.writeFileSync(file, Buffer.from('enc:[{"domain":"example.com","name":"a","value":"b"}]'), {
    mode: 0o600,
  });
  store.refresh();
  assert.equal(store.load().ok, false);
  assert.equal(store.status().reason, "corrupt_payload");
  assert(fs.existsSync(file));
});

test("service presence alone does not establish a locked store", (t) => {
  const safeStorage = fakeSafeStorage({
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => "gnome_libsecret",
  });
  const { store, file } = setup(t, {
    safeStorage,
    platform: "linux",
    isServicePresent: () => true,
  });
  fs.writeFileSync(file, Buffer.from("enc:[]"), { mode: 0o600 });
  assert.equal(store.initialize().state, "unavailable");
  assert.equal(store.status().reason, "service_unavailable");
  const loaded = store.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, "unavailable");
  assert(fs.existsSync(file));
});

test("an unavailable store keeps an existing ciphertext and recovers after retry", (t) => {
  let available = { value: false };
  const safeStorage = fakeSafeStorage({
    isEncryptionAvailable: () => available.value,
    getSelectedStorageBackend: () => (available.value ? "gnome_libsecret" : "basic_text"),
  });
  const { store, file } = setup(t, { safeStorage });
  fs.writeFileSync(file, Buffer.from(`enc:${JSON.stringify(X_COOKIES)}`), { mode: 0o600 });
  assert.equal(store.initialize().state, "unavailable");
  assert.equal(store.load().ok, false);
  assert(fs.existsSync(file));
  available.value = true;
  const retried = store.load();
  assert.equal(retried.ok, true);
  assert.equal(store.status().state, "saved");
  assert(fs.existsSync(file));
});

test("a failed replacement keeps the previous file and a Windows retry succeeds", (t) => {
  const failing = faultFs();
  const { store, file } = setup(t, { fs: failing });
  store.save(X_COOKIES);
  const previous = fs.readFileSync(file);
  failing.renameFailures = Infinity;
  const failed = store.save([{ ...X_COOKIES[0], value: "new-value" }]);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "write_failed");
  assert.equal(store.status().state, "save_failed");
  assert.deepEqual(fs.readFileSync(file), previous);
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")),
    [],
  );

  const windowsFault = faultFs();
  windowsFault.renameFailures = 1;
  const windows = setup(t, { platform: "win32", fs: windowsFault });
  assert.equal(windows.store.save(X_COOKIES).ok, true);
});

test("transient encryption failure keeps status bounded and clear removes the file", (t) => {
  let failEncryption = true;
  const { store, file } = setup(t, {
    safeStorage: fakeSafeStorage({
      encryptString: (text) => {
        if (failEncryption) throw new Error("secret detail that must not leak");
        return Buffer.from(`enc:${text}`);
      },
    }),
  });
  store.initialize();
  const failed = store.save(X_COOKIES);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "encrypt_failed");
  assert.equal(store.status().state, "save_failed");
  assert(!JSON.stringify(store.status()).includes("secret detail"));
  failEncryption = false;
  assert.equal(store.save(X_COOKIES).ok, true);
  store.clear();
  assert(!fs.existsSync(file));
  assert.equal(store.status().state, "not_saved");
});

test("cookie validation restricts domains, names, and bounds", () => {
  assert(isXDomain(".x.com") && isXDomain("twitter.com"));
  assert(!isXDomain("x.com.evil.example"));
  const filtered = normalizeCookies([
    ...X_COOKIES,
    { domain: "example.com", name: "irrelevant", value: "DO-NOT-KEEP" },
    { domain: ".x.com", name: "bad name", value: "x" },
    { domain: ".x.com", name: "huge", value: "x".repeat(9_000) },
  ]);
  assert.equal(filtered.ok, true);
  assert.equal(filtered.cookies.length, 2);
  assert(!JSON.stringify(filtered).includes("DO-NOT-KEEP"));
  assert.equal(normalizeCookies([]).ok, false);
  assert.equal(normalizeCookies([{ domain: "example.com", name: "a", value: "b" }]).ok, false);
});

test("basic_text with an existing file and service is not misreported as locked", (t) => {
  const { store, file } = setup(t, {
    platform: "linux",
    isServicePresent: () => true,
    safeStorage: fakeSafeStorage({
      isEncryptionAvailable: () => false,
      getSelectedStorageBackend: () => "basic_text",
    }),
  });
  fs.writeFileSync(file, "synthetic");
  assert.equal(store.initialize().state, "unavailable");
  assert.equal(store.status().reason, "no_secure_backend");
  assert.equal(store.load().reason, "unavailable");
  assert(fs.existsSync(file));
});
