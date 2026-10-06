"use strict";

/**
 * Post-package AppImage validation (desktop release stage 2). Extracts the
 * built AppImage with its own runtime (no FUSE needed) and checks the layout,
 * native dependencies, bundled tools, icon, and desktop entry that a
 * downloaded Linux release actually ships.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { assertBinaryMatchesTarget, resolveTarget } = require("../lib/target.cjs");
const { verifyXWorker } = require("../lib/worker-artifacts.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const target = resolveTarget();
const failures = [];

function check(label, fn) {
  try {
    fn();
    console.log(`ok - ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : error}`);
    console.error(`not ok - ${label}`);
  }
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function requireFile(file, description) {
  if (!fs.existsSync(file)) {
    throw new Error(`${description} is missing: ${path.relative(desktopRoot, file)}`);
  }
  return file;
}

function appImagePath() {
  const version = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  ).version;
  return path.join(desktopRoot, "dist", `scope-${version}-linux-x64.AppImage`);
}

function extractAppImage(artifact, root) {
  const result = spawnSync(artifact, ["--appimage-extract"], {
    cwd: root,
    encoding: "utf8",
    // Extraction prints one line per bundled file.
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `AppImage extraction failed (${result.error?.code || result.status}): ${result.stderr || ""}`,
    );
  }
  const extracted = path.join(root, "squashfs-root");
  if (!fs.existsSync(extracted)) {
    throw new Error("AppImage extraction produced no squashfs-root directory.");
  }
  return extracted;
}

function main() {
  if (target.platform !== "linux") {
    throw new Error(`AppImage verification is Linux-only; current target is ${target.label}.`);
  }
  const artifact = appImagePath();
  if (!fs.existsSync(artifact)) {
    throw new Error(
      `The versioned Linux artifact is missing: ${path.relative(desktopRoot, artifact)}. ` +
        "Build it with npm --prefix desktop run dist:linux.",
    );
  }

  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scope-appimage-extract-"));
  try {
    const extracted = extractAppImage(artifact, extractionRoot);
    const resources = path.join(extracted, "resources");
    check("bundled yt-dlp notices are present", () => {
      for (const name of ["LICENSE", "THIRD_PARTY_LICENSES.txt"]) {
        requireFile(path.join(resources, "licenses", "yt-dlp", name), `yt-dlp ${name}`);
      }
    });
    check("bundled Node.js notices are present", () => {
      requireFile(
        path.join(resources, "app-server", "THIRD_PARTY_NOTICES.md"),
        "Node.js runtime notices",
      );
    });

    check("AppImage carries the generated desktop entry", () => {
      const entry = fs.readFileSync(
        requireFile(path.join(extracted, "scope.desktop"), "Desktop entry"),
        "utf8",
      );
      const keys = new Map();
      for (const line of entry.split(/\r?\n/)) {
        const separator = line.indexOf("=");
        if (separator > 0) {
          keys.set(line.slice(0, separator), line.slice(separator + 1));
        }
      }
      if (entry.split(/\r?\n/)[0] !== "[Desktop Entry]") {
        throw new Error("Desktop entry does not start with the [Desktop Entry] group");
      }
      if (keys.get("Type") !== "Application") {
        throw new Error("Desktop entry Type is not Application");
      }
      if (!keys.get("Name")) {
        throw new Error("Desktop entry has no Name key");
      }
      if (!keys.get("Exec")?.includes("AppRun")) {
        throw new Error("Desktop entry Exec does not launch AppRun");
      }
      if (keys.get("Exec")?.includes("--no-sandbox")) {
        throw new Error("Desktop entry disables the Chromium sandbox");
      }
      if (!keys.get("Icon")) {
        throw new Error("Desktop entry has no Icon key");
      }
      if (!keys.get("Categories")?.includes("AudioVideo")) {
        throw new Error("Desktop entry Categories does not include AudioVideo");
      }
    });

    check("launcher and icon are installed at the AppDir root", () => {
      const appRun = path.join(extracted, "AppRun");
      requireFile(appRun, "AppRun launcher");
      if ((fs.statSync(appRun).mode & 0o111) === 0) {
        throw new Error("AppRun is not executable");
      }
      const icon = path.join(extracted, "scope.png");
      requireFile(icon, "AppDir icon");
      if (sha256(icon) !== sha256(path.join(desktopRoot, "assets", "icon.png"))) {
        throw new Error("AppDir icon does not match desktop/assets/icon.png");
      }
    });

    check("packaged Electron executable matches the target", () => {
      const executable = requireFile(path.join(extracted, "scope"), "Electron executable");
      assertBinaryMatchesTarget(executable, target);
    });

    check("standalone server and SQLite runtime match the target", () => {
      requireFile(path.join(resources, "app-server", "server.js"), "Next.js standalone server");
      for (const forbidden of ["desktop", "data", "tests", "docs"]) {
        if (fs.existsSync(path.join(resources, "app-server", forbidden))) {
          throw new Error(`Packaged app-server wrongly includes ${forbidden}/`);
        }
      }
      const prebuild = path.join(
        resources,
        "app-server",
        "node_modules",
        "better-sqlite3",
        "prebuilds",
        `${target.betterSqlite3Prebuild}.node`,
      );
      requireFile(prebuild, `better-sqlite3 ${target.label} prebuild`);
      assertBinaryMatchesTarget(prebuild, target);
      requireFile(
        path.join(
          resources,
          "app-server",
          "node_modules",
          "@anthropic-ai",
          "claude-agent-sdk",
          "sdk.mjs",
        ),
        "Claude Agent SDK trace",
      );
    });

    check("bundled yt-dlp matches the target", () => {
      const asset = requireFile(path.join(resources, "bin", target.ytDlpLocal), "bundled yt-dlp");
      if ((fs.statSync(asset).mode & 0o111) === 0) {
        throw new Error("bundled yt-dlp is not executable");
      }
      assertBinaryMatchesTarget(asset, target);
    });

    check("bundled icon matches desktop/assets/icon.png", () => {
      const icon = requireFile(path.join(resources, "icon.png"), "packaged icon");
      if (sha256(icon) !== sha256(path.join(desktopRoot, "assets", "icon.png"))) {
        throw new Error("packaged icon does not match desktop/assets/icon.png");
      }
    });

    check("bundled X worker matches the target and its sources", () => {
      verifyXWorker({
        source: path.join(desktopRoot, "x-worker"),
        output: path.join(resources, "x-worker"),
        target,
      });
    });
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`AppImage verification failed for ${target.label}:`);
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`AppImage verified for ${target.label}: ${path.relative(projectRoot, artifact)}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
