"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { packagedResourcesDirectory } = require("./lib/bundle-layout.cjs");
const { materializeExternalLinks } = require("./lib/materialize-bundle-links.cjs");
const {
  describeWindowsSigning,
  normalizeWindowsSigningEnvironment,
  windowsSigningPlan,
} = require("./scripts/windows-signing.cjs");

const projectRoot = path.resolve(__dirname, "..");
const ytDlpName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
const targetPlatform = process.env.SCOPE_DESKTOP_TARGET_PLATFORM || process.platform;
const windowsBuild = targetPlatform === "win32";
const macBuild = targetPlatform === "darwin";
const requireSigning = ["1", "true", "yes"].includes(
  (process.env.SCOPE_DESKTOP_WINDOWS_REQUIRE_SIGNING || "").toLowerCase(),
);

// Fails early when signing is required but no CI secrets are present, and
// prints the explicit signed/unsigned-friends-beta mode for Windows builds.
if (windowsBuild) {
  const plan = windowsSigningPlan(process.env);
  normalizeWindowsSigningEnvironment();
  console.warn(describeWindowsSigning(plan));
}

// Private Monterey test copy: no signing identity or notarization is used.
// The main project retains its Electron 44 release configuration.
if (macBuild) {
  console.warn("macOS Intel Monterey test build: unsigned, unnotarized, installer unverified.");
}

function copyStandaloneRuntime(context) {
  const source = path.join(projectRoot, process.env.SCOPE_NEXT_DIST_DIR || ".next", "standalone");
  const destination = path.join(packagedResourcesDirectory(context), "app-server");

  const requiredSourceFiles = [
    path.join(source, "server.js"),
    path.join(source, "node_modules", "next", "package.json"),
    path.join(source, "node_modules", "better-sqlite3", "package.json"),
  ];

  for (const requiredFile of requiredSourceFiles) {
    if (!fs.existsSync(requiredFile)) {
      throw new Error(`Standalone runtime is incomplete: ${requiredFile}`);
    }
  }

  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    force: true,
  });
  materializeExternalLinks(destination, [source, path.join(projectRoot, "node_modules")]);

  if (!fs.existsSync(path.join(destination, "node_modules", "next", "package.json"))) {
    throw new Error("Packaged standalone runtime is missing its Node.js dependencies");
  }

  // Defense in depth behind next.config.ts tracing excludes: the server never
  // reads the checkout's desktop build output or the developer's data
  // directory, and packaged copies of them must never ship.
  for (const forbidden of ["desktop", "data"]) {
    fs.rmSync(path.join(destination, forbidden), { recursive: true, force: true });
  }
}

module.exports = {
  appId: "com.scope.desktop",
  productName: "scope",
  electronVersion: "43.7.7",
  asar: true,
  compression: "maximum",
  npmRebuild: false,
  directories: {
    output: "dist",
    buildResources: "assets",
  },
  files: ["main.cjs", "preload.cjs", "loading.html", "lib/**/*", "package.json"],
  extraResources: [
    { from: path.join(__dirname, "vendor", "x-worker"), to: "x-worker" },
    {
      from: path.join(__dirname, "vendor", ytDlpName),
      to: path.join("bin", ytDlpName),
    },
    {
      from: path.join(__dirname, "assets", "icon.png"),
      to: "icon.png",
    },
    { from: path.join(__dirname, "vendor", "yt-dlp-notices"), to: "licenses/yt-dlp" },
  ],
  afterPack: copyStandaloneRuntime,
  linux: {
    target: ["AppImage"],
    category: "AudioVideo",
    executableName: "scope",
    syncDesktopName: true,
    icon: "assets/icon.png",
    synopsis: "Private YouTube transcript and research dashboard",
    description:
      "Save creators, extract captions locally, and research cached transcripts with optional local AI tools.",
  },
  appImage: {
    // Explicit target in the download name; electron-builder's raw ${arch}
    // would produce x86_64, while the release table promises linux-x64.
    artifactName: "scope-${version}-linux-x64.${ext}",
    compression: "gzip",
    // electron-builder's default desktop entry passes --no-sandbox, which
    // disables Chromium's sandbox for anyone using AppImage integration tools.
    // An empty list keeps the sandbox on; AppRun still falls back to
    // --no-sandbox only where unprivileged user namespaces are unavailable.
    executableArgs: [],
  },
  win: {
    target: ["nsis"],
    executableName: "scope",
    icon: "assets/icon.ico",
    // Explicit target in the download name from the release table.
    artifactName: "scope-${version}-windows-x64-setup.${ext}",
    // Electron-builder signs automatically when CSC_LINK/CSC_KEY_PASSWORD
    // (or the WIN_ variants) are present; the require flag turns a missing
    // signature into a build failure once the owner provides credentials.
    forceCodeSigning: windowsBuild && requireSigning,
  },
  mac: {
    target: ["dmg"],
    category: "public.app-category.video",
    artifactName: "scope-${version}-macos-x64-monterey-claude-fix.${ext}",
    // Candidate floor for this private test; no installer verification runs.
    minimumSystemVersion: "12.0",
    darkModeSupport: true,
    identity: null,
    forceCodeSigning: false,
    hardenedRuntime: false,
    notarize: false,
  },
  dmg: {
    artifactName: "scope-${version}-macos-x64-monterey-claude-fix.${ext}",
    // Standard drag-to-Applications layout: the app and an /Applications
    // shortcut side by side.
    contents: [
      { x: 130, y: 220, type: "file" },
      { x: 410, y: 220, type: "link", path: "/Applications" },
    ],
  },
  nsis: {
    oneClick: false,
    // Per-user installer: the ordinary path is %LOCALAPPDATA%\Programs\scope
    // and needs no administrator rights.
    perMachine: false,
    // With perMachine false and oneClick false electron-builder still shows
    // the install-mode page; refusing elevation keeps the per-machine option
    // disabled unless the installer is already running elevated.
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    // FRESH_INSTALL: created on first install, never recreated after the user
    // deletes it, so the desktop shortcut stays optional.
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "scope",
    uninstallDisplayName: "scope",
    deleteAppDataOnUninstall: false,
  },
};
