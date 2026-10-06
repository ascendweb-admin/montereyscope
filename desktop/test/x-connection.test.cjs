"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createXConnection,
  allowedLoginUrl,
  secureStorageAvailable,
} = require("../lib/x-connection.cjs");
const { createXSessionStore } = require("../lib/x-session-store.cjs");
const { startXBroker } = require("../lib/x-broker.cjs");
const { runWorker } = require("../lib/x-worker.cjs");

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail("condition timed out");
}
function fakeSafeStorage(overrides = {}) {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (text) => Buffer.from(`encrypted:${text}`),
    decryptString: (bytes) => bytes.toString().slice(10),
    ...overrides,
  };
}
const DEFAULT_COOKIES = () => [
  { domain: ".x.com", name: "auth_token", value: "synthetic-auth", path: "/" },
  { domain: ".x.com", name: "ct0", value: "synthetic-csrf", path: "/" },
  { domain: "example.com", name: "irrelevant", value: "DO-NOT-FORWARD", path: "/" },
];

function createHarness(t, options = {}) {
  const dataRoot = options.dataRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "scope-x-host-"));
  const ownsRoot = options.dataRoot === undefined;
  let cookies = [];
  const windows = [];
  const calls = [];
  const cookieEvents = new EventEmitter();
  const loginSession = {
    cookies: {
      get: async () => cookies,
      set: async (cookie) => {
        cookies.push(cookie);
        cookieEvents.emit("changed");
      },
      on: (...args) => cookieEvents.on(...args),
      emit: (...args) => cookieEvents.emit(...args),
      removeListener: (...args) => cookieEvents.removeListener(...args),
    },
    clearStorageData: async () => {
      cookies = [];
    },
    clearCache: async () => {},
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
  };
  class Window extends EventEmitter {
    constructor(windowOptions) {
      super();
      this.options = windowOptions;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (handler) => {
        this.handler = handler;
      };
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed === true;
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
    show() {}
    focus() {}
    async loadURL(url) {
      this.url = url;
    }
  }
  const safeStorage = options.safeStorage ?? fakeSafeStorage();
  const worker =
    options.worker ??
    (async () => ({
      connected: true,
      user: { userId: "123", handle: "reader", displayName: "Reader" },
    }));
  const storeContext = { safeStorage, dataRoot };
  const sharedStore = options.store ? options.store(storeContext) : undefined;
  const hosts = [];
  const makeHost = (hostOptions = {}) => {
    const host = createXConnection({
      BrowserWindow: Window,
      session: {
        fromPartition: (name) => {
          assert(!name.startsWith("persist:"));
          return loginSession;
        },
      },
      safeStorage: hostOptions.safeStorage ?? safeStorage,
      dataRoot,
      executable: process.execPath,
      pollMs: 5,
      loginTimeoutMs: options.loginTimeoutMs,
      cookieSaveDebounceMs: options.cookieSaveDebounceMs,
      runWorker: async (...args) => {
        calls.push(args);
        return (hostOptions.worker ?? worker)(...args);
      },
      isServicePresent: hostOptions.isServicePresent,
      store: hostOptions.store ?? sharedStore,
      platform: hostOptions.platform,
    });
    hosts.push(host);
    return host;
  };
  const host = makeHost();
  t.after(async () => {
    for (const created of hosts) await created.close();
    if (ownsRoot) fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    host,
    makeHost,
    windows,
    dataRoot,
    calls,
    file: path.join(dataRoot, "x-session.enc"),
    safeStorage,
    loginSession,
    setCookies: (next = DEFAULT_COOKIES()) => {
      cookies = next;
    },
    savedText: () =>
      storeContext.safeStorage.decryptString(fs.readFileSync(path.join(dataRoot, "x-session.enc"))),
  };
}

test("login navigation and secure storage fail closed", () => {
  assert(allowedLoginUrl("https://x.com/i/flow/login"));
  assert(allowedLoginUrl("https://accounts.google.com/signin"));
  for (const url of [
    "https://x.com.evil.example",
    "http://x.com",
    "file:///etc/passwd",
    "https://x.com:8443",
    "https://evil@x.com",
  ])
    assert(!allowedLoginUrl(url));
  assert(
    !secureStorageAvailable(
      { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text" },
      "linux",
    ),
  );
});

test("login owns one sandboxed window, verifies identity, and saves the session", async (t) => {
  const harness = createHarness(t);
  await harness.host.connect();
  await harness.host.connect();
  assert.equal(harness.windows.length, 1);
  assert.equal(harness.windows[0].options.webPreferences.sandbox, true);
  assert.equal(harness.windows[0].options.webPreferences.preload, undefined);
  harness.setCookies();
  await until(() => harness.host.status().connected);
  assert.equal(harness.host.status().user.handle, "reader");
  await until(() => harness.host.status().storage.state === "saved");
  assert.equal(harness.host.status().storage.reason, null);
  assert.equal(harness.host.status().storage.backend, "gnome_libsecret");
  assert(!JSON.stringify(harness.host.status()).includes("synthetic"));
  assert(!JSON.stringify(harness.calls).includes("DO-NOT-FORWARD"));
  assert(fs.existsSync(harness.file));
  await harness.host.disconnect();
  assert(!fs.existsSync(harness.file));
  assert.equal(harness.host.status().connected, false);
  assert.equal(harness.host.status().storage.state, "not_saved");
  await assert.rejects(harness.host.read("tweet", { tweetId: "123" }), { code: "not_connected" });
});

test("late verification after disconnect cannot reconnect or persist credentials", async (t) => {
  const held = deferred();
  const harness = createHarness(t, { worker: () => held.promise });
  await harness.host.connect();
  harness.setCookies();
  await until(() => harness.calls.length > 0);
  await harness.host.disconnect();
  assert(harness.calls[0][2].signal.aborted);
  held.resolve({
    connected: true,
    user: { userId: "123", handle: "reader", displayName: "Reader" },
  });
  await tick();
  assert.equal(harness.host.status().phase, "disconnected");
  assert(!fs.existsSync(harness.file));
});

test("failed verification retries the existing login without clearing its cookies", async (t) => {
  let attempts = 0;
  const harness = createHarness(t, {
    worker: async () => {
      if (++attempts === 1) throw Object.assign(new Error("network"), { code: "network" });
      return { connected: true, user: { userId: "123", handle: "reader", displayName: "Reader" } };
    },
  });
  await harness.host.connect();
  harness.setCookies();
  await until(() => harness.host.status().phase === "error");
  assert(!harness.windows[0].isDestroyed());
  await harness.host.connect();
  await until(() => harness.host.status().connected);
  assert.equal(harness.windows.length, 1);
  assert.equal(attempts, 2);
});

test("a saved session restores in a new host only after worker verification", async (t) => {
  const harness = createHarness(t);
  await harness.host.connect();
  harness.setCookies();
  await until(() => harness.host.status().storage.state === "saved");
  await harness.host.close();
  assert(fs.existsSync(harness.file));

  const rejecting = harness.makeHost({ worker: async () => ({ connected: false }) });
  await rejecting.restore();
  assert.equal(rejecting.status().connected, false);
  assert.equal(rejecting.status().phase, "expired");
  assert.equal(rejecting.status().errorCode, "session_expired");
  assert(fs.existsSync(harness.file));

  harness.calls.length = 0;
  const accepting = harness.makeHost();
  await accepting.restore();
  assert.equal(accepting.status().connected, true);
  assert.equal(accepting.status().user.handle, "reader");
  assert.equal(accepting.status().storage.state, "saved");
  const verified = harness.calls.find(
    (call) => call[1].operation === "status" && call[1].credentials,
  );
  assert(verified);
  assert.match(verified[1].credentials.cookieHeader, /auth_token=synthetic-auth/);
});

test("a verified connection stays usable when saving fails, and retry saves again", async (t) => {
  let failEncryption = false;
  const harness = createHarness(t, {
    safeStorage: fakeSafeStorage({
      encryptString: (text) => {
        if (failEncryption) throw new Error("keyring unavailable");
        return Buffer.from(`encrypted:${text}`);
      },
    }),
  });
  await harness.host.connect();
  harness.setCookies();
  await until(() => harness.host.status().connected);
  failEncryption = true;
  const workerCallsBefore = harness.calls.length;
  await harness.host.retryStorage();
  assert.equal(harness.host.status().connected, true);
  assert.equal(harness.host.status().storage.state, "save_failed");
  assert.equal(harness.host.status().storage.reason, "encrypt_failed");
  await harness.host.read("tweet", { tweetId: "123" });
  assert.equal(harness.calls.length, workerCallsBefore + 1);
  failEncryption = false;
  await harness.host.retryStorage();
  assert.equal(harness.host.status().storage.state, "saved");
  assert.equal(harness.windows.length, 1);
  assert.equal(harness.calls.length, workerCallsBefore + 1);
  assert(fs.existsSync(harness.file));
});

test("unavailable storage preserves the ciphertext and recovers after retry", async (t) => {
  const harness = createHarness(t);
  await harness.host.connect();
  harness.setCookies();
  await until(() => harness.host.status().storage.state === "saved");
  await harness.host.close();
  const encrypted = fs.readFileSync(harness.file);

  let available = false;
  const blocked = harness.makeHost({
    safeStorage: fakeSafeStorage({
      isEncryptionAvailable: () => available,
      getSelectedStorageBackend: () => (available ? "gnome_libsecret" : "basic_text"),
    }),
  });
  await blocked.restore();
  assert.equal(blocked.status().connected, false);
  assert.equal(blocked.status().storage.state, "unavailable");
  assert.equal(blocked.status().storage.reason, "no_secure_backend");
  assert.deepEqual(fs.readFileSync(harness.file), encrypted);

  available = true;
  await blocked.retryStorage();
  assert.equal(blocked.status().connected, true);
  assert.equal(blocked.status().storage.state, "saved");
  const recovered = JSON.parse(harness.savedText());
  assert.equal(recovered.version, 2);
  assert.deepEqual(
    recovered.cookies.map((cookie) => [cookie.name, cookie.value]),
    [
      ["auth_token", "synthetic-auth"],
      ["ct0", "synthetic-csrf"],
    ],
  );
});

test("disconnect during an in-flight save cannot recreate credentials", async (t) => {
  const gate = deferred();
  const started = deferred();
  const harness = createHarness(t, {
    store: ({ safeStorage, dataRoot }) => {
      const real = createXSessionStore({ safeStorage, dataRoot });
      return {
        initialize: () => real.initialize(),
        refresh: () => real.refresh(),
        load: () => real.load(),
        save: async (cookies) => {
          started.resolve();
          await gate.promise;
          return real.save(cookies);
        },
        clear: () => real.clear(),
        status: () => real.status(),
        hasFile: () => real.hasFile(),
      };
    },
  });
  await harness.host.connect();
  harness.setCookies();
  await until(() => harness.host.status().connected);
  await started.promise;
  const disconnecting = harness.host.disconnect();
  gate.resolve();
  await disconnecting;
  assert.equal(harness.host.status().phase, "disconnected");
  assert.equal(harness.host.status().storage.state, "not_saved");
  assert(!fs.existsSync(harness.file));
});

test("disconnect during restore cannot bring the session back", async (t) => {
  const gate = deferred();
  const started = deferred();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scope-x-restore-"));
  const seed = createHarness(t, { dataRoot });
  await seed.host.connect();
  seed.setCookies();
  await until(() => seed.host.status().storage.state === "saved");

  const harness = createHarness(t, {
    dataRoot,
    store: ({ safeStorage }) => {
      const real = createXSessionStore({ safeStorage, dataRoot });
      return {
        initialize: () => real.initialize(),
        refresh: () => real.refresh(),
        load: async () => {
          started.resolve();
          await gate.promise;
          return real.load();
        },
        save: (cookies) => real.save(cookies),
        clear: () => real.clear(),
        status: () => real.status(),
        hasFile: () => real.hasFile(),
      };
    },
  });
  const restoring = harness.host.restore();
  await started.promise;
  const disconnecting = harness.host.disconnect();
  gate.resolve();
  await restoring;
  await disconnecting;
  assert.equal(harness.host.status().connected, false);
  assert.equal(harness.host.status().phase, "disconnected");
  assert(!fs.existsSync(harness.file));
});

test("cancelling a first sign-in leaves no saved session", async (t) => {
  const harness = createHarness(t);
  await harness.host.connect();
  await harness.host.cancel();
  assert.equal(harness.host.status().phase, "cancelled");
  assert.equal(harness.host.status().storage.state, "not_saved");
  assert(!fs.existsSync(harness.file));
});

test("cancelling re-authentication keeps the previous connection and saved session", async (t) => {
  const harness = createHarness(t);
  await harness.host.connect();
  harness.setCookies();
  await until(() => harness.host.status().storage.state === "saved");
  const encrypted = fs.readFileSync(harness.file);
  // A fresh sign-in partition starts without the previous account's cookies.
  harness.setCookies([]);
  await harness.host.connect();
  assert.equal(harness.windows.length, 2);
  await harness.host.cancel();
  assert.equal(harness.host.status().phase, "connected");
  assert.equal(harness.host.status().user.handle, "reader");
  assert.equal(harness.host.status().storage.state, "saved");
  assert.deepEqual(fs.readFileSync(harness.file), encrypted);
});

test("re-authentication replaces the saved account only after verification", async (t) => {
  let identity = { userId: "123", handle: "reader", displayName: "Reader" };
  const harness = createHarness(t, {
    worker: async () => ({ connected: true, user: identity }),
  });
  await harness.host.connect();
  harness.setCookies();
  await until(() => harness.host.status().storage.state === "saved");
  const before = fs.readFileSync(harness.file);

  identity = { userId: "456", handle: "writer", displayName: "Writer" };
  harness.setCookies([
    { domain: ".x.com", name: "auth_token", value: "replacement-auth", path: "/" },
    { domain: ".x.com", name: "ct0", value: "replacement-csrf", path: "/" },
  ]);
  await harness.host.connect();
  await until(() => harness.host.status().user?.handle === "writer");
  await until(() => harness.host.status().storage.state === "saved");
  assert.notDeepEqual(fs.readFileSync(harness.file), before);
  assert.match(harness.savedText(), /replacement-auth/);
  assert.doesNotMatch(harness.savedText(), /synthetic-auth/);
});

test("session-cookie updates while connected are saved after a debounce", async (t) => {
  const harness = createHarness(t, { cookieSaveDebounceMs: 25 });
  await harness.host.connect();
  harness.setCookies();
  await until(() => harness.host.status().storage.state === "saved");
  assert.doesNotMatch(harness.savedText(), /twid/);
  await harness.loginSession.cookies.set({
    domain: ".x.com",
    name: "twid",
    value: "u=123456789",
    path: "/",
  });
  await until(() => harness.savedText().includes("twid"));
  assert.match(harness.savedText(), /u=123456789/);
});

test("broker accepts retry-storage but rejects foreign origins, tokens, and credential injection", async (t) => {
  let reads = 0;
  let retries = 0;
  const broker = await startXBroker({
    status: () => ({ connected: false }),
    retryStorage: async () => {
      retries++;
      return {
        connected: false,
        storage: { state: "not_saved", reason: "missing_file", backend: null },
      };
    },
    read: async () => {
      reads++;
    },
  });
  t.after(() => broker.close());
  for (const headers of [{}, { "x-scope-x-broker": broker.token, Origin: "http://evil.example" }]) {
    const result = await fetch(broker.origin, { method: "POST", headers, body: "{}" });
    assert.equal(result.status, 404);
  }
  for (const request of [
    { operation: "post" },
    { operation: "tweet", params: { tweetId: "123" }, credentials: {} },
  ]) {
    const result = await fetch(broker.origin, {
      method: "POST",
      headers: { "x-scope-x-broker": broker.token },
      body: JSON.stringify({ protocol: 1, ...request }),
    });
    assert.equal((await result.json()).ok, false);
  }
  const retry = await fetch(broker.origin, {
    method: "POST",
    headers: { "x-scope-x-broker": broker.token },
    body: JSON.stringify({ protocol: 1, operation: "retry-storage" }),
  });
  const retryBody = await retry.json();
  assert.equal(retryBody.ok, true);
  assert.equal(retries, 1);
  assert.equal(reads, 0);
});

test("desktop worker runner refuses write operations before spawning", async () => {
  await assert.rejects(runWorker(process.execPath, { operation: "post" }), {
    code: "invalid_response",
  });
});

test("successful login outlives the login deadline", async (t) => {
  const h = createHarness(t, { loginTimeoutMs: 1_000 });
  await h.host.connect();
  h.setCookies();
  await until(() => h.host.status().connected);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(h.host.status().phase, "connected");
  await h.host.read("tweet", { tweetId: "123" });
});

test("rotated credentials are used for reads even when persistence fails", async (t) => {
  let failSave = false;
  const h = createHarness(t, {
    cookieSaveDebounceMs: 5,
    safeStorage: fakeSafeStorage({
      encryptString: (text) => {
        if (failSave) throw new Error("synthetic failure");
        return Buffer.from(`encrypted:${text}`);
      },
    }),
  });
  await h.host.connect();
  h.setCookies();
  await until(() => h.host.status().storage.state === "saved");
  failSave = true;
  h.setCookies(
    DEFAULT_COOKIES().map((cookie) =>
      cookie.name === "auth_token" ? { ...cookie, value: "rotated-auth" } : cookie,
    ),
  );
  h.loginSession.cookies.emit("changed");
  await until(() => h.host.status().storage.state === "save_failed");
  await h.host.read("tweet", { tweetId: "123" });
  assert.match(h.calls.at(-1)[1].credentials.cookieHeader, /auth_token=rotated-auth/);
  assert.doesNotMatch(h.calls.at(-1)[1].credentials.cookieHeader, /synthetic-auth/);
});

test("failed removal disconnects memory, reports failure, and can retry deletion", async (t) => {
  let failDelete = true;
  const injectedFs = Object.create(fs);
  injectedFs.rmSync = (...args) => {
    if (failDelete && String(args[0]).endsWith("x-session.enc"))
      throw new Error("synthetic denial");
    return fs.rmSync(...args);
  };
  const h = createHarness(t, {
    store: ({ safeStorage, dataRoot }) =>
      createXSessionStore({ safeStorage, dataRoot, fs: injectedFs }),
  });
  await h.host.connect();
  h.setCookies();
  await until(() => h.host.status().storage.state === "saved");
  await assert.rejects(h.host.disconnect(), { code: "invalid_response" });
  assert.equal(h.host.status().connected, false);
  assert.equal(h.host.status().storage.state, "delete_failed");
  assert(fs.existsSync(h.file));
  await h.host.restore();
  assert.equal(h.host.status().connected, false);
  await assert.rejects(h.host.read("tweet", { tweetId: "123" }));
  failDelete = false;
  await h.host.retryStorage();
  assert.equal(h.host.status().storage.state, "not_saved");
  assert(!fs.existsSync(h.file));
});

test("offline startup retries the saved session without another login window", async (t) => {
  const h = createHarness(t);
  await h.host.connect();
  h.setCookies();
  await until(() => h.host.status().storage.state === "saved");
  await h.host.close();
  let offline = true;
  const restored = h.makeHost({
    worker: async () => {
      if (offline) throw Object.assign(new Error("network"), { code: "network" });
      return { connected: true, user: { userId: "123", handle: "reader", displayName: "Reader" } };
    },
  });
  await restored.restore();
  assert.equal(restored.status().phase, "error");
  assert.equal(restored.status().storage.state, "saved");
  offline = false;
  await restored.retryStorage();
  assert.equal(restored.status().connected, true);
  assert.equal(h.windows.length, 1);
});
