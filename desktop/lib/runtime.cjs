"use strict";

const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const LOOPBACK_HOST = "127.0.0.1";
const DESKTOP_AUTH_HEADER = "x-scope-desktop-token";

function allocateLoopbackPort(host = LOOPBACK_HOST) {
  return new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.unref();
    reservation.once("error", reject);
    reservation.listen(0, host, () => {
      const address = reservation.address();
      if (!address || typeof address === "string") {
        reservation.close();
        reject(new Error("Could not reserve a loopback port."));
        return;
      }
      reservation.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function desktopUserDataPath({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  packaged = false,
} = {}) {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const override = env.SCOPE_DESKTOP_USER_DATA?.trim();
  if (override) {
    return platformPath.resolve(override);
  }

  const directoryName = packaged ? "scope" : "scope-desktop-dev";
  if (platform === "win32") {
    const base = env.LOCALAPPDATA?.trim() || platformPath.join(homeDir, "AppData", "Local");
    return platformPath.join(base, directoryName);
  }
  if (platform === "darwin") {
    return platformPath.join(homeDir, "Library", "Application Support", directoryName);
  }
  const base = env.XDG_DATA_HOME?.trim() || platformPath.join(homeDir, ".local", "share");
  return platformPath.join(base, directoryName);
}

/**
 * True for a mise shim directory. Invoking a shim for a tool that is not
 * installed makes mise download and install it, regardless of mise's
 * auto-install settings, so shim directories never reach the backend PATH.
 */
function isMiseShimDirectory(entry, platformPath) {
  const trimmed = entry.replace(/[\\/]+$/, "");
  const name = platformPath.basename(trimmed).toLowerCase();
  const parent = platformPath.basename(platformPath.dirname(trimmed)).toLowerCase();
  return name === "shims" && parent === "mise";
}

function executablePath({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const current = (env[pathKey] || "")
    .split(platformPath.delimiter)
    .filter(Boolean)
    .filter((entry) => !isMiseShimDirectory(entry, platformPath));
  const additions =
    platform === "win32"
      ? [
          env.APPDATA && platformPath.join(env.APPDATA, "npm"),
          platformPath.join(homeDir, "scoop", "shims"),
          env.LOCALAPPDATA && platformPath.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"),
          // Native provider installers place per-user binaries here; a
          // packaged app started from the Start menu may predate the PATH
          // change, so scope adds the locations itself.
          platformPath.join(homeDir, ".local", "bin"),
          platformPath.join(homeDir, ".opencode", "bin"),
          platformPath.join(homeDir, ".codex", "bin"),
          env.ProgramFiles && platformPath.join(env.ProgramFiles, "nodejs"),
          env.LOCALAPPDATA && platformPath.join(env.LOCALAPPDATA, "Programs", "nodejs"),
        ]
      : platform === "darwin"
        ? [
            platformPath.join(homeDir, ".local", "bin"),
            // Apple Silicon Homebrew and Intel Homebrew; a Finder launch does
            // not source shell startup files, so these must be explicit.
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
          ]
        : [
            platformPath.join(homeDir, ".local", "bin"),
            // mise shims are deliberately absent: spawning a shim for a tool
            // that is not installed makes mise download and install it, and the
            // shim shell wrapper can hang headless. Provider resolvers ask
            // `mise where`/`mise which` for the real binary instead.
            platformPath.join(homeDir, ".nix-profile", "bin"),
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
          ];

  const seen = new Set();
  return [...additions, ...current]
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .filter((entry) => {
      const key = platform === "win32" ? entry.toLowerCase() : entry;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .join(platformPath.delimiter);
}

function backendEnvironment({
  baseEnv = process.env,
  dataRoot,
  token,
  port,
  bundledYtDlpPath,
  development = false,
}) {
  if (!path.isAbsolute(dataRoot)) {
    throw new Error("The desktop data root must be absolute.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The desktop server port is invalid.");
  }
  if (typeof token !== "string" || token.length < 32) {
    throw new Error("The desktop server token is invalid.");
  }

  const env = Object.fromEntries(
    Object.entries(baseEnv).filter((entry) => typeof entry[1] === "string"),
  );
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  // The smoke harness must also isolate the backend and its subprocesses.
  // Normal desktop launches still discover tools installed outside the shell PATH.
  const minimalSmoke =
    baseEnv.SCOPE_DESKTOP_SMOKE === "1" && baseEnv.SCOPE_DESKTOP_SMOKE_MINIMAL_PATH === "1";
  env[pathKey] = minimalSmoke ? baseEnv[pathKey] || "" : executablePath({ env: baseEnv });
  env.HOSTNAME = LOOPBACK_HOST;
  env.PORT = String(port);
  env.NODE_ENV = development ? "development" : "production";
  env.NEXT_TELEMETRY_DISABLED = "1";
  // Provider probes must never install a provider. Mise shims are kept off
  // the desktop PATH; these guards cover shims inherited from a user shell
  // and a mise config that lists uninstalled providers: resolution reports
  // "not found" instead of downloading (auto_install covers `mise where`,
  // exec_auto_install covers shim execution, not_found covers a bare shim).
  env.MISE_AUTO_INSTALL = "false";
  env.MISE_EXEC_AUTO_INSTALL = "false";
  env.MISE_NOT_FOUND_AUTO_INSTALL = "false";
  env.SCOPE_DESKTOP = "1";
  env.SCOPE_DESKTOP_TOKEN = token;
  env.SCOPE_DB_PATH = baseEnv.SCOPE_DB_PATH?.trim() || path.join(dataRoot, "localtube.db");
  env.SCOPE_AI_JOBS_ROOT = baseEnv.SCOPE_AI_JOBS_ROOT?.trim() || path.join(dataRoot, "ai-jobs");
  if (!baseEnv.SCOPE_YTDLP_PATH?.trim() && bundledYtDlpPath) {
    env.SCOPE_YTDLP_PATH = bundledYtDlpPath;
  }
  return env;
}

function requestHealth(origin, token, timeoutMs = 2_000, onResult = () => {}) {
  return new Promise((resolve, reject) => {
    const target = new URL("/api/ready", origin);
    const request = http.request(
      target,
      {
        method: "GET",
        headers: { [DESKTOP_AUTH_HEADER]: token },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 65_536) {
            request.destroy(new Error("Health response exceeded its size limit."));
          }
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            onResult({
              status: response.statusCode,
              app: parsed?.app?.status ?? null,
              database: parsed?.database?.connected ?? null,
            });
            resolve(
              (response.statusCode === 200 || response.statusCode === 503) &&
                parsed?.app?.name === "scope" &&
                parsed?.app?.status === "ready" &&
                parsed?.database?.connected === true,
            );
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Health request timed out."));
    });
    request.once("error", reject);
    request.end();
  });
}

async function waitForBackend({ origin, token, timeoutMs, isAlive = () => true }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let lastResult = null;
  while (Date.now() < deadline) {
    if (!isAlive()) {
      throw new Error("The desktop backend exited before it became ready.", {
        cause: lastError,
      });
    }
    try {
      if (
        await requestHealth(origin, token, 2_000, (result) => {
          lastResult = result;
        })
      ) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const detail = lastResult
    ? ` Last health: HTTP ${lastResult.status}, app=${lastResult.app}, database=${lastResult.database}.`
    : lastError
      ? ` Last probe: ${lastError.message}.`
      : "";
  throw new Error(`The desktop backend did not become ready within ${timeoutMs}ms.${detail}`, {
    cause: lastError,
  });
}

function isInternalUrl(candidate, origin) {
  try {
    return new URL(candidate).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function isSafeExternalUrl(candidate) {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(candidate).protocol);
  } catch {
    return false;
  }
}

module.exports = {
  DESKTOP_AUTH_HEADER,
  LOOPBACK_HOST,
  allocateLoopbackPort,
  backendEnvironment,
  desktopUserDataPath,
  executablePath,
  isInternalUrl,
  isSafeExternalUrl,
  requestHealth,
  waitForBackend,
};
