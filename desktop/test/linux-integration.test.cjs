"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const {
  MANAGED_MARKER,
  appImageExtractAndRun,
  buildDesktopEntry,
  desktopEntryState,
  escapeDesktopExecArgument,
  escapeDesktopString,
  installMenuEntry,
  integrationPaths,
  integrationStatus,
  removeMenuEntry,
} = require("../lib/linux-integration.cjs");

const legacyEntry = [
  "[Desktop Entry]",
  "Type=Application",
  "Name=scope",
  "Exec=/home/alice/src/scope/scripts/launch",
  "",
].join("\n");

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-linux-integration-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { XDG_DATA_HOME: path.join(root, "xdg-data") };
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir);
  const appImagePath = path.join(root, "Downloads", "scope-0.1.0-linux-x64.AppImage");
  fs.mkdirSync(path.dirname(appImagePath), { recursive: true });
  fs.writeFileSync(appImagePath, "appimage-bytes");
  const iconSourcePath = path.join(root, "icon.png");
  fs.writeFileSync(iconSourcePath, "png-bytes");
  const updateCalls = [];
  return {
    root,
    env,
    homeDir,
    appImagePath,
    iconSourcePath,
    updateCalls,
    options: {
      platform: "linux",
      env,
      homeDir,
      appImagePath,
      iconSourcePath,
      updateDatabase: (directory) => updateCalls.push(directory),
    },
  };
}

test("integration paths follow XDG_DATA_HOME and the user home fallback", () => {
  const explicit = integrationPaths({ env: { XDG_DATA_HOME: "/data" }, homeDir: "/home/alice" });
  assert.equal(explicit.applicationsDir, path.join("/data", "applications"));
  assert.equal(
    explicit.managedExecutablePath,
    path.join("/data", "scope", "app", "scope.AppImage"),
  );
  const fallback = integrationPaths({ env: {}, homeDir: "/home/alice" });
  assert.equal(
    fallback.desktopEntryPath,
    path.join("/home/alice", ".local", "share", "applications", "scope.desktop"),
  );
});

test("Exec arguments are quoted and escaped for hostile paths", () => {
  assert.equal(
    escapeDesktopExecArgument("/home/alice/My Apps/scope"),
    '"/home/alice/My Apps/scope"',
  );
  assert.equal(
    escapeDesktopExecArgument('/home/alice/a"b`c$d\\e%f'),
    '"/home/alice/a\\\\"b\\\\`c\\\\$d\\\\\\\\e%%f"',
  );
  assert.equal(escapeDesktopExecArgument("/tmp/100%/scope"), '"/tmp/100%%/scope"');
});

test("desktop-entry strings escape control characters", () => {
  assert.equal(escapeDesktopString("a\\b\nc\td\re"), "a\\\\b\\nc\\td\\re");
});

test("buildDesktopEntry points at the managed copy with the marker", () => {
  const entry = buildDesktopEntry({
    executablePath: "/data/scope/app/scope.AppImage",
    iconPath: "/data/icons/scope.png",
  });
  assert.match(entry, /^\[Desktop Entry\]\n/);
  assert.match(entry, /Exec=\/bin\/sh -c .* "\/data\/scope\/app\/scope\.AppImage"/);
  assert.match(entry, /Icon=\/data\/icons\/scope\.png/);
  assert.match(entry, /StartupWMClass=scope/);
  assert.ok(entry.split("\n").includes(MANAGED_MARKER));
});

