"use strict";

/**
 * Packaged desktop smoke harness. Runs the packaged executable twice against
 * one disposable, isolated profile: the first run exercises the packaged
 * runtime (SQLite, authenticated/unauthenticated backend access, renderer,
 * bundled yt-dlp, X worker, Claude Agent SDK trace), the second proves saved
 * data reopens. On failure the profile and logs are retained for diagnosis.
 *
 * Usage: node scripts/smoke-packaged.cjs [--exe <path>] [--appimage]
 *          [--minimal-path] [--appimage-extract-and-run] [--check-external-links]
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertBinaryMatchesTarget, resolveTarget } = require("../lib/target.cjs");
const { packagedMacAppPath } = require("../lib/bundle-layout.cjs");
const { runSmokeProcess } = require("../lib/smoke-process.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const target = resolveTarget();

function parseArguments(argv) {
  const options = {
    executable: null,
    appImage: false,
    minimalPath: false,
    extractAndRun: false,
    externalLinks: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--exe") {
      index += 1;
      options.executable = argv[index] ?? null;
      if (options.executable === null) {
        throw new Error("--exe requires a path.");
      }
    } else if (argument === "--appimage") {
      options.appImage = true;
    } else if (argument === "--minimal-path") {
      options.minimalPath = true;
    } else if (argument === "--appimage-extract-and-run") {
      options.extractAndRun = true;
    } else if (argument === "--check-external-links") {
      options.externalLinks = true;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      options.executable = argument;
    }
  }
  if (options.externalLinks && options.minimalPath) {
    throw new Error("--check-external-links and --minimal-path are separate PATH scenarios.");
  }
  if (options.appImage && options.executable) {
    throw new Error("--appimage and --exe are mutually exclusive.");
  }
  if (options.appImage && options.minimalPath) {
    throw new Error(
      "--appimage cannot run with --minimal-path: AppRun is a shell script that needs /usr/bin on PATH. " +
        "The unpacked smoke run covers the empty-PATH check.",
    );
  }
  return options;
}

/** The versioned Linux AppImage produced by the release build. */
function defaultAppImage() {
  const version = JSON.parse(
    fs.readFileSync(path.join(desktopRoot, "..", "package.json"), "utf8"),
  ).version;
  return path.join(desktopRoot, "dist", `scope-${version}-linux-x64.AppImage`);
}

function defaultExecutable() {
  if (target.platform === "win32") {
    return path.join(desktopRoot, "dist", "win-unpacked", "scope.exe");
  }
  if (target.platform === "linux") {
    return path.join(desktopRoot, "dist", "linux-unpacked", "scope");
  }
  if (target.platform === "darwin") {
    return path.join(
      packagedMacAppPath(path.join(desktopRoot, "dist"), target.arch),
      "Contents",
      "MacOS",
      "scope",
    );
  }
  throw new Error(
    `No default packaged executable is configured for ${target.label}; pass --exe <path>.`,
  );
}

/** Minimal environment. Provider credentials and user config never leak in. */
function smokeEnvironment(profile, { minimalPath, externalLinks = false }) {
  const directories = {
    home: path.join(profile, "home"),
    tmp: path.join(profile, "tmp"),
    data: path.join(profile, "xdg-data"),
    config: path.join(profile, "xdg-config"),
    cache: path.join(profile, "xdg-cache"),
    state: path.join(profile, "xdg-state"),
    runtime: path.join(profile, "xdg-runtime"),
    userData: path.join(profile, "user-data"),
    emptyBin: path.join(profile, "empty-bin"),
  };
  for (const directory of Object.values(directories)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const env = {
    SCOPE_DESKTOP_LOG_STDERR: "1",
    SCOPE_DESKTOP_SMOKE: "1",
    SCOPE_DESKTOP_SMOKE_MINIMAL_PATH: minimalPath ? "1" : "0",
    SCOPE_DESKTOP_USER_DATA: directories.userData,
  };

  if (target.platform === "win32") {
    const copy = [
      "SystemRoot",
      "WINDIR",
      "ComSpec",
      "PATHEXT",
      "PROCESSOR_ARCHITECTURE",
      "NUMBER_OF_PROCESSORS",
    ];
    for (const key of copy) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }
    env.USERPROFILE = directories.home;
    env.APPDATA = path.join(directories.home, "AppData", "Roaming");
    env.LOCALAPPDATA = path.join(directories.home, "AppData", "Local");
    env.TEMP = directories.tmp;
    env.TMP = directories.tmp;
    env.PATH = minimalPath
      ? path.join(env.SystemRoot ?? "C:\\Windows", "System32")
      : process.env.PATH;
    return env;
  }

  for (const key of [
    "LANG",
    "LC_ALL",
    "DISPLAY",
    "XAUTHORITY",
    "WAYLAND_DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
  ]) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  env.HOME = directories.home;
  env.TMPDIR = directories.tmp;
  // Finder supplies macOS system utility directories even when no developer
  // tools are installed. Linux uses an empty directory for the stricter check.
  env.PATH = minimalPath
    ? target.platform === "darwin"
      ? "/usr/bin:/bin:/usr/sbin:/sbin"
      : directories.emptyBin
    : process.env.PATH;
  if (target.platform === "linux") {
    env.XDG_DATA_HOME = directories.data;
    env.XDG_CONFIG_HOME = directories.config;
    env.XDG_CACHE_HOME = directories.cache;
    env.XDG_STATE_HOME = directories.state;
    // The session's runtime dir holds the Wayland socket; replacing it would
    // break the display connection. Electron keeps its own state under
    // SCOPE_DESKTOP_USER_DATA, so the real directory leaks no test state.
    env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || directories.runtime;
  }
  if (externalLinks) {
    // A recording xdg-open in a PATH containing nothing else: the app must
    // route an external URL to the system opener, and the test captures it
    // without launching a real browser.
    const shimBin = path.join(profile, "shim-bin");
    fs.mkdirSync(shimBin, { recursive: true });
    const shim = path.join(shimBin, "xdg-open");
    fs.writeFileSync(
      shim,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$SCOPE_DESKTOP_SMOKE_OPEN_URL_MARKER"\n',
      { mode: 0o755 },
    );
    env.PATH = shimBin;
    env.SCOPE_DESKTOP_SMOKE_OPEN_URL_MARKER = path.join(profile, "opened-urls.log");
  }
  return env;
}

