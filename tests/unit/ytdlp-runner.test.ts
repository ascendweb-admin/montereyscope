import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import { runCommand } from "@/lib/ytdlp/runner";

function nodeError(props: Record<string, unknown>): Error & Record<string, unknown> {
  return Object.assign(new Error(String(props.message ?? "command failed")), props);
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe("runCommand", () => {
  it("passes an argument array (never a shell string) and maps limits to execFile options", async () => {
    execFileMock.mockImplementation((_file, _args, options, cb) => {
      cb(null, "ok", "");
    });

    const result = await runCommand("yt-dlp", ["--version"], {
      timeoutMs: 1234,
      maxOutputBytes: 4096,
    });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFileMock.mock.calls[0];
    expect(file).toBe("yt-dlp");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual(["--version"]);
    // The command is never routed through a shell.
    expect(options.shell).toBeUndefined();
    expect(options.timeout).toBe(1234);
    expect(options.maxBuffer).toBe(4096);
    expect(result).toEqual({ ok: true, stdout: "ok", stderr: "" });
  });

  it("maps a timeout kill to a typed timeout failure", async () => {
    execFileMock.mockImplementation((_file, _args, _options, cb) => {
      cb(
        nodeError({ killed: true, signal: "SIGTERM", message: "spawn killed" }),
        "",
        "partial output",
      );
    });

    const result = await runCommand("yt-dlp", ["--dump-single-json", "url"], {
      timeoutMs: 100,
      maxOutputBytes: 1024,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("timeout");
      expect(result.signal).toBe("SIGTERM");
      expect(result.stderrTail).toBe("partial output");
    }
  });

  it("maps ENOENT to missing_executable", async () => {
    execFileMock.mockImplementation((_file, _args, _options, cb) => {
      cb(nodeError({ code: "ENOENT", message: "spawn ENOENT" }), "", "");
    });

    const result = await runCommand("missing-binary", [], {
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("missing_executable");
    }
  });

  it("maps ENOBUFS to output_limit", async () => {
    execFileMock.mockImplementation((_file, _args, _options, cb) => {
      cb(nodeError({ code: "ENOBUFS", message: "maxBuffer exceeded" }), "", "");
    });

    const result = await runCommand("yt-dlp", [], { timeoutMs: 1000, maxOutputBytes: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("output_limit");
    }
  });

  it("maps Node ≥22 ERR_CHILD_PROCESS_STDIO_MAXBUFFER to output_limit, not spawn_failed", async () => {
    // Verified against Node v26: maxBuffer overflow sets this string code and
    // leaves `killed` unset, so it must be matched explicitly.
    execFileMock.mockImplementation((_file, _args, _options, cb) => {
      cb(
        nodeError({
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          message: "stdout maxBuffer length exceeded",
        }),
        "",
        "",
      );
    });

    const result = await runCommand("yt-dlp", [], { timeoutMs: 1000, maxOutputBytes: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("output_limit");
    }
  });

  it("maps numeric exit codes to nonzero_exit with captured stderr tail", async () => {
    const longStderr = "x".repeat(10_000) + "THE-END";
    execFileMock.mockImplementation((_file, _args, _options, cb) => {
      cb(nodeError({ code: 1, message: "exited with code 1" }), "stdout so far", longStderr);
    });

    const result = await runCommand("yt-dlp", ["--version"], {
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("nonzero_exit");
      expect(result.exitCode).toBe(1);
      // Bounded tail only — never the full buffer.
      expect(result.stderrTail.length).toBeLessThanOrEqual(4000);
      expect(result.stderrTail.endsWith("THE-END")).toBe(true);
    }
  });

  it("falls back to spawn_failed for unrecognized string error codes", async () => {
    execFileMock.mockImplementation((_file, _args, _options, cb) => {
      cb(nodeError({ code: "WEIRD", message: "unknown failure" }), "", "");
    });

    const result = await runCommand("yt-dlp", [], { timeoutMs: 1000, maxOutputBytes: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("spawn_failed");
    }
  });
});
