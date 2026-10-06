"use strict";

const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { promisify } = require("node:util");

const {
  app,
  BrowserWindow,
  dialog,
  Menu,
  ipcMain,
  safeStorage,
  nativeTheme,
  clipboard,
  session,
  shell,
  utilityProcess,
} = require("electron");

const {
  installMenuEntry,
  integrationStatus,
  removeMenuEntry,
} = require("./lib/linux-integration.cjs");

const {
  DESKTOP_AUTH_HEADER,
  LOOPBACK_HOST,
  allocateLoopbackPort,
  backendEnvironment,
  desktopUserDataPath,
  isInternalUrl,
  isSafeExternalUrl,
  requestHealth,
  waitForBackend,
} = require("./lib/runtime.cjs");

const execFileAsync = promisify(execFile);

const { createXConnection } = require("./lib/x-connection.cjs");
const { startXBroker } = require("./lib/x-broker.cjs");
const { runWorker } = require("./lib/x-worker.cjs");
const { revealMainWindow, startupWindowAvailable } = require("./lib/window-lifecycle.cjs");
const {
  applyStorageBackendPreference,
  collectStorageDiagnostic,
  readStorageConfig,
  secretServiceAvailable,
  STORAGE_CONFIG_FILENAME,
} = require("./lib/x-storage-policy.cjs");
let xConnection = null;
let xBroker = null;

const APP_ID = "com.scope.desktop";
const isSmokeRun = process.env.SCOPE_DESKTOP_SMOKE === "1";
/**
 * The AppImage runtime exports APPIMAGE with the path of the downloaded file
 * (not the temporary mount). Smoke runs of an extracted AppImage have no
 * runtime environment, so the harness may pass its path explicitly through a
 * smoke-only variable.
 */
const runningAppImage =
  process.platform === "linux"
    ? process.env.APPIMAGE?.trim() ||
      (isSmokeRun ? process.env.SCOPE_DESKTOP_SMOKE_APPIMAGE_UNDER_TEST?.trim() : "") ||
      null
    : null;
const loadingUrl = pathToFileURL(path.join(__dirname, "loading.html")).href;
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.png")
  : path.join(__dirname, "assets", "icon.png");

const userDataRoot = desktopUserDataPath({ packaged: app.isPackaged });
fs.mkdirSync(userDataRoot, { recursive: true });
app.setPath("userData", userDataRoot);
const sessionDataRoot = path.join(userDataRoot, "chromium");
fs.mkdirSync(sessionDataRoot, { recursive: true });
app.setPath("sessionData", sessionDataRoot);
app.setName("scope");
if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}

const logDirectory = path.join(userDataRoot, "logs");
const logFile = path.join(logDirectory, "desktop.log");
let mainWindow = null;
let mainWindowCreated = false;
let backend = null;
let backendReady = false;
let appOrigin = null;
let shuttingDown = false;
let shutdownComplete = false;
let fatalErrorShown = false;

function rotateLog() {
  fs.mkdirSync(logDirectory, { recursive: true });
  try {
    if (fs.statSync(logFile).size > 1_048_576) {
      fs.renameSync(logFile, `${logFile}.old`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("Could not rotate the desktop log:", error);
    }
  }
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    fs.appendFileSync(logFile, `${line}\n`, "utf8");
  } catch (error) {
    console.error("Could not write the desktop log:", error);
  }
  if (!app.isPackaged || isSmokeRun || process.env.SCOPE_DESKTOP_LOG_STDERR === "1") {
    console.error(line);
  }
}

function logStream(prefix, stream) {
  if (!stream) {
    return;
  }
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) {
        log(`${prefix} ${line}`);
      }
    }
  });
  stream.on("end", () => {
    if (pending.trim()) {
      log(`${prefix} ${pending}`);
    }
  });
}

function readWindowState() {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(userDataRoot, "window-state.json"), "utf8"),
    );
    const width = Number(parsed.width);
    const height = Number(parsed.height);
    if (width >= 900 && width <= 5_000 && height >= 640 && height <= 5_000) {
      return { width, height, maximized: parsed.maximized === true };
    }
  } catch {
    // A missing or stale preference is harmless; use the comfortable default.
  }
  return { width: 1_360, height: 860, maximized: false };
}