test("install copies the AppImage, installs the icon, and writes the entry", async (context) => {
  const { options, appImagePath, env, homeDir, updateCalls } = fixture(context);
  const status = await installMenuEntry(options);

  assert.equal(status.integrated, true);
  assert.equal(status.desktopEntryState, "managed");
  assert.equal(status.appImagePath, path.resolve(appImagePath));
  assert.equal(
    fs.readFileSync(status.managedExecutablePath, "utf8"),
    fs.readFileSync(appImagePath, "utf8"),
  );
  // Windows can exercise the copy/integration logic, but its stat mode does
  // not report POSIX executable bits for this Linux-only operation.
  if (process.platform !== "win32") {
    assert.notEqual(fs.statSync(status.managedExecutablePath).mode & 0o111, 0);
  }
  assert.equal(fs.readFileSync(status.iconPath, "utf8"), "png-bytes");
  const entry = fs.readFileSync(status.desktopEntryPath, "utf8");
  assert.match(entry, /Exec=\/bin\/sh -c .* ".*scope\.AppImage"/);
  assert.ok(entry.split("\n").includes(MANAGED_MARKER));
  assert.deepEqual(updateCalls, [integrationPaths({ env, homeDir }).applicationsDir]);
  assert.equal(integrationStatus({ platform: "linux", env, homeDir }).integrated, true);
});

test("reinstalling replaces the managed copy and keeps the entry stable", async (context) => {
  const fixtureState = fixture(context);
  const first = await installMenuEntry(fixtureState.options);
  fs.writeFileSync(fixtureState.appImagePath, "newer-appimage-bytes");

  const second = await installMenuEntry(fixtureState.options);

  assert.equal(second.managedExecutablePath, first.managedExecutablePath);
  assert.equal(second.desktopEntryPath, first.desktopEntryPath);
  assert.equal(fs.readFileSync(second.managedExecutablePath, "utf8"), "newer-appimage-bytes");
  assert.equal(
    fs.readFileSync(second.desktopEntryPath, "utf8"),
    fs.readFileSync(first.desktopEntryPath, "utf8"),
  );
});

test("install refuses to overwrite a foreign source-tree entry", async (context) => {
  const fixtureState = fixture(context);
  const { desktopEntryPath } = integrationPaths({
    env: fixtureState.env,
    homeDir: fixtureState.homeDir,
  });
  fs.mkdirSync(path.dirname(desktopEntryPath), { recursive: true });
  fs.writeFileSync(desktopEntryPath, legacyEntry);

  await assert.rejects(installMenuEntry(fixtureState.options), /was not created by this app/);
  assert.equal(fs.readFileSync(desktopEntryPath, "utf8"), legacyEntry);
  assert.equal(desktopEntryState(desktopEntryPath), "foreign");
});

test("install rejects a missing download and non-Linux platforms", async (context) => {
  const fixtureState = fixture(context);
  await assert.rejects(
    installMenuEntry({
      ...fixtureState.options,
      appImagePath: path.join(fixtureState.root, "gone.AppImage"),
    }),
    (error) => error.code === "missing_appimage",
  );
  await assert.rejects(
    installMenuEntry({ ...fixtureState.options, platform: "darwin" }),
    /only available on Linux/,
  );
});

test("removal deletes managed files and keeps user data and foreign entries", async (context) => {
  const fixtureState = fixture(context);
  const status = await installMenuEntry(fixtureState.options);
  const dataRoot = path.join(fixtureState.env.XDG_DATA_HOME, "scope");
  const database = path.join(dataRoot, "data", "localtube.db");
  const session = path.join(dataRoot, "x-session.enc");
  const foreignEntry = path.join(fixtureState.env.XDG_DATA_HOME, "applications", "other.desktop");
  fs.mkdirSync(path.dirname(database), { recursive: true });
  fs.writeFileSync(database, "library");
  fs.writeFileSync(session, "encrypted-login");
  fs.writeFileSync(foreignEntry, legacyEntry);

  const removed = await removeMenuEntry(fixtureState.options);

  assert.equal(removed.removedEntry, true);
  assert.equal(removed.integrated, false);
  assert.equal(fs.existsSync(status.managedExecutablePath), false);
  assert.equal(fs.existsSync(status.desktopEntryPath), false);
  assert.equal(fs.existsSync(status.iconPath), false);
  assert.equal(fs.readFileSync(database, "utf8"), "library");
  assert.equal(fs.readFileSync(session, "utf8"), "encrypted-login");
  assert.equal(fs.readFileSync(foreignEntry, "utf8"), legacyEntry);
});

