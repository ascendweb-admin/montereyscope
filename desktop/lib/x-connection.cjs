"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { failure } = require("./x-worker.cjs");
const {
  createXSessionStore,
  isXDomain,
  normalizeCookies,
  secureStorageAvailable,
} = require("./x-session-store.cjs");

function allowedLoginUrl(raw) {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["x.com", "twitter.com", "accounts.google.com", "appleid.apple.com"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
function validIdentity(user) {
  return (
    user &&
    /^\d{1,20}$/.test(user.userId) &&
    /^[A-Za-z0-9_]{1,15}$/.test(user.handle) &&
    typeof user.displayName === "string"
  );
}
function headerFrom(cookies) {
  const byName = new Map(cookies.map((cookie) => [cookie.name, cookie.value]));
  if (!byName.has("auth_token") || !byName.has("ct0")) return null;
  const header = [...byName].map(([name, value]) => `${name}=${value}`).join("; ");
  if (header.length > 32768 || /[\r\n]/.test(header)) throw failure("invalid_response");
  return header;
}
function setDetails(cookie) {
  return {
    url: `https://${cookie.domain.replace(/^\./, "")}${cookie.path || "/"}`,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: true,
    httpOnly: cookie.httpOnly === true,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}),
  };
}

/** Credentials live here, never in Next, renderer state, or a persistent Chromium partition. */
function createXConnection({
  BrowserWindow,
  session,
  safeStorage,
  dataRoot,
  executable,
  runWorker,
  pollMs = 1500,
  loginTimeoutMs = 600_000,
  cookieSaveDebounceMs = 2_000,
  store = null,
  isServicePresent = () => false,
  platform = process.platform,
}) {
  const sessionStore =
    store ??
    createXSessionStore({
      safeStorage,
      dataRoot,
      platform,
      isServicePresent,
    });
  sessionStore.initialize();
  const available = Boolean(executable && fs.existsSync(executable));

  let generation = 0,
    phase = "disconnected",
    identity = null,
    errorCode = null;
  let cookieHeader = null,
    sessionCookies = null,
    restoreInProgress = false;
  let loginWindow = null,
    loginSession = null,
    activeSession = newIsolatedSession(),
    attemptContext = null;
  let pollTimer = null,
    deadlineTimer = null,
    debounceTimer = null;
  let queue = Promise.resolve(),
    storageQueue = Promise.resolve(),
    retryAt = 0,
    closed = false,
    clearing = Promise.resolve();
  const active = new Set();
  const watchers = new Map();

  function newIsolatedSession() {
    const created = session.fromPartition(`scope-x-${crypto.randomUUID()}`, { cache: false });
    created.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    created.setPermissionCheckHandler(() => false);
    return created;
  }
  function status() {
    const storage = sessionStore.status();
    return {
      connected: phase === "connected",
      canConnect: available,
      phase,
      attemptId: String(generation),
      user: phase === "connected" ? identity : null,
      errorCode,
      restoring: restoreInProgress,
      sessionOnly: storage.state === "unavailable",
      storage: { state: storage.state, reason: storage.reason, backend: storage.backend },
    };
  }
  function closeWindow() {
    const window = loginWindow;
    loginWindow = null;
    if (window && !window.isDestroyed()) window.destroy();
  }
  function disposeSession(target) {
    if (!target) return Promise.resolve();
    const jobs = [];
    if (typeof target.clearStorageData === "function") {
      jobs.push(Promise.resolve().then(() => target.clearStorageData()));
    }
    if (typeof target.clearCache === "function") {
      jobs.push(Promise.resolve().then(() => target.clearCache()));
    }
    return Promise.allSettled(jobs);
  }
  function watchSession(target) {
    if (!target || watchers.has(target)) return;
    const cookies = target.cookies;
    if (!cookies || typeof cookies.on !== "function") return;
    const handler = () => scheduleCookieSave();
    watchers.set(target, handler);
    cookies.on("changed", handler);
  }
  function unwatchSession(target) {
    const handler = watchers.get(target);
    if (!handler) return;
    watchers.delete(target);
    try {
      target.cookies?.removeListener?.("changed", handler);
    } catch {
      /* the session may already be gone */
    }
  }
  function invalidate() {
    generation++;
    for (const controller of active) controller.abort();
    active.clear();
    clearTimeout(pollTimer);
    clearTimeout(deadlineTimer);
    clearTimeout(debounceTimer);
    pollTimer = null;
    deadlineTimer = null;
    debounceTimer = null;
    closeWindow();
  }
  function enqueueStorage(operation) {
    const task = storageQueue.catch(() => {}).then(operation);
    storageQueue = task.catch(() => {});
    return task;
  }
  function scheduleCookieSave() {
    if (closed || phase !== "connected") return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const attempt = generation;
      void collectCookies(activeSession)
        .then((cookies) => {
          if (attempt !== generation || closed || phase !== "connected" || cookies.length === 0)
            return;
          const normalized = normalizeCookies(cookies);
          if (!normalized.ok) return;
          const header = headerFrom(normalized.cookies);
          if (!header) {
            cookieHeader = null;
            identity = null;
            phase = "expired";
            errorCode = "session_expired";
            return;
          }
          cookieHeader = header;
          sessionCookies = normalized.cookies;
          void saveSession(attempt, normalized.cookies);
        })
        .catch(() => {});
    }, cookieSaveDebounceMs);
    debounceTimer.unref?.();
  }
  async function collectCookies(target) {
    if (!target) return [];
    const cookies = await target.cookies.get({});
    return cookies.filter((cookie) => isXDomain(cookie.domain));
  }
  function saveSession(attempt, cookies) {
    return enqueueStorage(async () => {
      if (closed || attempt !== generation) return { ok: false, reason: "cancelled" };
      if (!Array.isArray(cookies) || cookies.length === 0) {
        return { ok: false, reason: "invalid_payload" };
      }
      return sessionStore.save(cookies);
    });
  }
  async function installCookies(target, cookies, attempt) {
    for (const cookie of cookies) {
      if (attempt !== generation || closed) return;
      if (cookie.expirationDate && cookie.expirationDate <= Date.now() / 1000) continue;
      await target.cookies.set(setDetails(cookie));
    }
  }
  function installConnection(attempt, target, data) {
    if (attempt !== generation || closed) return false;
    clearTimeout(deadlineTimer);
    clearTimeout(pollTimer);
    deadlineTimer = null;
    pollTimer = null;
    const previousSession = activeSession;
    cookieHeader = data.header;
    identity = data.user;
    sessionCookies = data.cookies;
    errorCode = null;
    restoreInProgress = false;
    phase = "connected";
    attemptContext = null;
    loginSession = null;
    closeWindow();
    activeSession = target;
    watchSession(target);
    if (previousSession && previousSession !== target) {
      unwatchSession(previousSession);
      void disposeSession(previousSession);
    }
    void saveSession(attempt, data.cookies);
    return true;
  }
  function exclusive(operation, params, credentials, expectedGeneration = generation) {
    const task = queue
      .catch(() => {})
      .then(async () => {
        if (closed || expectedGeneration !== generation) throw failure("cancelled");
        if (Date.now() < retryAt) {
          const error = failure("rate_limited");
          error.retryAfterSeconds = Math.ceil((retryAt - Date.now()) / 1000);
          throw error;
        }
        const controller = new AbortController();
        active.add(controller);
        try {
          const result = await runWorker(
            executable,
            { operation, params, credentials },
            {
              cwd: path.join(dataRoot, "x-worker"),
              signal: controller.signal,
            },
          );
          if (expectedGeneration !== generation || closed) throw failure("cancelled");
          return result;
        } catch (error) {
          if (expectedGeneration === generation) {
            if (error.code === "rate_limited")
              retryAt = Date.now() + 1000 * (error.retryAfterSeconds ?? 60);
            if (
              ["session_expired", "verification_required"].includes(error.code) &&
              phase === "connected"
            ) {
              phase = "expired";
              identity = null;
              errorCode = error.code;
            }
          }
          throw error;
        } finally {
          active.delete(controller);
        }
      });
    queue = task;
    return task;
  }
  async function verify(attempt, target) {
    if (attempt !== generation || closed) return false;
    const cookies = await collectCookies(target);
    if (attempt !== generation || closed) return false;
    const header = headerFrom(cookies);
    if (header === null) return false;
    phase = "verifying";
    const result = await exclusive("status", {}, { cookieHeader: header }, attempt);
    if (attempt !== generation || closed) return false;
    if (result?.connected !== true) throw failure("session_expired");
    if (!validIdentity(result.user)) throw failure("invalid_response");
    const normalized = normalizeCookies(cookies);
    installConnection(attempt, target, {
      header,
      user: result.user,
      cookies: normalized.ok ? normalized.cookies : [],
    });
    return true;
  }
  async function verifyLoadedSession(attempt) {
    try {
      const connected = await verify(attempt, activeSession);
      if (attempt !== generation || closed) return;
      if (!connected && phase !== "connected") {
        phase = "expired";
        errorCode = "session_expired";
        cookieHeader = null;
        identity = null;
      }
    } catch (error) {
      if (attempt !== generation || closed) return;
      const code = error.code || "network";
      if (code === "session_expired" || code === "verification_required") {
        phase = "expired";
        errorCode = code;
        cookieHeader = null;
        identity = null;
      } else {
        phase = "error";
        errorCode = code;
      }
    } finally {
      if (attempt === generation) restoreInProgress = false;
    }
  }
  async function poll(attempt, target) {
    if (attempt !== generation || closed || phase === "connected" || phase === "error") return;
    try {
      const connected = await verify(attempt, target);
      if (connected || attempt !== generation || closed) return;
    } catch (error) {
      if (attempt !== generation || closed) return;
      const code = error.code || "network";
      errorCode = code;
      if (["not_connected", "session_expired"].includes(code)) {
        phase = "awaiting_login";
      } else {
        phase = "error";
        return;
      }
    }
    if (attempt === generation && phase !== "connected" && phase !== "error" && !closed) {
      phase = "awaiting_login";
      pollTimer = setTimeout(() => void poll(attempt, target), pollMs);
      pollTimer.unref?.();
    }
  }
  async function finishAttempt(code) {
    const context = attemptContext;
    attemptContext = null;
    invalidate();
    restoreInProgress = false;
    const target = loginSession;
    loginSession = null;
    if (target) {
      unwatchSession(target);
      clearing = clearing.then(() => disposeSession(target));
    }
    const previous = context?.previous ?? null;
    if (previous && previous.identity && previous.cookieHeader) {
      activeSession = previous.session;
      cookieHeader = previous.cookieHeader;
      identity = previous.identity;
      sessionCookies = previous.sessionCookies;
      errorCode = null;
      phase = "connected";
      watchSession(activeSession);
    } else {
      cookieHeader = null;
      identity = null;
      sessionCookies = null;
      phase = code === "cancelled" ? "cancelled" : "error";
      errorCode = code;
    }
    return status();
  }
  async function connect() {
    if (!available) throw failure("unsupported_runtime");
    await clearing;
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.show();
      loginWindow.focus();
      if (phase === "error" && attemptContext) {
        errorCode = null;
        phase = "verifying";
        void poll(attemptContext.attempt, attemptContext.target);
      }
      return status();
    }
    const previous =
      phase === "connected" && identity && cookieHeader
        ? { identity, cookieHeader, sessionCookies, session: activeSession }
        : null;
    invalidate();
    const attempt = generation;
    identity = previous ? previous.identity : null;
    cookieHeader = previous ? previous.cookieHeader : null;
    sessionCookies = previous ? previous.sessionCookies : null;
    errorCode = null;
    restoreInProgress = false;
    phase = "opening";
    const target = newIsolatedSession();
    loginSession = target;
    attemptContext = { attempt, target, previous };
    const window = new BrowserWindow({
      width: 1000,
      height: 800,
      title: "Sign in to X — x.com",
      autoHideMenuBar: true,
      webPreferences: {
        session: target,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: false,
      },
    });
    loginWindow = window;
    const guard = (event, url) => {
      if (!allowedLoginUrl(url)) event.preventDefault();
    };
    window.webContents.on("will-navigate", guard);
    window.webContents.on("will-redirect", guard);
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (allowedLoginUrl(url)) void window.loadURL(url).catch(() => {});
      return { action: "deny" };
    });
    window.webContents.on("page-title-updated", (event) => {
      event.preventDefault();
      try {
        window.setTitle(`Sign in to X — ${new URL(window.webContents.getURL()).hostname}`);
      } catch {
        /* blank page */
      }
    });
    window.on("closed", () => {
      if (loginWindow === window) void finishAttempt("cancelled");
    });
    deadlineTimer = setTimeout(() => {
      if (attempt === generation) void finishAttempt("timeout");
    }, loginTimeoutMs);
    deadlineTimer.unref?.();
    phase = "awaiting_login";
    void window.loadURL("https://x.com/i/flow/login").catch(() => {
      if (attempt === generation) void finishAttempt("network");
    });
    void poll(attempt, target);
    return status();
  }
  async function cancel(code = "cancelled") {
    if (!attemptContext) return status();
    return finishAttempt(code);
  }
  async function disconnect() {
    attemptContext = null;
    invalidate();
    restoreInProgress = false;
    cookieHeader = null;
    identity = null;
    sessionCookies = null;
    errorCode = null;
    phase = "disconnected";
    const stale = [activeSession, loginSession].filter(Boolean);
    activeSession = null;
    loginSession = null;
    let removed = false;
    clearing = (async () => {
      await enqueueStorage(async () => {
        const result = sessionStore.clear();
        removed = result.ok !== false;
      });
      for (const target of stale) {
        unwatchSession(target);
        await disposeSession(target);
      }
      activeSession = newIsolatedSession();
    })();
    await clearing;
    if (!removed) throw failure("invalid_response");
    return status();
  }
  async function restore() {
    if (!available || closed || phase === "connected" || loginWindow) return status();
    if (sessionStore.status().state === "delete_failed") return status();
    const attempt = generation;
    restoreInProgress = true;
    try {
      sessionStore.refresh();
      const loaded = sessionStore.load();
      if (attempt !== generation || closed) return status();
      if (!loaded.ok) return status();
      sessionCookies = loaded.cookies;
      phase = "verifying";
      await installCookies(activeSession, loaded.cookies, attempt);
      if (attempt !== generation || closed) return status();
      await verifyLoadedSession(attempt);
    } catch (error) {
      if (attempt === generation) {
        phase = "error";
        errorCode = error.code || "invalid_response";
      }
    } finally {
      if (attempt === generation) restoreInProgress = false;
    }
    return status();
  }
  async function retryStorage() {
    if (closed) return status();
    if (sessionStore.status().state === "delete_failed") return disconnect();
    const attempt = generation;
    sessionStore.refresh();
    if (phase === "connected" && sessionCookies && sessionCookies.length > 0) {
      await saveSession(attempt, sessionCookies);
      return status();
    }
    if (loginWindow && !loginWindow.isDestroyed()) return status();
    if (sessionCookies && sessionCookies.length > 0 && phase !== "connected") {
      restoreInProgress = true;
      phase = "verifying";
      try {
        await installCookies(activeSession, sessionCookies, attempt);
        if (attempt !== generation || closed) return status();
        await verifyLoadedSession(attempt);
      } finally {
        if (attempt === generation) restoreInProgress = false;
      }
      return status();
    }
    if (sessionStore.hasFile() && sessionStore.status().state !== "unavailable") {
      return restore();
    }
    return status();
  }
  return {
    status,
    connect,
    cancel,
    disconnect,
    restore,
    retryStorage,
    focus() {
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.show();
        loginWindow.focus();
      }
      return status();
    },
    async read(operation, params) {
      if (!new Set(["user", "user_posts", "tweet"]).has(operation))
        throw failure("invalid_response");
      if (phase !== "connected" || !cookieHeader) throw failure(errorCode || "not_connected");
      return exclusive(operation, params, { cookieHeader });
    },
    async close() {
      if (closed) return;
      if (phase === "connected" && sessionCookies && sessionCookies.length > 0) {
        await saveSession(generation, sessionCookies);
      }
      closed = true;
      const stale = [activeSession, loginSession].filter(Boolean);
      activeSession = null;
      loginSession = null;
      invalidate();
      for (const target of stale) {
        unwatchSession(target);
        await disposeSession(target);
      }
    },
  };
}
module.exports = {
  createXConnection,
  allowedLoginUrl,
  isXDomain,
  secureStorageAvailable,
  validIdentity,
};
