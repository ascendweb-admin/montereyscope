"use strict";

/**
 * Packaged Linux AppImage menu integration (desktop release stage 2).
 *
 * The downloaded AppImage is a single self-contained file, but leaving it in
 * the download folder makes the application menu entry fragile and the update
 * flow unclear. "Add to application menu" copies the running AppImage into a
 * stable per-user location, installs the icon, and writes a freedesktop entry
 * that points at the managed copy.
 *
 * Everything lives under XDG paths, nothing requires root, and removal deletes
 * only files this module created. User data under `$XDG_DATA_HOME/scope`
 * (database, reports, logs, saved X login) is never touched.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const DESKTOP_ENTRY_NAME = "scope.desktop";
const PRODUCT_NAME = "Scope";
const COMMENT = "Private YouTube transcript and research dashboard";
const CATEGORIES = "AudioVideo;";
const STARTUP_WM_CLASS = "scope";

/**
 * Marks an entry installed by this application. The legacy source-tree
 * installer writes the same file name, so removal must never delete an entry
 * it did not create.
 */
const MANAGED_MARKER = "X-Scope-Managed-AppImage=true";

/** Resolves every path an integration action may read or write. */
function integrationPaths({ env = process.env, homeDir = os.homedir() } = {}) {
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(homeDir, ".local", "share");
  const applicationsDir = path.join(dataHome, "applications");
  const iconDir = path.join(dataHome, "icons", "hicolor", "512x512", "apps");
  const managedAppDir = path.join(dataHome, "scope", "app");
  return {
    dataHome,
    applicationsDir,
    desktopEntryPath: path.join(applicationsDir, DESKTOP_ENTRY_NAME),
    iconDir,
    iconPath: path.join(iconDir, "scope.png"),
    managedAppDir,
    managedExecutablePath: path.join(managedAppDir, "scope.AppImage"),
  };
}

/**
 * Quotes one Exec argument the way the Desktop Entry Specification requires:
 * always double-quoted, with backslash, double quote, backtick, dollar, and
 * percent escaped, then escaped again as a desktop-entry string value.
 * Paths containing spaces, quotes, `$`, or non-ASCII can
 * therefore never break the entry or inject desktop-entry field codes.
 */
