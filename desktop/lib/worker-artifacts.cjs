"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertBinaryMatchesTarget } = require("./target.cjs");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verifyXWorker({ source, output, target }) {
  const build = JSON.parse(fs.readFileSync(path.join(output, "build.json"), "utf8"));
  if (build.platform !== target.platform || build.arch !== target.arch) {
    throw new Error(
      `X worker was built for ${build.platform}/${build.arch}, expected ${target.platform}/${target.arch}`,
    );
  }
  if (build.executable !== target.workerName) {
    throw new Error(`X worker executable is ${build.executable}, expected ${target.workerName}`);
  }
  const executable = path.join(output, target.workerName);
  assertBinaryMatchesTarget(executable, target);
  if (sha256(executable) !== build.sha256) {
    throw new Error("X worker executable does not match its recorded sha256");
  }
  for (const [file, key] of [
    ["worker.py", "workerSha256"],
    ["requirements.lock", "lockSha256"],
  ]) {
    if (sha256(path.join(source, file)) !== build[key]) {
      throw new Error(`Stale X worker: ${file} changed; rebuild the worker.`);
    }
  }
  const upstream = JSON.parse(fs.readFileSync(path.join(source, "upstream.json"), "utf8"));
  for (const [key, value] of Object.entries(upstream)) {
    if (build[key] !== value) {
      throw new Error(`Stale X worker: upstream ${key} changed; rebuild the worker.`);
    }
  }
}

module.exports = { verifyXWorker };
