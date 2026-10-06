"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  assertBinaryMatchesTarget,
  readMachOMinimumOS,
  resolveTarget,
} = require("../lib/target.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const version = fs.readFileSync(path.join(desktopRoot, "yt-dlp-version.txt"), "utf8").trim();
const target = resolveTarget();
const targetPlatform = target.platform;
const targetArch = target.arch;
const asset = { remote: target.ytDlpRemote, local: target.ytDlpLocal };

const releaseRoot = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}`;
const sourceRoot = `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${version}`;

async function download(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "scope-desktop-build" },
  });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  // The standalone executables contain third-party code, including GPLv3+
  // components. Keep the pinned release's full upstream notices beside the
  // binary in every packaged application.
  const noticesRoot = path.join(desktopRoot, "vendor", "yt-dlp-notices");
  fs.mkdirSync(noticesRoot, { recursive: true });
  for (const name of ["LICENSE", "THIRD_PARTY_LICENSES.txt"]) {
    const content = await download(`${sourceRoot}/${name}`);
    if (
      content.length < 100 ||
      (name === "THIRD_PARTY_LICENSES.txt" &&
        !content.toString("utf8", 0, 100).includes("THIRD-PARTY LICENSES"))
    ) {
      throw new Error(`Pinned yt-dlp notice ${name} is unexpectedly incomplete.`);
    }
    fs.writeFileSync(path.join(noticesRoot, name), content);
  }
  const sums = (await download(`${releaseRoot}/SHA2-256SUMS`)).toString("utf8");
  const expectedLine = sums
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.endsWith(`  ${asset.remote}`) || line.endsWith(` *${asset.remote}`));
  if (!expectedLine) {
    throw new Error(`The release checksum list has no entry for ${asset.remote}.`);
  }
  const expectedHash = expectedLine.split(/\s+/)[0].toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error(`The release checksum for ${asset.remote} is malformed.`);
  }

  const vendorRoot = path.join(desktopRoot, "vendor");
  const destination = path.join(vendorRoot, asset.local);
  fs.mkdirSync(vendorRoot, { recursive: true });
  if (fs.existsSync(destination)) {
    const existing = fs.readFileSync(destination);
    if (sha256(existing) === expectedHash) {
      if (targetPlatform !== "win32") {
        fs.chmodSync(destination, 0o755);
      }
      reportBinary();
      console.log(`Bundled yt-dlp ${version} is already verified.`);
      return;
    }
  }

  const binary = await download(`${releaseRoot}/${asset.remote}`);
  const actualHash = sha256(binary);
  if (actualHash !== expectedHash) {
    throw new Error(
      `yt-dlp checksum mismatch: expected ${expectedHash}, downloaded ${actualHash}.`,
    );
  }

  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, binary, { mode: targetPlatform === "win32" ? 0o644 : 0o755 });
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  reportBinary();
  console.log(`Downloaded and verified yt-dlp ${version} for ${targetPlatform}/${targetArch}.`);
}

/**
 * Rejects an asset whose header does not contain the target architecture
 * (the macOS asset is universal2, which assertBinaryMatchesTarget accepts)
 * and records the slice's minimum macOS version for the release notes.
 */
function reportBinary() {
  const destination = path.join(desktopRoot, "vendor", asset.local);
  assertBinaryMatchesTarget(destination, target);
  if (targetPlatform === "darwin") {
    const minimum = readMachOMinimumOS(destination, target.arch);
    console.log(`Bundled yt-dlp ${target.label} slice minimum macOS: ${minimum ?? "unknown"}.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