function saveWindowState(window) {
  if (window.isDestroyed()) {
    return;
  }
  const maximized = window.isMaximized();
  const bounds = maximized ? window.getNormalBounds() : window.getBounds();
  try {
    fs.writeFileSync(
      path.join(userDataRoot, "window-state.json"),
      `${JSON.stringify({ width: bounds.width, height: bounds.height, maximized })}\n`,
      "utf8",
    );
  } catch (error) {
    log(`Could not save the window state: ${error instanceof Error ? error.message : error}`);
  }
}

function secureWebPreferences() {
  return {
    preload: path.join(__dirname, "preload.cjs"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    devTools: !app.isPackaged,
    spellcheck: true,
  };
}

function openExternal(candidate) {
  if (isSafeExternalUrl(candidate)) {
    void shell.openExternal(candidate).catch((error) => {
      log(`Could not open external URL: ${error instanceof Error ? error.message : error}`);
    });
  }
}

function attachNavigationGuards(window, { allowLoadingPage = false } = {}) {
  const { webContents } = window;
  webContents.on("will-attach-webview", (event) => event.preventDefault());
  webContents.on("will-navigate", (event, targetUrl) => {
    const allowedLoadingPage = allowLoadingPage && targetUrl === loadingUrl;
    if (!allowedLoadingPage && (!appOrigin || !isInternalUrl(targetUrl, appOrigin))) {
      event.preventDefault();
      openExternal(targetUrl);
    }
  });
  webContents.setWindowOpenHandler(({ url }) => {
    if (appOrigin && isInternalUrl(url, appOrigin)) {
      setImmediate(() => createSecondaryWindow(url));
    } else {
      openExternal(url);
    }
    return { action: "deny" };
  });
}

/**
 * Linux and Windows intentionally have no application menu: Scope is a
 * single-window app whose actions live in its own UI. macOS expects the
 * standard application menu, so About/Quit, the Edit roles (so Cmd+C/V/X
 * work in text fields), and the Window roles are installed there.
 */
function configureApplicationMenu() {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  app.setAboutPanelOptions({
    applicationName: "Scope",
    applicationVersion: app.getVersion(),
    copyright: "Private, local-first transcript and research dashboard",
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "pasteAndMatchStyle" },
          { role: "delete" },
          { role: "selectAll" },
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "close" },
          { role: "minimize" },
          { role: "zoom" },
          { type: "separator" },
          { role: "front" },
        ],
      },
    ]),
  );
}

function createSecondaryWindow(url) {
  const window = new BrowserWindow({
    width: 1_100,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: "scope",
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#151512" : "#f7f5f0",
    icon: appIconPath,
    webPreferences: secureWebPreferences(),
  });
  attachNavigationGuards(window);
  window.once("ready-to-show", () => window.show());
  void window.loadURL(url).catch((error) => {
    log(`Could not open the internal window: ${error instanceof Error ? error.message : error}`);
    window.destroy();
  });
}

function createMainWindow({ revealWhenReady = true, url = null } = {}) {
  const state = readWindowState();
  const window = new BrowserWindow({
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: "scope",
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#151512" : "#f7f5f0",
    icon: appIconPath,
    webPreferences: secureWebPreferences(),
  });
  attachNavigationGuards(window, { allowLoadingPage: true });
  window.once("ready-to-show", () => {
    if (state.maximized) {
      window.maximize();
    }
    if (revealWhenReady) {
      window.show();
    }
  });
  window.on("close", () => saveWindowState(window));
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  if (url === null) {
    void window.loadFile(path.join(__dirname, "loading.html"));
  } else {
    // Reopening after the macOS window was closed: the backend is already
    // running, so load the application directly instead of the loading page.
    void window.loadURL(url).catch((error) => {
      log(
        `Could not reopen the application window: ${error instanceof Error ? error.message : error}`,
      );
    });
  }
  mainWindow = window;
  mainWindowCreated = true;
  return window;
}

/**
 * Dock activation (macOS) or a second launch: reveal the existing window or
 * recreate it when the user closed it while the app stayed running. Before
 * bootstrap has created its window (activate can fire at first launch on
 * macOS), bootstrap itself is about to create one, so do nothing.
 */
function showMainWindow() {
  if (shuttingDown || shutdownComplete) return;
  revealMainWindow({
    window: mainWindow,
    canCreate: mainWindowCreated,
    backendReady,
    origin: appOrigin,
    createWindow: createMainWindow,
  });
}

function configureRendererSession(origin, token) {
  const rendererSession = session.defaultSession;
  rendererSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        [DESKTOP_AUTH_HEADER]: token,
      },
    });
  });

  const canUsePermission = (permission, requestingOrigin) =>
    permission === "clipboard-sanitized-write" &&
    typeof requestingOrigin === "string" &&
    isInternalUrl(requestingOrigin, origin);

  rendererSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(canUsePermission(permission, webContents.getURL()));
  });
  rendererSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    canUsePermission(permission, requestingOrigin),
  );
}

