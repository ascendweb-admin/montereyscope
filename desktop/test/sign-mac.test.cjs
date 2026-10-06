"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function hook({ signed, failPayload = false }) {
  const calls = [];
  const exports = {};
  const dependencies = {
    "node:path": path,
    "node:child_process": {
      execFileSync(command, args) {
        calls.push({ command, args });
        if (failPayload) throw new Error("payload signature failed");
      },
    },
    "@electron/osx-sign": { signAsync: async (options) => calls.push({ seal: options }) },
    "./mac-signing.cjs": { macSigningPlan: () => ({ signed }) },
    "../lib/mac-native.cjs": require("../lib/mac-native.cjs"),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../scripts/sign-mac.cjs"), "utf8"), {
    exports,
    require: (name) => {
      assert(name in dependencies, `Unexpected dependency ${name}`);
      return dependencies[name];
    },
  });
  return { sign: exports.sign, calls };
}

test("Developer ID hook signs both payloads with the builder keychain before sealing the app", async () => {
  const { sign, calls } = hook({ signed: true });
  const options = {
    app: path.resolve("Scope App.app"),
    identity: "IDENTITY-HASH",
    keychain: "/tmp/build.keychain",
  };
  await sign(options);
  assert.equal(calls.length, 3);
  for (const [index, name] of ["yt-dlp", "scope-x-worker"].entries()) {
    assert.equal(path.basename(calls[index].args[2]), name);
    assert.equal(calls[index].args[4], options.identity);
    assert.equal(calls[index].args[6], options.keychain);
    assert(calls[index].args[2].startsWith(options.app + path.sep));
  }
  assert.equal(calls[2].seal, options);
});

test("engineering signing preserves upstream frozen archives", async () => {
  const { sign, calls } = hook({ signed: false });
  const options = { app: "/tmp/Scope.app", identity: "-" };
  await sign(options);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].seal, options);
});

test("a failed nested signature stops before the outer app is sealed", async () => {
  const { sign, calls } = hook({ signed: true, failPayload: true });
  await assert.rejects(sign({ app: "/tmp/Scope.app", identity: "ID" }), /payload signature failed/);
  assert.equal(calls.length, 1);
  assert(!calls.some((call) => call.seal));
});

test("signed mode cannot silently use an ad-hoc identity", async () => {
  const { sign, calls } = hook({ signed: true });
  await assert.rejects(
    sign({ app: "/tmp/Scope.app", identity: "-" }),
    /without a resolved identity/,
  );
  assert.equal(calls.length, 0);
});

test("electron-builder resolves the custom signing hook", async () => {
  const { resolveFunction } = require("app-builder-lib/out/util/resolve");
  const sign = await resolveFunction(
    undefined,
    path.join(__dirname, "../scripts/sign-mac.cjs"),
    "sign",
    path.join(__dirname, ".."),
  );
  assert.equal(typeof sign, "function");
});
