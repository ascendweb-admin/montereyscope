"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { runSmokeProcess } = require("../lib/smoke-process.cjs");

test("packaged smoke runner captures a completed child", async () => {
  const result = await runSmokeProcess(process.execPath, process.env, 10_000, [
    "-e",
    'process.stdout.write("fixture ready")',
  ]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /fixture ready/);
  assert.equal(result.error, undefined);
});

test("packaged smoke runner returns after a child hangs", async () => {
  const started = Date.now();
  const result = await runSmokeProcess(process.execPath, process.env, 100, [
    "-e",
    "setInterval(() => {}, 1000)",
  ]);
  assert.equal(result.error?.code, "ETIMEDOUT");
  assert(Date.now() - started < 5_000);
});
