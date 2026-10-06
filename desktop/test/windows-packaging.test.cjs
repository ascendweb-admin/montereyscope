"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const config = require("../electron-builder.config.cjs");

test("windows installer keeps the versioned download name from the release table", () => {
  assert.equal(config.win.artifactName, "scope-${version}-windows-x64-setup.${ext}");
});

test("windows installer is per-user and never requires administrator rights", () => {
  assert.equal(config.nsis.oneClick, false);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.allowElevation, false);
  assert.equal(config.nsis.allowToChangeInstallationDirectory, true);
});

test("windows installer keeps shortcuts optional and never deletes user data", () => {
  assert.equal(config.nsis.createStartMenuShortcut, true);
  assert.equal(config.nsis.createDesktopShortcut, true);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
});

test("app identity and Windows execution model stay stable", () => {
  assert.equal(config.appId, "com.scope.desktop");
  assert.equal(config.win.executableName, "scope");
  assert.equal(config.win.icon, "assets/icon.ico");
  // The app id drives the Start menu / notification identity on Windows.
  assert.equal(config.productName, "scope");
});
