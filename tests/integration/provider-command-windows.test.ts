/*
 * Windows provider process launching (desktop release stage 3).
 *
 * Runs only on Windows CI: it writes real npm-style `.cmd` command wrappers
 * into a disposable directory with spaces and non-ASCII characters, resolves
 * them through the shared provider-command module, and spawns the result with
 * the real adapters. It proves a wrapper is never executed by a shell, that a
 * native executable wins over a wrapper in the same directory, and that the
 * resolved launch reaches the codex inference adapter.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createNodeCodexSpawner, runCodex } from "@/lib/ai/codex";
import { resolveProviderLaunch } from "@/lib/ai/provider-command";

const windowsOnly = describe.skipIf(process.platform !== "win32");

let toolsRoot = "";
let markerPath = "";

beforeAll(() => {
  toolsRoot = mkdtempSync(path.join(os.tmpdir(), "scope tëst provider tools "));
  markerPath = path.join(toolsRoot, "wrapper-was-executed.txt");
});

afterAll(() => {
  rmSync(toolsRoot, { recursive: true, force: true });
});

function writeScript(name: string, contents: string): string {
  const file = path.join(toolsRoot, name);
  writeFileSync(file, contents, "utf8");
  return file;
}

/** npm cmd-shim output with a shebang-less JavaScript bin entry. */
function npmScriptShim(scriptPath: string, extraBatch?: string): string {
  const relative = path.win32.relative(toolsRoot, scriptPath);
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    ...(extraBatch ? [extraBatch] : []),
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\${relative}" %*`,
    "",
  ].join("\r\n");
}

function writeWrapper(name: string, scriptPath: string, extraBatch?: string): string {
  const wrapper = path.join(toolsRoot, `${name}.cmd`);
  writeFileSync(wrapper, npmScriptShim(scriptPath, extraBatch), "utf8");
  return wrapper;
}

function environmentWithTools(): NodeJS.ProcessEnv {
  // A Windows environment often spells this "Path". Passing both Path and
  // PATH makes Node/resolvers pick the first key and silently lose our fixture.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
  );
  return { ...env, NODE_ENV: process.env.NODE_ENV, PATH: `${toolsRoot};${process.env.PATH ?? ""}` };
}

windowsOnly("Windows wrapper resolution and launching", () => {
  it("resolves an npm script wrapper and spawns the script, never the batch file", async () => {
    const script = writeScript(
      "fake-codex.js",
      [
        'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "win-thread" }) + "\\n");',
        'process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "hello from wrapper" } }) + "\\n");',
        'process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }) + "\\n");',
        "",
      ].join("\n"),
    );
    // If the wrapper itself were executed (a shell), this line would create
    // the marker file; the resolved script must run instead.
    writeWrapper("fake-codex", script, `echo executed > "${markerPath.replace(/"/g, '""')}"`);

    const launch = resolveProviderLaunch("codex", "fake-codex", {
      env: environmentWithTools(),
      configured: true,
    });
    expect(launch.kind).toBe("script");
    expect(launch.command.toLowerCase()).toMatch(/node(\.exe)?$/);
    expect(launch.argsPrefix).toEqual([script]);
    expect(existsSync(markerPath)).toBe(false);

    const run = runCodex({
      prompt: "Summarize.",
      workDir: toolsRoot,
      command: launch.command,
      commandArgs: launch.argsPrefix,
      spawner: createNodeCodexSpawner(),
    });
    const result = await run.completed;
    expect(result.sessionId).toBe("win-thread");
    expect(result.finalMessage).toBe("hello from wrapper");
    // The batch body still must not have run as a shell script.
    expect(existsSync(markerPath)).toBe(false);
    expect(readFileSync(script, "utf8")).toContain("thread.started");
  });

  it("prefers a native executable over a wrapper in the same directory", () => {
    const nativeSource = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "hostname.exe",
    );
    const native = path.join(toolsRoot, "fake-opencode.exe");
    writeFileSync(native, readFileSync(nativeSource));
    writeScript("fake-opencode.js", 'console.log("script should not run");');
    writeWrapper("fake-opencode", path.join(toolsRoot, "fake-opencode.js"));

    const launch = resolveProviderLaunch("opencode", "fake-opencode", {
      env: environmentWithTools(),
      configured: true,
    });
    expect(launch.kind).toBe("native");
    expect(launch.command).toBe(native);
    expect(launch.argsPrefix).toEqual([]);
    expect(
      execFileSync(launch.command, launch.argsPrefix, { encoding: "utf8", shell: false })
        .trim()
        .toLowerCase(),
    ).toBe(os.hostname().toLowerCase());
  });

  it("reports an unrecognizable wrapper instead of spawning it", () => {
    const wrapper = path.join(toolsRoot, "broken-provider.cmd");
    writeFileSync(wrapper, "@echo off\r\nsome-other-command %*\r\n", "utf8");
    const launch = resolveProviderLaunch("claude", "broken-provider", {
      env: environmentWithTools(),
      configured: true,
    });
    expect(launch.kind).toBe("unresolved");
    expect(launch.detail).toContain("could not be resolved");
  });
});
