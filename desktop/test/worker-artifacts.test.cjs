"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { verifyXWorker } = require("../lib/worker-artifacts.cjs");
const { TARGETS } = require("../lib/target.cjs");

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-worker-artifacts-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  const binary = Buffer.alloc(64);
  binary.write("\x7fELF");
  binary[5] = 1;
  binary.writeUInt16LE(0x3e, 18);
  fs.writeFileSync(path.join(output, "scope-x-worker"), binary);
  fs.writeFileSync(path.join(source, "worker.py"), "worker source");
  fs.writeFileSync(path.join(source, "requirements.lock"), "locked dependencies");
  const upstream = { repository: "test", commit: "abc", version: "1", license: "Apache-2.0" };
  fs.writeFileSync(path.join(source, "upstream.json"), JSON.stringify(upstream));
  const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const build = {
    ...upstream,
    platform: "linux",
    arch: "x64",
    executable: "scope-x-worker",
    sha256: hash(binary),
    workerSha256: hash("worker source"),
    lockSha256: hash("locked dependencies"),
  };
  fs.writeFileSync(path.join(output, "build.json"), JSON.stringify(build));
  return { source, output, target: TARGETS["linux-x64"] };
}

test("accepts a worker matching current sources and upstream metadata", (context) => {
  verifyXWorker(fixture(context));
});

for (const file of ["worker.py", "requirements.lock", "upstream.json"]) {
  test(`rejects a stale worker after ${file} changes`, (context) => {
    const options = fixture(context);
    fs.writeFileSync(
      path.join(options.source, file),
      file === "upstream.json"
        ? JSON.stringify({ repository: "test", commit: "new", version: "2", license: "Apache-2.0" })
        : "changed source",
    );
    assert.throws(() => verifyXWorker(options), /Stale X worker/);
  });
}
