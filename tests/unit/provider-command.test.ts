/*
 * Windows-aware provider launch resolution (desktop release stage 3).
 *
 * Offline: the tests inject a virtual Windows filesystem and environment, so a
 * Linux or macOS CI runner still proves the resolution rules — native
 * executables beat command wrappers, npm cmd-shims resolve to their real
 * target, JavaScript entries get a Node runner, and unresolvable wrappers are
 * reported instead of being treated as executables.
 */
import { describe, expect, it } from "vitest";

import { parseCmdShimTarget, resolveProviderLaunch } from "@/lib/ai/provider-command";

const HOME = "C:\\Users\\Ana Pérez";
const NPM = `${HOME}\\AppData\\Roaming\\npm`;

interface FakeFilesystem {
  files: Record<string, string>;
  directories?: Record<string, string[]>;
  mtimes?: Record<string, number>;
}

/** Builds resolver options over a case-insensitive Windows path map. */
function windowsOptions({ files, directories = {}, mtimes = {} }: FakeFilesystem) {
  const fileKeys = new Map(Object.keys(files).map((key) => [key.toLowerCase(), key]));
  const listings = new Map<string, string[]>([
    ...Object.keys(directories).map(
      (key) => [key.toLowerCase(), directories[key]] as [string, string[]],
    ),
  ]);
  for (const file of Object.keys(files)) {
    const separator = file.lastIndexOf("\\");
    if (separator <= 0) {
      continue;
    }
    const parent = file.slice(0, separator);
    const entry = file.slice(separator + 1);
    const key = parent.toLowerCase();
    listings.set(key, [...(listings.get(key) ?? []), entry]);
  }
  const mtimeKeys = new Map(Object.keys(mtimes).map((key) => [key.toLowerCase(), key]));
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: `${NPM};C:\\Program Files\\nodejs`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    APPDATA: `${HOME}\\AppData\\Roaming`,
    LOCALAPPDATA: `${HOME}\\AppData\\Local`,
    ProgramFiles: "C:\\Program Files",
  };
  return {
    platform: "win32" as const,
    env,
    homeDir: HOME,
    exists: (candidate: string) => fileKeys.has(candidate.toLowerCase()),
    readFile: (file: string) => {
      const key = fileKeys.get(file.toLowerCase());
      return key === undefined ? null : files[key];
    },
    readDirectory: (directory: string) => {
      for (const [key, entries] of listings) {
        if (key === directory.toLowerCase()) {
          return entries;
        }
      }
      return [];
    },
    modifiedAt: (file: string) => {
      const key = mtimeKeys.get(file.toLowerCase());
      return key === undefined ? 0 : mtimes[key];
    },
  };
}

/** npm cmd-shim output for a JavaScript `bin` entry (shebang `node`). */
function npmScriptShim(relativeTarget: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\${relativeTarget}" %*`,
    "",
  ].join("\r\n");
}

/** npm cmd-shim output for a Windows executable `bin` entry (no shebang). */
function npmExecutableShim(relativeTarget: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%dp0%\\${relativeTarget}" %*`,
    "",
  ].join("\r\n");
}

describe("non-Windows resolution", () => {
  it("passes the requested command through unchanged", () => {
    const launch = resolveProviderLaunch("codex", "codex", { platform: "linux" });
    expect(launch).toEqual({
      command: "codex",
      argsPrefix: [],
      resolvedCommand: "codex",
      kind: "native",
      detail: null,
    });
    expect(
      resolveProviderLaunch("claude", "/opt/tools/claude", { platform: "darwin" }).command,
    ).toBe("/opt/tools/claude");
  });
});

