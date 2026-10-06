"use strict";
// Maintainer/CI build step only. The installed application never invokes uv or Python.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  assertBinaryMatchesTarget,
  requireHostTarget,
  resolveTarget,
} = require("../lib/target.cjs");
const root = path.resolve(__dirname, "..");
// PyInstaller produces native binaries; refusing non-host targets keeps a
// stale arm64/x64 worker from silently shipping under the wrong profile.
const target = requireHostTarget(resolveTarget());
const source = path.join(root, "x-worker");
const build = path.join(root, ".runtime", "x-worker");
const output = path.join(root, "vendor", "x-worker");
const venv = path.join(build, "venv");
const python = path.join(venv, target.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const name = target.workerName;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    shell: false,
    windowsHide: true,
    stdio: "inherit",
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(`X worker build failed: ${command} (${result.error?.code || result.status})`);
  return result;
}
fs.mkdirSync(build, { recursive: true });
run("uv", ["venv", "--python", "3.12", venv, "--clear"]);
run("uv", [
  "pip",
  "sync",
  "--python",
  python,
  "--require-hashes",
  path.join(source, "requirements.lock"),
]);
run(python, ["-m", "unittest", "discover", "-s", source, "-p", "test_*.py"]);
run(python, [
  "-m",
  "unittest",
  "discover",
  "-s",
  path.join(root, "scripts"),
  "-p",
  "test_mac_frozen.py",
]);
fs.mkdirSync(output, { recursive: true });
run(python, [
  "-m",
  "PyInstaller",
  "--noconfirm",
  "--clean",
  "--onefile",
  "--name",
  "scope-x-worker",
  "--distpath",
  output,
  "--workpath",
  path.join(build, "work"),
  "--specpath",
  build,
  "--collect-all",
  "curl_cffi",
  "--collect-all",
  "certifi",
  "--collect-all",
  "x_client_transaction",
  path.join(source, "worker.py"),
]);
run(python, [path.join(source, "licenses.py"), path.join(output, "THIRD_PARTY_NOTICES.txt")]);
fs.copyFileSync(path.join(source, "TWITTER-CLI-LICENSE"), path.join(output, "TWITTER-CLI-LICENSE"));
const executable = path.join(output, name);
assertBinaryMatchesTarget(executable, target);
const cleanEnv = {};
for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"])
  if (process.env[key]) cleanEnv[key] = process.env[key];
const smoke = run(executable, [], {
  env: cleanEnv,
  input: JSON.stringify({ protocol: 1, operation: "runtime" }),
  encoding: "utf8",
  stdio: "pipe",
  timeout: 30_000,
});
if (JSON.parse(smoke.stdout)?.ok !== true)
  throw new Error("Frozen X worker could not load its native runtime");
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
fs.writeFileSync(
  path.join(output, "build.json"),
  JSON.stringify(
    {
      ...JSON.parse(fs.readFileSync(path.join(source, "upstream.json"))),
      platform: target.platform,
      arch: target.arch,
      executable: name,
      sha256: sha256(executable),
      lockSha256: sha256(path.join(source, "requirements.lock")),
      workerSha256: sha256(path.join(source, "worker.py")),
    },
    null,
    2,
  ) + "\n",
);
console.log("Frozen X worker passed clean-environment import check.");