function escapeDesktopExecArgument(value) {
  const escaped = String(value)
    .replace(/%/g, "%%")
    .replace(/([\\"`$])/g, "\\$1");
  return escapeDesktopString(`"${escaped}"`);
}

/** Escapes a value for a non-Exec desktop-entry key (Icon and friends). */
function escapeDesktopString(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

/** The runtime strips the CLI flag, but exports its extraction directory. */
function appImageExtractAndRun(env = process.env) {
  return (
    env.APPIMAGE_EXTRACT_AND_RUN !== undefined ||
    /^appimage_extracted_[a-f0-9]+$/i.test(path.basename(env.APPDIR || ""))
  );
}

function buildDesktopEntry({ executablePath, iconPath, extractAndRun = false }) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${PRODUCT_NAME}`,
    `Comment=${COMMENT}`,
    // Keep the shell program fixed; the path is a positional argument, never
    // shell source. This also supports '=' and '%' in the executable path
    // (desktop launchers may check argv[0] before expanding literal '%%').
    `Exec=/bin/sh -c ${escapeDesktopExecArgument('exec "$0" "$@"')} ${escapeDesktopExecArgument(executablePath)}${extractAndRun ? " --appimage-extract-and-run" : ""}`,
    `Icon=${escapeDesktopString(iconPath)}`,
    "Terminal=false",
    `Categories=${CATEGORIES}`,
    `StartupWMClass=${STARTUP_WM_CLASS}`,
    MANAGED_MARKER,
    "",
  ].join("\n");
}

/** Reads the current state of the shared entry file without throwing. */
function desktopEntryState(desktopEntryPath) {
  try {
    const content = fs.readFileSync(desktopEntryPath, "utf8");
    return content.split(/\r?\n/).includes(MANAGED_MARKER) ? "managed" : "foreign";
  } catch {
    return "absent";
  }
}

function integrationStatus({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  appImagePath = null,
} = {}) {
  const paths = integrationPaths({ env, homeDir });
  const state = desktopEntryState(paths.desktopEntryPath);
  const managedExists = fs.existsSync(paths.managedExecutablePath);
  return {
    supported: platform === "linux",
    runningFromAppImage: typeof appImagePath === "string" && appImagePath.length > 0,
    appImagePath: typeof appImagePath === "string" && appImagePath.length > 0 ? appImagePath : null,
    integrated: managedExists && state === "managed",
    managedExecutablePath: paths.managedExecutablePath,
    desktopEntryPath: paths.desktopEntryPath,
    desktopEntryState: state,
    iconPath: paths.iconPath,
  };
}

function assertLinux(platform) {
  if (platform !== "linux") {
    throw new Error("Application-menu integration is only available on Linux.");
  }
}

function errorWithCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Replaces a file through a same-directory temporary name so an interrupted
 * copy can never leave a truncated executable or entry behind.
 */
async function replaceFile(sourcePath, destinationPath, mode) {
  const temporary = `${destinationPath}.new-${process.pid}-${Date.now()}`;
  try {
    await fsp.copyFile(sourcePath, temporary);
    await fsp.chmod(temporary, mode);
    await fsp.rename(temporary, destinationPath);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Best-effort menu cache refresh; a missing tool is not an integration error. */
function updateDesktopDatabase(applicationsDir) {
  try {
    execFile("update-desktop-database", [applicationsDir], {
      timeout: 5_000,
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    // The entry is valid without the cache; some systems simply lack the tool.
  }
}

/**
 * Copies the running AppImage into the managed location, installs the icon,
 * and writes the menu entry. Safe to run again for an update: the executable
 * is replaced atomically and the entry keeps pointing at the same path.
 */
async function installMenuEntry({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  appImagePath,
  iconSourcePath,
  updateDatabase = updateDesktopDatabase,
} = {}) {
  assertLinux(platform);
  if (typeof appImagePath !== "string" || appImagePath.trim().length === 0) {
    throw errorWithCode(
      "not_appimage",
      "Scope is not running from a downloaded AppImage, so it cannot add itself to the application menu.",
    );
  }
  if (typeof iconSourcePath !== "string" || !fs.existsSync(iconSourcePath)) {
    throw errorWithCode("missing_icon", "The packaged application icon is missing.");
  }
  const source = path.resolve(appImagePath);
  let sourceStat;
  try {
    sourceStat = fs.statSync(source);
  } catch {
    throw errorWithCode("missing_appimage", `The downloaded AppImage was not found at ${source}.`);
  }
  if (!sourceStat.isFile()) {
    throw errorWithCode("missing_appimage", `${source} is not a file.`);
  }

  const paths = integrationPaths({ env, homeDir });
  if (desktopEntryState(paths.desktopEntryPath) === "foreign") {
    throw errorWithCode(
      "entry_conflict",
      `An existing application-menu entry at ${paths.desktopEntryPath} was not created by this app. ` +
        "Remove it first, or uninstall the source-tree launcher with packaging/install-desktop-entry.sh --uninstall.",
    );
  }

  await fsp.mkdir(paths.applicationsDir, { recursive: true });
  await fsp.mkdir(paths.iconDir, { recursive: true });
  await fsp.mkdir(paths.managedAppDir, { recursive: true });

  if (source !== paths.managedExecutablePath) {
    try {
      await replaceFile(source, paths.managedExecutablePath, 0o755);
    } catch (error) {
      throw errorWithCode(
        "copy_failed",
        `The AppImage could not be copied to ${paths.managedExecutablePath}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  } else {
    await fsp.chmod(paths.managedExecutablePath, 0o755).catch(() => {});
  }

  await replaceFile(iconSourcePath, paths.iconPath, 0o644);

  const entry = buildDesktopEntry({
    executablePath: paths.managedExecutablePath,
    iconPath: paths.iconPath,
    extractAndRun: appImageExtractAndRun(env),
  });
  const temporaryEntry = `${paths.desktopEntryPath}.new-${process.pid}-${Date.now()}`;
  try {
    await fsp.writeFile(temporaryEntry, entry, "utf8");
    await fsp.rename(temporaryEntry, paths.desktopEntryPath);
  } catch (error) {
    await fsp.rm(temporaryEntry, { force: true }).catch(() => {});
    throw errorWithCode(
      "entry_write_failed",
      `The application-menu entry could not be written: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }

  updateDatabase(paths.applicationsDir);
  return integrationStatus({ platform, env, homeDir, appImagePath: source });
}

/**
 * Removes the managed executable, icon, and menu entry. A foreign entry is
 * left in place. User data, logs, and the saved X login stay untouched.
 */
async function removeMenuEntry({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  appImagePath = null,
  updateDatabase = updateDesktopDatabase,
} = {}) {
  assertLinux(platform);
  const paths = integrationPaths({ env, homeDir });
  const state = desktopEntryState(paths.desktopEntryPath);

  if (state === "managed") {
    await fsp.rm(paths.desktopEntryPath, { force: true });
  }
  await fsp.rm(paths.managedExecutablePath, { force: true });
  await fsp.rmdir(paths.managedAppDir).catch(() => {});
  await fsp.rm(paths.iconPath, { force: true });

  if (state === "managed") {
    updateDatabase(paths.applicationsDir);
  }
  return {
    ...integrationStatus({ platform, env, homeDir, appImagePath }),
    removedEntry: state === "managed",
  };
}

module.exports = {
  COMMENT,
  DESKTOP_ENTRY_NAME,
  MANAGED_MARKER,
  PRODUCT_NAME,
  appImageExtractAndRun,
  buildDesktopEntry,
  desktopEntryState,
  escapeDesktopExecArgument,
  escapeDesktopString,
  installMenuEntry,
  integrationPaths,
  integrationStatus,
  removeMenuEntry,
  updateDesktopDatabase,
};