function packagedYtDlpPath() {
  const executable = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, "bin", executable)
    : path.join(__dirname, "vendor", executable);
  return fs.existsSync(candidate) ? candidate : undefined;
}

function packagedServerRoot() {
  const serverRoot = path.join(process.resourcesPath, "app-server");
  if (!fs.existsSync(path.join(serverRoot, "server.js"))) {
    throw new Error(`The packaged Next.js server is missing at ${serverRoot}.`);
  }
  return serverRoot;
}

/**
 * Smoke-only SQLite check: writes a marker row through the packaged
 * better-sqlite3 binary and reports whether rows from a previous run were
 * still there. A second smoke run with the same profile proves the database
 * reopens with its data intact.
 */
function exerciseSmokeDatabase() {
  const Database = require(path.join(packagedServerRoot(), "node_modules", "better-sqlite3"));
  const databasePath =
    process.env.SCOPE_DB_PATH?.trim() || path.join(userDataRoot, "data", "localtube.db");
  const database = new Database(databasePath);
  try {
    database.pragma("busy_timeout = 5000");
    const previousTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'smoke_runs'")
      .get();
    const reopened =
      previousTable !== undefined &&
      database.prepare("SELECT COUNT(*) AS count FROM smoke_runs").get().count > 0;
    database.exec(
      "CREATE TABLE IF NOT EXISTS smoke_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL)",
    );
    database
      .prepare("INSERT INTO smoke_runs (created_at) VALUES (?)")
      .run(new Date().toISOString());
    return reopened;
  } finally {
    database.close();
  }
}

async function checkBundledYtDlp() {
  const executable = packagedYtDlpPath();
  if (!executable) {
    throw new Error("The bundled yt-dlp executable is missing.");
  }
  const { stdout } = await execFileAsync(executable, ["--version"], {
    timeout: 20_000,
    windowsHide: true,
  });
  const version = stdout.trim();
  if (!version) {
    throw new Error("The bundled yt-dlp did not report a version.");
  }
  log(`Bundled yt-dlp version: ${version}`);
}

/**
 * Exercises model listing through the packaged Claude SDK using an offline
 * protocol fixture and Electron's bundled Node runtime. No installed provider,
 * credentials, or billable request is involved.
 */
async function checkClaudeAgentSdk() {
  const entry = path.join(
    packagedServerRoot(),
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "sdk.mjs",
  );
  if (!fs.existsSync(entry)) {
    throw new Error(`The Claude Agent SDK is missing from the packaged runtime: ${entry}`);
  }
  const sdk = await import(pathToFileURL(entry).href);
  if (typeof sdk.query !== "function") {
    throw new Error("The Claude Agent SDK did not expose query() in the packaged runtime.");
  }
  const fixture = path.join(userDataRoot, "smoke-claude.js");
  fs.writeFileSync(
    fixture,
    String.raw`
    const readline = require("node:readline");
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.type !== "control_request" || message.request.subtype !== "initialize") {
        throw new Error("Smoke model listing must not send a user turn");
      }
      process.stdout.write(JSON.stringify({ type: "control_response", response: {
        subtype: "success", request_id: message.request_id,
        response: { models: [{ value: "scope-smoke-model", displayName: "Smoke model", description: "Offline" }], commands: [], agents: [] }
      } }) + "\n");
    });
  `,
  );
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  let query;
  try {
    query = sdk.query({
      prompt: (async function* () {
        await new Promise((resolve) =>
          abort.signal.addEventListener("abort", resolve, { once: true }),
        );
      })(),
      options: {
        pathToClaudeCodeExecutable: fixture,
        executable: process.execPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        settingSources: [],
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        permissionMode: "dontAsk",
        persistSession: false,
        maxTurns: 1,
        abortController: abort,
      },
    });
    const models = await query.supportedModels();
    if (models.length !== 1 || models[0].value !== "scope-smoke-model") {
      throw new Error("The packaged Claude SDK did not return the offline model catalog.");
    }
    log("Claude Agent SDK model listing passed from the packaged runtime (offline).");
  } finally {
    clearTimeout(timer);
    abort.abort();
    query?.close();
  }
}