function describeRun(result) {
  const status = result.error
    ? `error ${result.error.code ?? result.error.message}`
    : result.status;
  return `status=${status}, signal=${result.signal ?? "none"}`;
}

function retainDiagnostics(profile, runs) {
  const diagnosticsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scope-desktop-smoke-failure-"));
  runs.forEach((result, index) => {
    fs.writeFileSync(
      path.join(diagnosticsRoot, `run-${index + 1}.stdout.log`),
      result.stdout ?? "",
      "utf8",
    );
    fs.writeFileSync(
      path.join(diagnosticsRoot, `run-${index + 1}.stderr.log`),
      result.stderr ?? "",
      "utf8",
    );
  });
  const desktopLog = path.join(profile, "user-data", "logs", "desktop.log");
  if (fs.existsSync(desktopLog)) {
    fs.copyFileSync(desktopLog, path.join(diagnosticsRoot, "desktop.log"));
    const tail = fs.readFileSync(desktopLog, "utf8").split("\n").slice(-40).join("\n");
    console.error(`---- desktop.log tail ----\n${tail}\n--------------------------`);
  }
  console.error(`Diagnostics retained at: ${diagnosticsRoot}`);
  console.error(`Disposable profile retained at: ${profile}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const executable = path.resolve(
    options.executable || (options.appImage ? defaultAppImage() : defaultExecutable()),
  );
  if (!fs.existsSync(executable)) {
    throw new Error(`Packaged executable is missing: ${executable}`);
  }
  assertBinaryMatchesTarget(executable, target);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "scope-desktop-smoke-"));
  const environment = smokeEnvironment(profile, options);
  const isAppImage = target.platform === "linux" && /\.AppImage$/i.test(executable);
  if (isAppImage) {
    // Running the AppImage itself, not the unpacked tree. An extracted run
    // (--appimage-extract-and-run, used where FUSE is unavailable) has no
    // AppImage runtime, so the smoke-only variable supplies the path the real
    // runtime would have exported.
    environment.SCOPE_DESKTOP_SMOKE_APPIMAGE_UNDER_TEST = executable;
    if (options.extractAndRun) {
      environment.APPIMAGE_EXTRACT_AND_RUN = "1";
    }
  }

  const runs = [await runSmokeProcess(executable, environment)];
  if (runs[0].status === 0 && runs[0].stdout.includes("SCOPE_DESKTOP_SMOKE_OK")) {
    runs.push(await runSmokeProcess(executable, environment));
  }

  const failures = [];
  const [first, second] = runs;
  const assertRun = (result, label) => {
    if (result.error !== undefined) {
      failures.push(`${label} failed to run (${describeRun(result)}).`);
      return false;
    }
    if (result.status !== 0) {
      failures.push(`${label} exited with ${describeRun(result)}.`);
      return false;
    }
    if (!result.stdout.includes("SCOPE_DESKTOP_SMOKE_OK")) {
      failures.push(`${label} did not report SCOPE_DESKTOP_SMOKE_OK.`);
      return false;
    }
    return true;
  };

  if (assertRun(first, "First run")) {
    if (first.stdout.includes("SCOPE_DESKTOP_SMOKE_REOPENED")) {
      failures.push("First run unexpectedly found data from an earlier smoke run.");
    }
  }
  if (second) {
    if (
      assertRun(second, "Second run") &&
      !second.stdout.includes("SCOPE_DESKTOP_SMOKE_REOPENED")
    ) {
      failures.push("Second run did not reopen the database saved by the first run.");
    }
  } else {
    failures.push("Second run skipped because the first packaged launch did not pass.");
  }

  const requireMarker = (marker, description) => {
    for (const [result, label] of [
      [first, "First run"],
      [second, "Second run"],
    ].filter(([result]) => result)) {
      if (result.status === 0 && !result.stdout.includes(marker)) {
        failures.push(`${label} did not report ${description}.`);
      }
    }
  };
  if (isAppImage) {
    requireMarker("SCOPE_DESKTOP_SMOKE_INTEGRATION_OK", "verified AppImage menu integration");
  }
  if (options.externalLinks) {
    requireMarker("SCOPE_DESKTOP_SMOKE_EXTERNAL_LINK_OK", "verified external links");
    const marker = path.join(profile, "opened-urls.log");
    if (fs.existsSync(marker)) {
      const opened = fs.readFileSync(marker, "utf8");
      if (!opened.includes("https://example.com/scope-smoke-link")) {
        failures.push("The external link marker did not record the expected URL.");
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    retainDiagnostics(profile, runs);
    process.exitCode = 1;
    return;
  }

  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`Packaged desktop smoke test passed (${target.label}).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
