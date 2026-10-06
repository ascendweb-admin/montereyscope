"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { artifactName, assemble, validateVersion } = require("../scripts/release.cjs");

const commit = "a".repeat(40);
const tag = "v1.2.3";
const keys = ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"];

test("native package commands never publish implicitly from a release tag", () => {
  const scripts = require("../package.json").scripts;
  for (const name of ["dist:linux", "dist:windows", "dist:mac", "dist:mac:x64"]) {
    assert.match(scripts[name], /--publish never$/);
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-release-test-"));
  for (const [dir, name] of [
    ["", "scope"],
    ["desktop", "scope-desktop"],
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(
      path.join(root, dir, "package.json"),
      JSON.stringify({ name, version: "1.2.3" }),
    );
    fs.writeFileSync(
      path.join(root, dir, "package-lock.json"),
      JSON.stringify({ name, version: "1.2.3", packages: { "": { name, version: "1.2.3" } } }),
    );
  }
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "desktop", "yt-dlp-version.txt"), "2026.08.19\n");
  for (const name of [
    "linux-install.md",
    "windows-install.md",
    "macos-install.md",
    "desktop-third-party-notices.md",
  ])
    fs.writeFileSync(path.join(root, "docs", name), `# ${name}\nscope-VERSION\n2026.08.19\n`);
  const input = path.join(root, "incoming");
  for (const key of keys) {
    const folder = path.join(input, `release-scope-${key}`);
    fs.mkdirSync(folder, { recursive: true });
    const artifact = artifactName("1.2.3", key);
    const content = Buffer.from(`binary for ${key}`);
    fs.writeFileSync(path.join(folder, artifact), content);
    fs.writeFileSync(
      path.join(folder, "manifest.json"),
      JSON.stringify({
        tag,
        version: "1.2.3",
        commit,
        key,
        artifact,
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        signing: key.startsWith("macos")
          ? "signed-notarized"
          : key === "windows-x64"
            ? "signed"
            : "not-applicable",
      }),
    );
  }
  return { root, input, output: path.join(root, "ready"), tag, commit, repository: "owner/scope" };
}
function withFixture(fn) {
  const options = fixture();
  try {
    fn(options);
  } finally {
    fs.rmSync(options.root, { recursive: true, force: true });
  }
}

test("release version requires exact tag, two manifests, and two lockfile roots", () =>
  withFixture((options) => {
    assert.equal(validateVersion(options.root, tag), "1.2.3");
    assert.throws(() => validateVersion(options.root, "v1.2.3-beta.1"), /vX.Y.Z/);
    const lock = path.join(options.root, "desktop", "package-lock.json");
    const data = JSON.parse(fs.readFileSync(lock));
    data.packages[""].version = "1.2.2";
    fs.writeFileSync(lock, JSON.stringify(data));
    assert.throws(
      () => validateVersion(options.root, tag),
      /desktop\/package-lock.json root package version/,
    );
  }));

test("assembly requires four unique exact assets from one commit and writes checksums and links", () =>
  withFixture((options) => {
    assemble(options);
    const files = fs.readdirSync(options.output);
    assert.equal(files.filter((name) => name.endsWith(".dmg")).length, 2);
    assert.equal(files.filter((name) => name.endsWith(".AppImage")).length, 1);
    assert.match(
      fs.readFileSync(path.join(options.output, "RELEASE-NOTES.md"), "utf8"),
      /Built from commit aaaa/,
    );
    assert.match(
      fs.readFileSync(path.join(options.output, "INSTALL.md"), "utf8"),
      /releases\/download\/v1\.2\.3\/scope-1\.2\.3-macos-x64\.dmg/,
    );
    assert.match(
      fs.readFileSync(path.join(options.output, "INSTALL-linux.md"), "utf8"),
      /scope-1\.2\.3/,
    );
    assert.doesNotMatch(
      fs.readFileSync(path.join(options.output, "INSTALL-linux.md"), "utf8"),
      /VERSION/,
    );
    assert.equal(
      fs.readFileSync(path.join(options.output, "SHA256SUMS.txt"), "utf8").trim().split("\n")
        .length,
      files.length - 1,
    );
  }));

test("assembly rejects missing, duplicate, corrupt, and mixed-commit outputs", () => {
  for (const mutate of [
    (o) => fs.rmSync(path.join(o.input, "release-scope-macos-x64"), { recursive: true }),
    (o) =>
      fs.writeFileSync(
        path.join(o.input, "release-scope-linux-x64", "extra.AppImage"),
        "duplicate",
      ),
    (o) =>
      fs.writeFileSync(
        path.join(o.input, "release-scope-windows-x64", artifactName("1.2.3", "windows-x64")),
        "changed",
      ),
    (o) => {
      const file = path.join(o.input, "release-scope-macos-arm64", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(file));
      manifest.commit = "b".repeat(40);
      fs.writeFileSync(file, JSON.stringify(manifest));
    },
  ])
    withFixture((options) => {
      mutate(options);
      assert.throws(() => assemble(options));
    });
});
