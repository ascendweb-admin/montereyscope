"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { macSigningPlan } = require("./mac-signing.cjs");
const { windowsSigningPlan } = require("./windows-signing.cjs");

const projectRoot = path.resolve(__dirname, "..", "..");
const targets = Object.freeze({
  "linux-x64": {
    platform: "linux",
    arch: "x64",
    label: "Omarchy Linux x64",
    extension: "AppImage",
    guide: "linux-install.md",
  },
  "windows-x64": {
    platform: "win32",
    arch: "x64",
    label: "Windows x64",
    extension: "exe",
    guide: "windows-install.md",
  },
  "macos-arm64": {
    platform: "darwin",
    arch: "arm64",
    label: "Mac — Apple Silicon",
    extension: "dmg",
    guide: "macos-install.md",
  },
  "macos-x64": {
    platform: "darwin",
    arch: "x64",
    label: "Mac — Intel",
    extension: "dmg",
    guide: "macos-install.md",
  },
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function artifactName(version, key) {
  return `scope-${version}-${key}${key === "windows-x64" ? "-setup" : ""}.${targets[key].extension}`;
}
function validateVersion(root, tag) {
  assert(
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag),
    `Expected a vX.Y.Z release tag, got ${tag}`,
  );
  const version = tag.slice(1);
  for (const rel of [
    "package.json",
    "desktop/package.json",
    "package-lock.json",
    "desktop/package-lock.json",
  ]) {
    const metadata = readJson(path.join(root, rel));
    assert(
      metadata.version === version,
      `${rel} version ${metadata.version} does not match ${tag}`,
    );
    if (rel.endsWith("package-lock.json")) {
      assert(
        metadata.packages?.[""]?.version === version,
        `${rel} root package version does not match ${tag}`,
      );
      const manifest = readJson(path.join(root, rel.replace("package-lock.json", "package.json")));
      assert(
        metadata.name === manifest.name && metadata.packages[""].name === manifest.name,
        `${rel} package name does not match its manifest`,
      );
    }
  }
  return version;
}
function validateCommit(root, commit) {
  assert(/^[0-9a-f]{40}$/.test(commit), `Expected a full commit SHA, got ${commit}`);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert(head === commit, `Checked-out commit ${head} does not match release commit ${commit}`);
  const changed = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert(
    changed === "",
    "Release checkout has tracked changes; commit the exact source before building",
  );
}
function targetKey(platform, arch) {
  const match = Object.entries(targets).find(
    ([, target]) => target.platform === platform && target.arch === arch,
  );
  assert(match, `Unsupported release target ${platform}/${arch}`);
  return match[0];
}
function signingMode(key, env) {
  if (key.startsWith("macos-")) return macSigningPlan(env).mode;
  if (key === "windows-x64") return windowsSigningPlan(env).mode;
  return "not-applicable";
}
function stage({ root, tag, commit, platform, arch, env = process.env }) {
  const version = validateVersion(root, tag);
  validateCommit(root, commit);
  const key = targetKey(platform, arch);
  const dist = path.join(root, "desktop", "dist");
  const name = artifactName(version, key);
  const matching = fs
    .readdirSync(dist)
    .filter((entry) => entry.endsWith(`.${targets[key].extension}`));
  assert(
    matching.length === 1 && matching[0] === name,
    `Expected only ${name} in desktop/dist; found ${matching.join(", ") || "none"}`,
  );
  const source = path.join(dist, name);
  assert(
    fs.statSync(source).isFile() && fs.statSync(source).size > 0,
    `Empty or missing release asset ${name}`,
  );
  const destination = path.join(dist, "release-stage");
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(source, path.join(destination, name));
  const manifest = {
    tag,
    version,
    commit,
    key,
    artifact: name,
    sha256: sha256(source),
    signing: signingMode(key, env),
  };
  fs.writeFileSync(
    path.join(destination, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
function assemble({ root, input, output, tag, commit, repository }) {
  const version = validateVersion(root, tag);
  assert(/^[0-9a-f]{40}$/.test(commit), "A full release commit SHA is required");
  assert(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
    `Invalid GitHub repository ${repository}`,
  );
  const ytDlpVersion = fs
    .readFileSync(path.join(root, "desktop", "yt-dlp-version.txt"), "utf8")
    .trim();
  const notices = fs.readFileSync(
    path.join(root, "docs", "desktop-third-party-notices.md"),
    "utf8",
  );
  assert(
    notices.includes(ytDlpVersion),
    `Third-party notice review does not name pinned yt-dlp ${ytDlpVersion}`,
  );
  const expectedFolders = Object.keys(targets)
    .map((key) => `release-scope-${key}`)
    .sort();
  const actualFolders = fs.readdirSync(input).sort();
  assert(
    JSON.stringify(actualFolders) === JSON.stringify(expectedFolders),
    `Release transport set differs: expected ${expectedFolders.join(", ")}; found ${actualFolders.join(", ")}`,
  );
  const manifests = [];
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  for (const key of Object.keys(targets)) {
    const folder = path.join(input, `release-scope-${key}`);
    const name = artifactName(version, key);
    const entries = fs.readdirSync(folder).sort();
    assert(
      JSON.stringify(entries) === JSON.stringify(["manifest.json", name].sort()),
      `${key}: expected only manifest.json and ${name}; found ${entries.join(", ")}`,
    );
    const manifest = readJson(path.join(folder, "manifest.json"));
    assert(
      manifest.tag === tag &&
        manifest.version === version &&
        manifest.commit === commit &&
        manifest.key === key &&
        manifest.artifact === name,
      `${key}: manifest tag/version/commit/target mismatch`,
    );
    const allowedSigning =
      key === "linux-x64"
        ? ["not-applicable"]
        : key === "windows-x64"
          ? ["signed", "unsigned-friends-beta"]
          : ["signed-notarized", "unsigned-engineering"];
    assert(
      allowedSigning.includes(manifest.signing),
      `${key}: invalid signing mode ${manifest.signing}`,
    );
    assert(sha256(path.join(folder, name)) === manifest.sha256, `${key}: checksum mismatch`);
    fs.copyFileSync(path.join(folder, name), path.join(output, name));
    manifests.push(manifest);
  }
  for (const [source, name] of [
    ["docs/linux-install.md", "INSTALL-linux.md"],
    ["docs/windows-install.md", "INSTALL-windows.md"],
    ["docs/macos-install.md", "INSTALL-macos.md"],
    ["docs/desktop-third-party-notices.md", "THIRD-PARTY-NOTICES.md"],
  ]) {
    const content = fs.readFileSync(path.join(root, source), "utf8");
    fs.writeFileSync(
      path.join(output, name),
      name.startsWith("INSTALL-") ? content.replaceAll("VERSION", version) : content,
    );
  }
  const link = (name) => `https://github.com/${repository}/releases/download/${tag}/${name}`;
  const lines = [
    `# Scope ${version}`,
    "",
    `Built from commit ${commit}. This is a draft for owner review; it has not passed the clean-machine acceptance matrix.`,
    "",
    "## Downloads",
    "",
    ...manifests.map(
      (m) =>
        `- **${targets[m.key].label}**: [${m.artifact}](${link(m.artifact)}) — SHA-256 ${m.sha256}`,
    ),
    "",
    "[Installation and update instructions](" +
      link("INSTALL.md") +
      ") · [Third-party notices](" +
      link("THIRD-PARTY-NOTICES.md") +
      ")",
    "",
    "## Verification status",
    "",
    "All four native build jobs must pass their automated checks before this draft is assembled. The actual downloaded installers, platform minimums, provider accounts, Windows signing/SmartScreen, and Mac Gatekeeper/Keychain still require the Stage 7 clean-machine review. Do not publish until the owner records those results.",
    "",
    ...manifests.map((m) => `- ${targets[m.key].label}: build signing mode ${m.signing}.`),
    "",
    "An unsigned Mac engineering DMG is unsuitable for distribution. Windows unsigned friends-beta status must be explicitly accepted before publication.",
    "",
    "Do not replace published binaries under this version. Make a new version and tag for any changed release.",
    "",
  ];
  fs.writeFileSync(path.join(output, "RELEASE-NOTES.md"), lines.join("\n"));
  const install = [
    "# Install and update Scope",
    "",
    "Choose the download for your operating system and chip:",
    "",
    ...manifests.map(
      (m) =>
        `- **${targets[m.key].label}**: [download](${link(m.artifact)}) · [instructions](${link(`INSTALL-${m.key.startsWith("macos") ? "macos" : m.key.startsWith("windows") ? "windows" : "linux"}.md`)})`,
    ),
    "",
    "Quit Scope before replacing it. Back up the closed app's data directory before upgrading. Saved X sessions are encrypted for the original machine and are not a portable backup. A database migration may make an older Scope version unable to read the data.",
    "",
  ];
  fs.writeFileSync(path.join(output, "INSTALL.md"), install.join("\n"));
  const files = fs
    .readdirSync(output)
    .filter((name) => name !== "SHA256SUMS.txt")
    .sort();
  fs.writeFileSync(
    path.join(output, "SHA256SUMS.txt"),
    files.map((name) => `${sha256(path.join(output, name))}  ${name}`).join("\n") + "\n",
  );
  return manifests;
}
function option(args, name) {
  const i = args.indexOf(`--${name}`);
  assert(i >= 0 && args[i + 1], `Missing --${name}`);
  return args[i + 1];
}
if (require.main === module) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "validate") {
      validateVersion(projectRoot, option(args, "tag"));
      validateCommit(projectRoot, option(args, "commit"));
    } else if (command === "stage") {
      console.log(
        stage({
          root: projectRoot,
          tag: option(args, "tag"),
          commit: option(args, "commit"),
          platform: process.env.SCOPE_DESKTOP_TARGET_PLATFORM,
          arch: process.env.SCOPE_DESKTOP_TARGET_ARCH,
        }),
      );
    } else if (command === "assemble") {
      console.log(
        assemble({
          root: projectRoot,
          input: path.resolve(option(args, "input")),
          output: path.resolve(option(args, "output")),
          tag: option(args, "tag"),
          commit: option(args, "commit"),
          repository: option(args, "repository"),
        }),
      );
    } else throw new Error(`Unknown release command: ${command}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { artifactName, assemble, stage, targetKey, validateVersion };