test("removal leaves a foreign entry in place", async (context) => {
  const fixtureState = fixture(context);
  const { desktopEntryPath } = integrationPaths({
    env: fixtureState.env,
    homeDir: fixtureState.homeDir,
  });
  fs.mkdirSync(path.dirname(desktopEntryPath), { recursive: true });
  fs.writeFileSync(desktopEntryPath, legacyEntry);

  const removed = await removeMenuEntry(fixtureState.options);

  assert.equal(removed.removedEntry, false);
  assert.equal(fs.readFileSync(desktopEntryPath, "utf8"), legacyEntry);
});

test("extraction mode detects both the environment switch and the CLI runtime directory", () => {
  assert.equal(appImageExtractAndRun({}), false);
  assert.equal(appImageExtractAndRun({ APPDIR: "/tmp/.mount_scope123" }), false);
  assert.equal(appImageExtractAndRun({ APPIMAGE_EXTRACT_AND_RUN: "1" }), true);
  assert.equal(appImageExtractAndRun({ APPDIR: "/tmp/appimage_extracted_a123bc" }), true);
});

test("integration preserves extraction mode when installing and updating", async (context) => {
  const { options } = fixture(context);
  options.env.APPDIR = "/tmp/appimage_extracted_a123bc";
  const first = await installMenuEntry(options);
  assert.match(fs.readFileSync(first.desktopEntryPath, "utf8"), / --appimage-extract-and-run$/m);
  fs.writeFileSync(options.appImagePath, "new-version");
  const updated = await installMenuEntry(options);
  assert.equal(fs.readFileSync(updated.managedExecutablePath, "utf8"), "new-version");
  assert.match(fs.readFileSync(updated.desktopEntryPath, "utf8"), / --appimage-extract-and-run$/m);
});

// Use the desktop's parser and launcher as an independent oracle for quoting.
// CI installs these tools on Linux; other target platforms do not use .desktop files.
test(
  "Linux desktop launcher preserves unusual paths and the extraction argument",
  {
    skip: process.platform !== "linux",
  },
  async (context) => {
    const { root } = fixture(context);
    const parts = [
      "normal",
      "space and café",
      "back\\slash",
      'double"quote',
      "dollar$sign",
      "back`tick",
      "100%percent",
      "equals=name",
      "line\nbreak",
      "tab\tname",
      "return\rname",
    ];
    for (const [index, part] of parts.entries()) {
      const directory = path.join(root, part);
      fs.mkdirSync(directory);
      const executablePath = path.join(directory, "app");
      const marker = path.join(root, `launch-${index}.txt`);
      fs.writeFileSync(
        executablePath,
        '#!/bin/sh\nprintf "%s\\0%s" "$0" "$1" > "$SCOPE_MENU_TEST_MARKER"\n',
        { mode: 0o755 },
      );
      const entryPath = path.join(root, `launch-${index}.desktop`);
      fs.writeFileSync(
        entryPath,
        buildDesktopEntry({
          executablePath,
          iconPath: path.join(directory, "icon.png"),
          extractAndRun: true,
        }),
      );
      const validated = spawnSync("desktop-file-validate", [entryPath], { encoding: "utf8" });
      assert.equal(
        validated.status,
        0,
        validated.stderr || validated.stdout || String(validated.error),
      );
      const launched = spawnSync(
        "/usr/bin/python3",
        [
          "-c",
          `
import sys
from gi.repository import Gio
app = Gio.DesktopAppInfo.new_from_filename(sys.argv[1])
assert app is not None
assert app.launch([], None)
`,
          entryPath,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, SCOPE_MENU_TEST_MARKER: marker },
        },
      );
      assert.equal(
        launched.status,
        0,
        `Path ${JSON.stringify(part)}: ${launched.stderr || launched.error}`,
      );
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(marker) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(
        fs.readFileSync(marker, "utf8"),
        `${executablePath}\0--appimage-extract-and-run`,
      );
    }
  },
);