describe("Windows native executables", () => {
  it("finds the claude native installer without touching PATH", () => {
    const claude = `${HOME}\\.local\\bin\\claude.exe`;
    const launch = resolveProviderLaunch(
      "claude",
      "claude",
      windowsOptions({ files: { [claude]: "MZ" } }),
    );
    expect(launch.kind).toBe("native");
    expect(launch.command).toBe(claude);
  });

  it("prefers a native executable over a wrapper earlier on PATH", () => {
    const wrapper = `${NPM}\\codex.cmd`;
    const native = `${HOME}\\.codex\\packages\\standalone\\releases\\0.155.1\\bin\\codex.exe`;
    const launch = resolveProviderLaunch(
      "codex",
      "codex",
      windowsOptions({
        files: {
          [wrapper]: npmScriptShim("node_modules\\@openai\\codex\\bin\\codex.js"),
          [native]: "MZ",
        },
        directories: {
          [`${HOME}\\.codex\\packages\\standalone\\releases`]: ["0.155.1"],
        },
      }),
    );
    expect(launch.kind).toBe("native");
    expect(launch.command).toBe(native);
  });

  it("picks the newest versioned Codex standalone install", () => {
    const base = `${HOME}\\.codex\\packages\\standalone\\releases`;
    const older = `${base}\\0.150.0\\bin\\codex.exe`;
    const newer = `${base}\\0.155.1\\bin\\codex.exe`;
    const launch = resolveProviderLaunch(
      "codex",
      "codex",
      windowsOptions({
        files: { [older]: "MZ", [newer]: "MZ" },
        directories: { [base]: ["0.150.0", "0.155.1"] },
        mtimes: { [older]: 100, [newer]: 200 },
      }),
    );
    expect(launch.command).toBe(newer);
  });

  it("finds an .exe on PATH when no install location matches", () => {
    const native = "C:\\Program Files\\nodejs\\opencode.exe";
    const launch = resolveProviderLaunch(
      "opencode",
      "opencode",
      windowsOptions({ files: { [native]: "MZ" } }),
    );
    expect(launch.kind).toBe("native");
    expect(launch.command).toBe(native);
  });
});