async function runSmokeChecks({ origin, token, workerPath }) {
  const workerRuntime = await runWorker(
    workerPath,
    { operation: "runtime" },
    {
      cwd: path.join(userDataRoot, "x-worker"),
    },
  );
  if (!workerRuntime?.commit) {
    throw new Error("The packaged X worker did not load.");
  }

  if (!(await requestHealth(origin, token))) {
    throw new Error("The packaged backend did not report healthy with its desktop token.");
  }

  const unauthenticatedResponse = await fetch(`${origin}/api/health`, {
    cache: "no-store",
    redirect: "manual",
  });
  if (unauthenticatedResponse.status !== 404) {
    throw new Error("The packaged backend accepted a request without its desktop token.");
  }

  await checkBundledYtDlp();
  await checkClaudeAgentSdk();
  return exerciseSmokeDatabase();
}

function attachBackendLifecycle(state) {
  logStream("[backend]", state.process.stdout);
  logStream("[backend:error]", state.process.stderr);

  state.process.once("error", (error) => {
    state.alive = false;
    log(`Backend process error: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
  });
  state.process.once("exit", (code) => {
    state.alive = false;
    log(`Backend exited with code ${code}.`);
    if (backendReady && !shuttingDown) {
      void showFatalError(new Error("The local Scope backend stopped unexpectedly."));
    }
  });
  return state;
}

function startBackend(port, token) {
  const dataRoot = path.join(userDataRoot, "data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const env = backendEnvironment({
    dataRoot,
    token,
    port,
    bundledYtDlpPath: packagedYtDlpPath(),
    development: !app.isPackaged,
  });

  if (xBroker) {
    env.SCOPE_X_BROKER_ORIGIN = xBroker.origin;
    env.SCOPE_X_BROKER_TOKEN = xBroker.token;
  }
  delete env.SCOPE_X_FAKE_PROVIDER;
  delete env.SCOPE_X_WORKER;
  delete env.LOCAL_SCOPE_X_WORKER;

  if (app.isPackaged) {
    const serverRoot = path.join(process.resourcesPath, "app-server");
    const serverEntry = path.join(serverRoot, "server.js");
    if (!fs.existsSync(serverEntry)) {
      throw new Error(`The packaged Next.js server is missing at ${serverEntry}.`);
    }
    log(`Starting packaged backend on ${LOOPBACK_HOST}:${port}.`);
    return attachBackendLifecycle({
      kind: "utility",
      alive: true,
      process: utilityProcess.fork(serverEntry, [], {
        cwd: serverRoot,
        env,
        stdio: "pipe",
        serviceName: "Scope backend",
      }),
    });
  }

  const projectRoot = path.resolve(__dirname, "..");
  const nextEntry = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
  if (!fs.existsSync(nextEntry)) {
    throw new Error("Next.js is not installed. Run npm install in the desktop project first.");
  }
  const nodeCommand =
    process.env.SCOPE_DESKTOP_NODE?.trim() || (process.platform === "win32" ? "node.exe" : "node");
  log(`Starting development backend on ${LOOPBACK_HOST}:${port}.`);
  return attachBackendLifecycle({
    kind: "child",
    alive: true,
    process: spawn(nodeCommand, [nextEntry, "dev", "-H", LOOPBACK_HOST, "-p", String(port)], {
      cwd: projectRoot,
      env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  });
}

function stopBackend() {
  const current = backend;
  if (!current || !current.alive) {
    return Promise.resolve();
  }
  log("Stopping the desktop backend.");
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve();
      }
    };
    const timeout = setTimeout(() => {
      log("Backend shutdown exceeded five seconds; Electron will finish process cleanup.");
      if (current.kind === "child" && current.alive) {
        current.process.kill("SIGKILL");
      }
      finish();
    }, 5_000);
    current.process.once("exit", finish);
    try {
      current.process.kill();
    } catch (error) {
      log(`Could not signal the backend: ${error instanceof Error ? error.message : error}`);
      finish();
    }
  });
}

async function completeShutdown(exitCode = 0) {
  if (shutdownComplete) {
    return;
  }
  shuttingDown = true;
  await xConnection?.close();
  await xBroker?.close();
  await stopBackend();
  shutdownComplete = true;
  log(`Desktop host exiting with code ${exitCode}.`);
  process.exitCode = exitCode;
  app.quit();
}

function isTrustedDesktopEvent(event) {
  return (
    mainWindow !== null &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === event.sender.mainFrame &&
    appOrigin !== null &&
    isInternalUrl(event.senderFrame.url, appOrigin)
  );
}

function currentIntegrationStatus() {
  return integrationStatus({
    platform: process.platform,
    env: process.env,
    homeDir: os.homedir(),
    appImagePath: runningAppImage,
  });
}

/**
 * Smoke-only: proves the sandboxed renderer can write the system clipboard.
 * Chromium refuses clipboard writes from an unfocused document, so the hidden
 * smoke window is briefly shown and focused; it is hidden again afterwards.
 */
async function smokeVerifyClipboard(window) {
  const marker = "scope-desktop-smoke-clipboard";
  const script = `navigator.clipboard
    .writeText(${JSON.stringify(marker)})
    .then(() => true)
    .catch((error) => String(error))`;
  const wasVisible = window.isVisible();
  if (!wasVisible) {
    window.show();
  }
  if (process.platform === "darwin") {
    // A hidden utility window cannot take key focus while another app is
    // frontmost; the clipboard API refuses writes from unfocused documents.
    app.focus({ steal: true });
  }
  try {
    let lastOutcome = "window never gained focus";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      window.focus();
      lastOutcome = await window.webContents.executeJavaScript(script, true);
      if (lastOutcome === true) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (lastOutcome !== true) {
      throw new Error(`The packaged renderer could not write to the clipboard: ${lastOutcome}`);
    }
    // Clipboard ownership is asynchronous on Wayland/X11; give the selection
    // owner a moment before declaring the write missing.
    let readBack = null;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      readBack = await clipboard.readText();
      if (readBack === marker) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (readBack !== marker) {
      throw new Error("The packaged renderer clipboard write did not reach the system clipboard.");
    }
  } finally {
    if (!wasVisible) {
      window.hide();
    }
  }
}

/** Smoke-only: proves external links reach the system URL opener. */
async function smokeVerifyExternalLink(window) {
  const markerPath = process.env.SCOPE_DESKTOP_SMOKE_OPEN_URL_MARKER;
  const target = "https://example.com/scope-smoke-link";
  fs.rmSync(markerPath, { force: true });
  await window.webContents.executeJavaScript(
    `window.open(${JSON.stringify(target)}, "_blank"); true`,
    true,
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(markerPath, "utf8").includes(target)) {
        return;
      }
    } catch {
      // The opener records the URL in its own process; wait for it to land.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The external link did not reach the system URL opener.");
}

/**
 * Waits for a button with the exact label in the packaged Settings page.
 * Smoke-only; resolves false after the deadline instead of throwing.
 */
function smokeWaitForButton(window, label, timeoutMs = 15_000) {
  return window.webContents.executeJavaScript(
    `(async () => {
       const deadline = Date.now() + ${timeoutMs};
       while (Date.now() < deadline) {
         const button = [...document.querySelectorAll("button")].find(
           (candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)},
         );
         if (button) {
           return true;
         }
         await new Promise((resolve) => setTimeout(resolve, 100));
       }
       return false;
     })()`,
    true,
  );
}

/**
 * Smoke-only AppImage check: clicks the real Settings buttons to install,
 * reinstall (the update path), and remove the menu integration, then proves
 * the managed files are gone while the profile still exists. Everything
 * resolves inside the disposable smoke profile.
 */
async function smokeVerifyLinuxIntegration(window) {
  const status = currentIntegrationStatus();
  if (!(await smokeWaitForButton(window, "Add to application menu"))) {
    throw new Error("The Settings page did not render the application-menu action.");
  }
  if (
    !(await window.webContents.executeJavaScript(
      `[...document.querySelectorAll("button")].find(
         (button) => button.textContent?.trim() === "Add to application menu",
       ).click(); true`,
      true,
    ))
  ) {
    throw new Error("The Add to application menu button could not be clicked.");
  }
  if (!(await smokeWaitForButton(window, "Remove from application menu"))) {
    throw new Error("The Settings page did not switch to the integrated state.");
  }
  for (const created of [status.managedExecutablePath, status.desktopEntryPath, status.iconPath]) {
    if (!fs.existsSync(created)) {
      throw new Error(`Menu integration did not create ${created}.`);
    }
  }
  if (fs.statSync(status.managedExecutablePath).size !== fs.statSync(runningAppImage).size) {
    throw new Error("The managed AppImage copy does not match the downloaded AppImage.");
  }
  // Exercise the visible update action, not just its underlying IPC method.
  if (!(await smokeWaitForButton(window, "Update application-menu copy"))) {
    throw new Error("The Settings page did not render the update action.");
  }
  await window.webContents.executeJavaScript(
    `[...document.querySelectorAll("button")].find(
       (button) => button.textContent?.trim() === "Update application-menu copy",
     ).click(); true`,
    true,
  );
  const updated = await window.webContents.executeJavaScript(
    `(async () => {
       const deadline = Date.now() + 15_000;
       while (Date.now() < deadline) {
         if (document.body.innerText.includes("The application-menu copy was updated.")) {
           return true;
         }
         await new Promise((resolve) => setTimeout(resolve, 100));
       }
       return false;
     })()`,
    true,
  );
  if (!updated || !currentIntegrationStatus().integrated) {
    throw new Error("Updating the menu copy through Settings failed.");
  }
  if (
    !(await window.webContents.executeJavaScript(
      `[...document.querySelectorAll("button")].find(
         (button) => button.textContent?.trim() === "Remove from application menu",
       ).click(); true`,
      true,
    ))
  ) {
    throw new Error("The Remove from application menu button could not be clicked.");
  }
  if (!(await smokeWaitForButton(window, "Add to application menu"))) {
    throw new Error("The Settings page did not return to the not-integrated state.");
  }
  for (const leftover of [status.managedExecutablePath, status.desktopEntryPath, status.iconPath]) {
    if (fs.existsSync(leftover)) {
      throw new Error(`Menu integration removal left ${leftover} behind.`);
    }
  }
  if (!fs.existsSync(userDataRoot)) {
    throw new Error("Menu integration removal deleted user data.");
  }
}

async function showFatalError(error) {
  if (fatalErrorShown) {
    return;
  }
  fatalErrorShown = true;
  const message = error instanceof Error ? error.message : String(error);
  log(`Fatal desktop error: ${message}`);
  if (!isSmokeRun) {
    await dialog.showMessageBox({
      type: "error",
      title: "scope could not start",
      message: "The local Scope service could not be started.",
      detail: `${message}\n\nDiagnostic log: ${logFile}`,
    });
  }
  await completeShutdown(1);
}

async function bootstrap() {
  log(`Starting scope desktop ${app.getVersion()} (${process.platform}/${process.arch}).`);
  configureApplicationMenu();
  if (isSmokeRun) log("Application menu configured.");
  createMainWindow({ revealWhenReady: !isSmokeRun });
  if (isSmokeRun) log("Startup window created.");

  const token = crypto.randomBytes(32).toString("hex");
  const port = await allocateLoopbackPort();
  if (isSmokeRun) log("Loopback port reserved.");
  appOrigin = `http://${LOOPBACK_HOST}:${port}`;
  configureRendererSession(appOrigin, token);
  if (isSmokeRun) log("Renderer session configured.");
  const workerName = process.platform === "win32" ? "scope-x-worker.exe" : "scope-x-worker";
  const workerPath = path.join(
    app.isPackaged ? process.resourcesPath : path.join(__dirname, "vendor"),
    "x-worker",
    workerName,
  );
  log(
    `X storage diagnostic: ${JSON.stringify(
      collectStorageDiagnostic({
        safeStorage,
        platform: process.platform,
        electronVersion: process.versions.electron,
        profileKind: isSmokeRun ? "smoke" : app.isPackaged ? "packaged" : "development",
        config: storageConfig,
        policy: storagePolicy,
        // macOS may synchronously prompt for Keychain access. A startup
        // diagnostic must not hold the app before its window is usable.
        probe: process.platform !== "darwin",
      }),
    )}`,
  );
  xConnection = createXConnection({
    BrowserWindow,
    session,
    safeStorage,
    dataRoot: userDataRoot,
    executable: workerPath,
    runWorker,
    isServicePresent: secretServiceAvailable,
  });
  xBroker = await startXBroker(xConnection);
  const xOperations = Object.freeze(
    Object.assign(Object.create(null), {
      status: () => xConnection.status(),
      connect: () => xConnection.connect(),
      cancel: () => xConnection.cancel(),
      disconnect: () => xConnection.disconnect(),
      focus: () => xConnection.focus(),
      "retry-storage": () => xConnection.retryStorage(),
    }),
  );
  ipcMain.handle("scope:x", async (event, operation) => {
    const run = typeof operation === "string" ? xOperations[operation] : undefined;
    if (!isTrustedDesktopEvent(event) || !run) {
      throw new Error("X connection request refused");
    }
    try {
      return { ok: true, schema_version: 1, data: await run() };
    } catch (error) {
      return { ok: false, error: { code: error.code || "invalid_response" } };
    }
  });
  ipcMain.handle("scope:app", async (event, operation) => {
    if (!isTrustedDesktopEvent(event)) {
      throw new Error("Desktop app request refused");
    }
    if (operation === "info") {
      return {
        ok: true,
        data: {
          version: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          packaged: app.isPackaged,
          logsPath: logDirectory,
        },
      };
    }
    if (operation === "open-logs") {
      const failure = await shell.openPath(logDirectory);
      if (failure) {
        throw new Error(`Could not open the logs folder: ${failure}`);
      }
      return { ok: true, data: { opened: true } };
    }
    if (operation === "integration-status") {
      return { ok: true, data: currentIntegrationStatus() };
    }
    if (operation === "install-menu-entry" || operation === "remove-menu-entry") {
      // The renderer never supplies a path: the main process uses the
      // AppImage it was actually launched from (or None outside an AppImage).
      if (process.platform !== "linux" || runningAppImage === null) {
        return {
          ok: false,
          error: {
            code: "not_appimage",
            message:
              "Application-menu integration is available when Scope runs from a Linux AppImage.",
          },
        };
      }
      try {
        const options = {
          platform: process.platform,
          env: process.env,
          homeDir: os.homedir(),
          appImagePath: runningAppImage,
          iconSourcePath: appIconPath,
        };
        const data =
          operation === "install-menu-entry"
            ? await installMenuEntry(options)
            : await removeMenuEntry(options);
        return { ok: true, data };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Application-menu ${operation} failed: ${message}`);
        return { ok: false, error: { code: error?.code || "integration_failed", message } };
      }
    }
    throw new Error("Unknown desktop app request");
  });
  void xConnection.restore();
  backend = startBackend(port, token);
  await waitForBackend({
    origin: appOrigin,
    token,
    timeoutMs: app.isPackaged ? 45_000 : 120_000,
    isAlive: () => backend?.alive === true,
  });
  backendReady = true;
  log("Desktop backend is ready.");

  if (
    !startupWindowAvailable({ window: mainWindow, platform: process.platform, smoke: isSmokeRun })
  )
    return;

  let smokeDataReopened = false;
  if (isSmokeRun) {
    smokeDataReopened = await runSmokeChecks({ origin: appOrigin, token, workerPath });
  }

  await mainWindow.loadURL(appOrigin);

  if (isSmokeRun) {
    const rendered = await mainWindow.webContents.executeJavaScript(
      `document.querySelector("#main h1")?.textContent?.trim() === "Creator library"`,
      true,
    );
    if (!rendered) {
      throw new Error("The packaged renderer did not load the Scope library page.");
    }

    await mainWindow.loadURL(`${appOrigin}/settings`);
    const settingsCheck = await mainWindow.webContents.executeJavaScript(
      `(async () => {
         const deadline = Date.now() + 15_000;
         while (Date.now() < deadline) {
           if (window.scopeApp && document.querySelector("#desktop-info-heading")) {
             break;
           }
           await new Promise((resolve) => setTimeout(resolve, 100));
         }
         if (!window.scopeApp) {
           return { ok: false, reason: "desktop bridge missing" };
         }
         const info = await window.scopeApp.info();
         const logsButton = [...document.querySelectorAll("button")].some(
           (button) => button.textContent?.trim() === "Open logs folder",
         );
         const xStatus = await window.scopeX.status();
         const storage = xStatus?.data?.storage;
         const storageSafe =
           xStatus?.ok === true &&
           typeof storage?.state === "string" &&
           // No saved login may ever live in an unprotected plaintext store.
           (storage.state !== "saved" || storage.backend !== "basic_text") &&
           (storage.state === "unavailable" ? xStatus.data.sessionOnly === true : true);
         return {
           ok:
             info?.ok === true &&
             typeof info.data?.version === "string" &&
             info.data.version.length > 0 &&
             logsButton &&
             storageSafe,
           reason: "version, logs action, or X storage status missing",
         };
       })()`,
      true,
    );
    if (!settingsCheck?.ok) {
      throw new Error(
        `The packaged Settings page did not expose desktop information (${settingsCheck?.reason}).`,
      );
    }
    log("Smoke verified the desktop bridge and X storage status on the Settings page.");

    await smokeVerifyClipboard(mainWindow);
    log("Smoke verified clipboard writes from the packaged renderer.");

    if (process.env.SCOPE_DESKTOP_SMOKE_OPEN_URL_MARKER) {
      await smokeVerifyExternalLink(mainWindow);
      log("Smoke verified external links reach the system URL opener.");
      console.log("SCOPE_DESKTOP_SMOKE_EXTERNAL_LINK_OK");
    }

    if (runningAppImage !== null) {
      await smokeVerifyLinuxIntegration(mainWindow);
      log("Smoke verified Linux AppImage menu integration.");
      console.log("SCOPE_DESKTOP_SMOKE_INTEGRATION_OK");
    }

    if (smokeDataReopened) {
      console.log("SCOPE_DESKTOP_SMOKE_REOPENED");
      log("SCOPE_DESKTOP_SMOKE_REOPENED");
    }
    // The installer harness launches the real Start-menu shortcut a second
    // time. Keep the first process alive until Electron delivers that event.
    if (process.env.SCOPE_DESKTOP_SMOKE_SECOND_INSTANCE === "1") {
      await new Promise((resolve, reject) => {
        const onSecondInstance = () => {
          clearTimeout(timer);
          if (!mainWindow?.isVisible() || mainWindow.isMinimized()) {
            reject(new Error("The second launch did not restore the installed app window."));
            return;
          }
          log("SCOPE_DESKTOP_SMOKE_SECOND_INSTANCE_OK");
          resolve();
        };
        const timer = setTimeout(() => {
          app.removeListener("second-instance", onSecondInstance);
          reject(new Error("The installed app did not receive its second launch."));
        }, 30_000);
        app.once("second-instance", onSecondInstance);
        log("SCOPE_DESKTOP_SMOKE_WAITING_FOR_SECOND_INSTANCE");
      });
    }
    log(`Smoke app version: ${app.getVersion()}`);
    if (process.platform === "darwin") {
      const windowMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === "Window");
      if (!windowMenu?.submenu?.items.some((item) => item.role === "close")) {
        throw new Error("The macOS menu is missing the Close / Cmd+W role.");
      }
      for (const event of ["activate", "second-instance"]) {
        const previousId = mainWindow.id;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("macOS window did not close")), 10_000);
          mainWindow.once("closed", () => {
            clearTimeout(timer);
            resolve();
          });
          mainWindow.close();
        });
        if (!backend?.alive) throw new Error("Closing the macOS window stopped the backend.");
        app.emit(event);
        if (!mainWindow || mainWindow.id === previousId) {
          throw new Error(`${event} did not recreate the macOS window.`);
        }
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Reopened window did not load")), 30_000);
          mainWindow.webContents.once("did-finish-load", () => {
            clearTimeout(timer);
            resolve();
          });
          mainWindow.webContents.once("did-fail-load", (_event, code, description) => {
            clearTimeout(timer);
            reject(new Error(`Reopened window failed: ${code} ${description}`));
          });
        });
        const heading = await mainWindow.webContents.executeJavaScript(
          'document.querySelector("#main h1")?.textContent?.trim()',
          true,
        );
        if (heading !== "Creator library") throw new Error(`${event} reopened the wrong page.`);
      }
      log("macOS Close, Dock activation, and second-instance reopen passed.");
    }
    log("SCOPE_DESKTOP_SMOKE_OK");
    console.log("SCOPE_DESKTOP_SMOKE_OK");
    await completeShutdown(0);
  }
}

// Chromium reads --password-store before app ready; choosing a protected
// backend later has no effect on the current process.
rotateLog();
const storageConfig = readStorageConfig(path.join(userDataRoot, STORAGE_CONFIG_FILENAME));
const storagePolicy = applyStorageBackendPreference({
  commandLine: app.commandLine,
  platform: process.platform,
  env: process.env,
  config: storageConfig,
  chooseSecretService: () => secretServiceAvailable(),
});
log(
  storagePolicy.applied
    ? `X storage backend selected: ${storagePolicy.backend} (${storagePolicy.source}).`
    : `X storage backend selection deferred to Electron: ${storagePolicy.source}${
        storagePolicy.reason ? ` (${storagePolicy.reason})` : ""
      }.`,
);

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());

  app.on("before-quit", (event) => {
    if (!shutdownComplete && backend?.alive) {
      event.preventDefault();
      void completeShutdown(0);
    }
  });
  app.on("window-all-closed", () => {
    // macOS apps stay in the Dock (with their local backend running) until
    // the user quits explicitly; every other platform quits with its window.
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
  app.on("activate", () => showMainWindow());
  app.whenReady().then(bootstrap).catch(showFatalError);
}

process.on("uncaughtException", (error) => void showFatalError(error));
process.on("unhandledRejection", (error) => void showFatalError(error));
