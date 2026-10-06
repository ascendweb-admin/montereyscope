/**
 * Provider executable launch resolution (desktop release stage 3). Server-only.
 *
 * Every provider consumer — status, sign-in, sign-out, model discovery,
 * inference, and reports — asks this module for one launch description, so a
 * Windows machine cannot end up with status probing one installation while a
 * chat turn drives another.
 *
 * On Linux and macOS a launch is simply the requested command. On Windows,
 * native installers put a real `.exe` on the machine while npm installs leave
 * `.cmd` command wrappers behind. Node refuses to spawn `.cmd`/`.bat` files
 * without a shell (and enabling a shell for user-controlled arguments is not
 * an option), so the resolver:
 *
 *   1. prefers a native `.exe`/`.com` in the provider's own install
 *      locations or anywhere on PATH,
 *   2. otherwise reads the npm-generated command wrapper and resolves the
 *      real executable or JavaScript entry it points at,
 *   3. otherwise reports the wrapper as unresolved instead of handing an
 *      unspawnable path to a child process.
 *
 * Wrapper contents are never executed and never concatenated into a command
 * line: the parsed target becomes a single spawn argument, and JavaScript
 * entries are run through a Node executable with the script as `argsPrefix`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AiBackendId } from "./backend-id";

/** How one provider CLI is launched on this machine. */
export interface ProviderLaunch {
  /** Executable handed to spawn. */
  command: string;
  /** Arguments inserted before the provider's own arguments (script path). */
  argsPrefix: string[];
  /** Human-readable form for Settings diagnostics. */
  resolvedCommand: string;
  /** "native" executable, resolved "script" entry, or an "unresolved" wrapper. */
  kind: "native" | "script" | "unresolved";
  /** Client-safe explanation when kind is "unresolved"; otherwise null. */
  detail: string | null;
}

export interface ProviderCommandOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  exists?: (candidate: string) => boolean;
  readFile?: (file: string) => string | null;
  readDirectory?: (directory: string) => string[];
  modifiedAt?: (file: string) => number;
}

const WINDOWS_SPAWNABLE_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"] as const;
const WINDOWS_WRAPPER_EXTENSIONS = [".cmd", ".bat"] as const;
const WINDOWS_NATIVE_EXTENSIONS = [".exe", ".com"] as const;
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const JAVASCRIPT_EXTENSIONS = [".js", ".cjs", ".mjs"] as const;

function nativeLaunch(command: string, argsPrefix: readonly string[] = []): ProviderLaunch {
  const prefix = [...argsPrefix];
  return {
    command,
    argsPrefix: prefix,
    resolvedCommand: prefix.length === 0 ? command : `${command} ${prefix.join(" ")}`,
    kind: "native",
    detail: null,
  };
}

function scriptLaunch(runner: string, script: string): ProviderLaunch {
  return {
    command: runner,
    argsPrefix: [script],
    resolvedCommand: `${runner} ${script}`,
    kind: "script",
    detail: null,
  };
}

function unresolvedLaunch(candidate: string, detail: string): ProviderLaunch {
  return {
    command: candidate,
    argsPrefix: [],
    resolvedCommand: candidate,
    kind: "unresolved",
    detail,
  };
}

function defaultExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function defaultReadFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function defaultReadDirectory(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function defaultModifiedAt(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function isWindowsWrapper(candidate: string): boolean {
  return WINDOWS_WRAPPER_EXTENSIONS.some((extension) =>
    candidate.toLowerCase().endsWith(extension),
  );
}

function isWindowsNative(candidate: string): boolean {
  return WINDOWS_NATIVE_EXTENSIONS.some((extension) => candidate.toLowerCase().endsWith(extension));
}

function hasPathSeparator(candidate: string): boolean {
  return candidate.includes("/") || candidate.includes("\\");
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const key = Object.keys(env).find((entry) => entry.toLowerCase() === name.toLowerCase());
  const value = key ? env[key] : undefined;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Parsed target of an npm/Windows command wrapper (cmd-shim format). */
export interface CmdShimTarget {
  kind: "native" | "script";
  /** Real executable or JavaScript entry the wrapper invokes. */
  target: string;
  /**
   * Node executable recorded by the wrapper when it runs a script; null when
   * the wrapper only names a bare `node` command.
   */
  runner: string | null;
}

interface ParserOptions {
  exists: (candidate: string) => boolean;
}

/**
 * Reads a `.cmd`/`.bat` wrapper produced by npm's cmd-shim and returns the
 * single executable or script it invokes, or null when the file does not look
 * like a supported wrapper. Only the quoted tokens of the line that consumes
 * `%*` are considered, so comments, banners, and unrelated batch syntax can
 * never become a launch target.
 */
export function parseCmdShimTarget(
  contents: string,
  shimPath: string,
  { exists }: ParserOptions,
): CmdShimTarget | null {
  const lines = contents.split(/\r?\n/);
  const invocation = [...lines].reverse().find((line) => line.includes("%*"));
  if (invocation === undefined) {
    return null;
  }
  const shimDirectory = path.win32.dirname(shimPath);
  const expandDirectory = (token: string): string =>
    path.win32.normalize(token.replace(/%dp0%\\?|%~dp0\\?/gi, `${shimDirectory}\\`));
  const runnerAssignments = [...contents.matchAll(/SET\s+"?_prog=([^"\r\n]+)"?/gi)].map((match) =>
    expandDirectory(match[1].trim()),
  );
  const isNode = (candidate: string): boolean =>
    /^node(?:\.exe)?$/i.test(path.win32.basename(candidate));
  const recordedRunner = runnerAssignments.find(
    (candidate) => isNode(candidate) && exists(candidate),
  );

  const tokens = [...invocation.matchAll(/"([^"]*)"/g)].map((match) => match[1].trim());
  let nativeTarget: string | null = null;
  let scriptTarget: string | null = null;
  let runner: string | null = recordedRunner ?? null;
  for (const token of tokens) {
    if (token.length === 0) {
      continue;
    }
    if (/^%_prog%$/i.test(token)) {
      runner = recordedRunner ?? (runnerAssignments.some(isNode) ? "node" : null);
      continue;
    }
    const expanded = expandDirectory(token);
    if (isNode(expanded)) {
      runner = expanded;
      continue;
    }
    if (isWindowsNative(expanded) && exists(expanded)) {
      nativeTarget = expanded;
      continue;
    }
    if (
      (JAVASCRIPT_EXTENSIONS.some((extension) => expanded.toLowerCase().endsWith(extension)) ||
        // npm preserves extensionless Node bin entries (notably OpenCode).
        // Only accept these when the wrapper explicitly names a Node runner.
        (runner !== null && path.win32.extname(expanded) === "" && hasPathSeparator(expanded))) &&
      exists(expanded)
    ) {
      scriptTarget = expanded;
    }
  }
  if (nativeTarget !== null) {
    return { kind: "native", target: nativeTarget, runner: null };
  }
  if (scriptTarget !== null) {
    const resolvedRunner =
      runner !== null && runner.toLowerCase().endsWith("node.exe") && exists(runner)
        ? runner
        : null;
    return { kind: "script", target: scriptTarget, runner: resolvedRunner };
  }
  return null;
}

/** First existing path among the provider's own Windows install locations. */
function providerNativeCandidates(
  provider: AiBackendId,
  options: Required<
    Pick<ProviderCommandOptions, "env" | "homeDir" | "exists" | "readDirectory" | "modifiedAt">
  >,
): string[] {
  const { env, homeDir, exists, readDirectory, modifiedAt } = options;
  const localAppData = env.LOCALAPPDATA?.trim() || null;
  const appData = env.APPDATA?.trim() || null;
  const candidates: string[] = [];
  const newestVersioned = (base: string, name: string): string[] => {
    const versions = readDirectory(base)
      .map((entry) => path.win32.join(base, entry, name))
      .filter((candidate) => exists(candidate))
      .sort((left, right) => modifiedAt(right) - modifiedAt(left));
    return versions.slice(0, 1);
  };

  if (provider === "claude") {
    candidates.push(path.win32.join(homeDir, ".local", "bin", "claude.exe"));
    if (appData) {
      candidates.push(path.win32.join(appData, "npm", "claude.exe"));
    }
    if (localAppData) {
      candidates.push(path.win32.join(localAppData, "Microsoft", "WinGet", "Links", "claude.exe"));
    }
  } else if (provider === "opencode") {
    candidates.push(path.win32.join(homeDir, ".opencode", "bin", "opencode.exe"));
    if (localAppData) {
      candidates.push(path.win32.join(localAppData, "opencode", "bin", "opencode.exe"));
      candidates.push(
        path.win32.join(localAppData, "Microsoft", "WinGet", "Links", "opencode.exe"),
      );
    }
  } else {
    candidates.push(path.win32.join(homeDir, ".local", "bin", "codex.exe"));
    candidates.push(path.win32.join(homeDir, ".codex", "bin", "codex.exe"));
    candidates.push(
      ...newestVersioned(
        path.win32.join(homeDir, ".codex", "packages", "standalone", "releases"),
        path.win32.join("bin", "codex.exe"),
      ),
    );
    if (localAppData) {
      candidates.push(
        ...newestVersioned(
          path.win32.join(localAppData, "Programs", "OpenAI", "Codex", "bin"),
          "codex.exe",
        ),
      );
    }
  }
  return candidates.filter((candidate) => exists(candidate));
}

interface WindowsSearchOptions {
  exists: (candidate: string) => boolean;
  env: NodeJS.ProcessEnv;
  readDirectory?: (directory: string) => string[];
}

/**
 * Searches PATH for a spawnable Windows entry. Real executables anywhere on
 * PATH win over wrappers in an earlier directory: the whole point is to reach
 * the provider's native binary rather than a batch shim. Directory listings
 * restore the on-disk casing (PATHEXT is conventionally uppercase).
 */
function findOnWindowsPath(
  name: string,
  { exists, env, readDirectory }: WindowsSearchOptions,
): string | null {
  const pathValue = environmentValue(env, "PATH");
  if (pathValue === null) {
    return null;
  }
  const pathext = environmentValue(env, "PATHEXT") ?? DEFAULT_PATHEXT;
  const extensions = name.includes(".")
    ? [""]
    : pathext
        .split(";")
        .map((extension) => extension.trim())
        .filter((extension) =>
          WINDOWS_SPAWNABLE_EXTENSIONS.some((known) => extension.toLowerCase() === known),
        );
  const directories = pathValue
    .split(";")
    .map((directory) => directory.trim())
    .filter((directory) => directory.length > 0);
  const natives: string[] = [];
  const wrappers: string[] = [];
  for (const directory of directories) {
    const entries = readDirectory?.(directory) ?? null;
    for (const extension of extensions.length > 0 ? extensions : [""]) {
      const requested = `${name}${extension}`;
      const candidate = path.win32.join(directory, requested);
      if (!exists(candidate)) {
        continue;
      }
      const actualName = entries?.find((entry) => entry.toLowerCase() === requested.toLowerCase());
      const resolved =
        actualName === undefined ? candidate : path.win32.join(directory, actualName);
      if (isWindowsNative(resolved)) {
        natives.push(resolved);
      } else if (isWindowsWrapper(resolved)) {
        wrappers.push(resolved);
      }
    }
  }
  return natives[0] ?? wrappers[0] ?? null;
}

function resolveNodeRunner(
  recorded: string | null,
  options: Required<Pick<ProviderCommandOptions, "env" | "homeDir" | "exists" | "readDirectory">>,
): string | null {
  const { env, homeDir, exists, readDirectory } = options;
  if (recorded !== null) {
    if (hasPathSeparator(recorded) && exists(recorded)) {
      return recorded;
    }
    const onPath = findOnWindowsPath(recorded, { exists, env, readDirectory });
    if (onPath !== null) {
      return onPath;
    }
  }
  const located = findOnWindowsPath("node", { exists, env, readDirectory });
  if (located !== null) {
    return located;
  }
  const conventional = [
    env.ProgramFiles && path.win32.join(env.ProgramFiles, "nodejs", "node.exe"),
    env["ProgramFiles(x86)"] && path.win32.join(env["ProgramFiles(x86)"], "nodejs", "node.exe"),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs", "nodejs", "node.exe"),
    path.win32.join(homeDir, "AppData", "Local", "Programs", "nodejs", "node.exe"),
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  return conventional.find((candidate) => exists(candidate)) ?? null;
}

function resolveWindowsWrapper(
  wrapperPath: string,
  options: Required<
    Pick<ProviderCommandOptions, "env" | "homeDir" | "exists" | "readFile" | "readDirectory">
  >,
): ProviderLaunch {
  const contents = options.readFile(wrapperPath);
  const target =
    contents === null
      ? null
      : parseCmdShimTarget(contents, wrapperPath, { exists: options.exists });
  if (target === null) {
    return unresolvedLaunch(
      wrapperPath,
      `The Windows command wrapper ${wrapperPath} could not be resolved to a real executable. ` +
        "Install the native build or set the provider executable path in Settings.",
    );
  }
  if (target.kind === "native") {
    return nativeLaunch(target.target);
  }
  const runner = resolveNodeRunner(target.runner, options);
  if (runner === null) {
    return unresolvedLaunch(
      target.target,
      `The Windows command wrapper ${wrapperPath} runs a JavaScript entry with Node.js, ` +
        "which was not found. Install Node.js, use the provider's native installer, or set " +
        "the provider executable path in Settings.",
    );
  }
  return scriptLaunch(runner, target.target);
}

function resolveWindowsConfigured(
  requested: string,
  options: Required<
    Pick<ProviderCommandOptions, "env" | "homeDir" | "exists" | "readFile" | "readDirectory">
  >,
): ProviderLaunch {
  if (hasPathSeparator(requested)) {
    if (isWindowsWrapper(requested) && options.exists(requested)) {
      return resolveWindowsWrapper(requested, options);
    }
    return nativeLaunch(requested);
  }
  // A bare configured name (for example "codex.cmd") still comes from PATH.
  const located = findOnWindowsPath(requested, {
    exists: options.exists,
    env: options.env,
    readDirectory: options.readDirectory,
  });
  if (located !== null && isWindowsWrapper(located)) {
    return resolveWindowsWrapper(located, options);
  }
  return nativeLaunch(located ?? requested);
}

function resolveWindowsAuto(
  provider: AiBackendId,
  options: Required<
    Pick<
      ProviderCommandOptions,
      "env" | "homeDir" | "exists" | "readFile" | "readDirectory" | "modifiedAt"
    >
  >,
): ProviderLaunch {
  const native = providerNativeCandidates(provider, options)[0];
  if (native !== undefined) {
    return nativeLaunch(native);
  }
  const located = findOnWindowsPath(provider, {
    exists: options.exists,
    env: options.env,
    readDirectory: options.readDirectory,
  });
  if (located === null) {
    // Nothing on PATH: keep the bare name so a spawn probe reports the
    // provider as missing rather than misreporting a resolution failure.
    return nativeLaunch(provider);
  }
  if (isWindowsWrapper(located)) {
    return resolveWindowsWrapper(located, options);
  }
  return nativeLaunch(located);
}

/**
 * Resolves one provider launch. `requested` is the explicit environment or
 * Settings override when one exists, otherwise the provider's bare command
 * name. `configured` says whether the user pinned the value; pinned paths are
 * respected exactly while automatic discovery prefers native executables and
 * resolves wrappers.
 */
export function resolveProviderLaunch(
  provider: AiBackendId,
  requested: string,
  options: ProviderCommandOptions & { configured?: boolean } = {},
): ProviderLaunch {
  const platform = options.platform ?? process.platform;
  const trimmed = requested.trim();
  if (platform !== "win32") {
    return nativeLaunch(trimmed);
  }
  const resolved = {
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? os.homedir(),
    exists: options.exists ?? defaultExists,
    readFile: options.readFile ?? defaultReadFile,
    readDirectory: options.readDirectory ?? defaultReadDirectory,
    modifiedAt: options.modifiedAt ?? defaultModifiedAt,
  };
  if (options.configured === true || hasPathSeparator(trimmed)) {
    return resolveWindowsConfigured(trimmed, resolved);
  }
  return resolveWindowsAuto(provider, resolved);
}
