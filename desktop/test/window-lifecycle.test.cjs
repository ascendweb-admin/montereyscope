"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { revealMainWindow, startupWindowAvailable } = require("../lib/window-lifecycle.cjs");

test("closing the Mac startup window allows bootstrap to complete and activation to reopen", () => {
  for (const window of [null, { isDestroyed: () => true }]) {
    assert.equal(startupWindowAvailable({ window, platform: "darwin", smoke: false }), false);
    const opened = [];
    revealMainWindow({
      window,
      canCreate: true,
      backendReady: true,
      origin: "http://127.0.0.1:1234",
      createWindow: (options) => opened.push(options),
    });
    assert.deepEqual(opened, [{ revealWhenReady: true, url: "http://127.0.0.1:1234" }]);
  }
});

test("activation before bootstrap does not create a duplicate window", () => {
  revealMainWindow({
    window: null,
    canCreate: false,
    createWindow: () => assert.fail("duplicate"),
  });
});

test("activation while backend starts reopens the loading window", () => {
  revealMainWindow({
    window: null,
    canCreate: true,
    backendReady: false,
    origin: "http://127.0.0.1:1234",
    createWindow: (options) => assert.equal(options.url, null),
  });
});

test("a second launch restores and focuses the existing window", () => {
  const calls = [];
  revealMainWindow({
    window: {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: () => calls.push("restore"),
      show: () => calls.push("show"),
      focus: () => calls.push("focus"),
    },
    canCreate: true,
    createWindow: () => assert.fail("duplicate"),
  });
  assert.deepEqual(calls, ["restore", "show", "focus"]);
});

test("non-Mac startup and smoke runs still reject missing windows", () => {
  for (const [platform, smoke] of [
    ["linux", false],
    ["win32", false],
    ["darwin", true],
  ]) {
    assert.throws(
      () => startupWindowAvailable({ window: null, platform, smoke }),
      /closed during startup/,
    );
  }
});