describe("Windows command wrappers", () => {
  it("resolves OpenCode's extensionless npm Node entry", () => {
    const shim = `${NPM}\\opencode.cmd`;
    const script = `${NPM}\\node_modules\\opencode-ai\\bin\\opencode`;
    const node = "C:\\Program Files\\nodejs\\node.exe";
    const launch = resolveProviderLaunch(
      "opencode",
      "opencode",
      windowsOptions({
        files: {
          [shim]: npmScriptShim("node_modules\\opencode-ai\\bin\\opencode"),
          [script]: "#!/usr/bin/env node",
          [node]: "MZ",
        },
      }),
    );
    expect(launch.kind).toBe("script");
    expect(launch.command).toBe(node);
    expect(launch.argsPrefix).toEqual([script]);
  });

  it("does not interpret arbitrary extensionless wrapper targets as Node scripts", () => {
    const shim = `${NPM}\\opencode.cmd`;
    for (const contents of [
      npmExecutableShim("node_modules\\opencode-ai\\bin\\opencode"),
      npmScriptShim("node_modules\\opencode-ai\\bin\\opencode").replaceAll("node", "python"),
    ]) {
      expect(parseCmdShimTarget(contents, shim, { exists: () => true })).toBeNull();
    }
  });

  it("keeps a directly quoted Node runner separate from its script", () => {
    const shim = `${NPM}\\opencode.cmd`;
    const script = `${NPM}\\bin\\opencode`;
    const node = `${NPM}\\node.exe`;
    expect(
      parseCmdShimTarget('"%dp0%\\node.exe" "%dp0%\\bin\\opencode" %*', shim, {
        exists: (candidate) => [script, node].includes(candidate),
      }),
    ).toEqual({ kind: "script", target: script, runner: node });
  });

  it("resolves an npm JavaScript shim to node plus the real script", () => {
    const shim = `${NPM}\\codex.cmd`;
    const script = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`;
    const node = "C:\\Program Files\\nodejs\\node.exe";
    const launch = resolveProviderLaunch(
      "codex",
      "codex",
      windowsOptions({
        files: {
          [shim]: npmScriptShim("node_modules\\@openai\\codex\\bin\\codex.js"),
          [script]: "#!/usr/bin/env node",
          [node]: "MZ",
        },
      }),
    );
    expect(launch.kind).toBe("script");
    expect(launch.command).toBe(node);
    expect(launch.argsPrefix).toEqual([script]);
    expect(launch.resolvedCommand).toContain("node.exe");
    expect(launch.resolvedCommand).toContain("codex.js");
  });

  it("uses node.exe next to the wrapper when npm shipped one", () => {
    const shim = `${NPM}\\codex.cmd`;
    const script = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`;
    const bundledNode = `${NPM}\\node.exe`;
    const launch = resolveProviderLaunch(
      "codex",
      "codex",
      windowsOptions({
        files: {
          [shim]: npmScriptShim("node_modules\\@openai\\codex\\bin\\codex.js"),
          [script]: "#!/usr/bin/env node",
          [bundledNode]: "MZ",
        },
      }),
    );
    expect(launch.command).toBe(bundledNode);
    expect(launch.argsPrefix).toEqual([script]);
  });

  it("resolves an npm shim that points straight at a native executable", () => {
    const shim = `${NPM}\\opencode.cmd`;
    const target = `${NPM}\\node_modules\\opencode-ai\\bin\\opencode.exe`;
    const launch = resolveProviderLaunch(
      "opencode",
      "opencode",
      windowsOptions({
        files: {
          [shim]: npmExecutableShim("node_modules\\opencode-ai\\bin\\opencode.exe"),
          [target]: "MZ",
        },
      }),
    );
    expect(launch.kind).toBe("native");
    expect(launch.command).toBe(target);
    expect(launch.argsPrefix).toEqual([]);
  });

  it("resolves an explicitly configured wrapper path", () => {
    const shim = `${HOME}\\Downloads\\my tools\\claude.cmd`;
    const target = `${HOME}\\Downloads\\my tools\\claude.exe`;
    const launch = resolveProviderLaunch("claude", shim, {
      configured: true,
      ...windowsOptions({ files: { [shim]: npmExecutableShim("claude.exe"), [target]: "MZ" } }),
    });
    expect(launch.kind).toBe("native");
    expect(launch.command).toBe(target);
  });

  it("reports a JavaScript wrapper as unresolved when Node is missing", () => {
    const shim = `${NPM}\\codex.cmd`;
    const script = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`;
    const options = windowsOptions({
      files: {
        [shim]: npmScriptShim("node_modules\\@openai\\codex\\bin\\codex.js"),
        [script]: "#!/usr/bin/env node",
      },
    });
    options.env.PATH = `${NPM};C:\\Windows\\System32`;
    const launch = resolveProviderLaunch("codex", "codex", options);
    expect(launch.kind).toBe("unresolved");
    expect(launch.detail).toContain("Node.js");
    expect(launch.argsPrefix).toEqual([]);
  });

  it("reports an unrecognizable wrapper instead of spawning it", () => {
    const shim = `${NPM}\\codex.cmd`;
    const launch = resolveProviderLaunch(
      "codex",
      "codex",
      windowsOptions({ files: { [shim]: "@echo off\r\nsome-other-command %*\r\n" } }),
    );
    expect(launch.kind).toBe("unresolved");
    expect(launch.detail).toContain("could not be resolved");
    expect(launch.command).toBe(shim);
  });

  it("ignores quoted tokens that do not name an existing file", () => {
    const shim = `${HOME}\\tools\\codex.cmd`;
    const contents = [
      "@echo off",
      'IF EXIST "%dp0%\\missing.exe" (',
      '  SET "_prog=%dp0%\\missing.exe"',
      ")",
      'endLocal & "%_prog%" "%dp0%\\also-missing.js" %*',
    ].join("\r\n");
    expect(parseCmdShimTarget(contents, shim, { exists: () => false })).toBeNull();
  });
});

describe("wrapper parsing never builds a shell command", () => {
  it("returns single path tokens rather than a command line", () => {
    const shim = `${NPM}\\codex.cmd`;
    const script = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`;
    const node = `${NPM}\\node.exe`;
    const target = parseCmdShimTarget(
      npmScriptShim("node_modules\\@openai\\codex\\bin\\codex.js"),
      shim,
      { exists: (candidate) => [script, node].includes(candidate) },
    );
    expect(target).toEqual({ kind: "script", target: script, runner: node });
    // The script path is one argument; shell metacharacters would need a shell
    // to matter, and no launch site ever uses one.
    expect(target?.target).not.toMatch(/[&|<>]/);
  });

  it("does not treat unrelated batch syntax as a target", () => {
    const shim = `${NPM}\\codex.cmd`;
    const contents = [
      "@ECHO off",
      "GOTO start",
      ":start",
      "echo starting something",
      'SET "OTHER=cmd.exe"',
      'goto #_undefined_# 2>NUL || "%OTHER%" %*',
    ].join("\r\n");
    expect(parseCmdShimTarget(contents, shim, { exists: () => true })).toBeNull();
  });
});
