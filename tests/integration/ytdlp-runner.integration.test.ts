/**
 * Integration tests for the yt-dlp process boundary (lib/ytdlp/runner.ts).
 *
 * These spawn REAL child processes via the fake yt-dlp executable — no
 * mocks — so they pin down the behavior unit tests can only approximate:
 * exact argv passing, stdout/stderr capture, output-limit kills on modern
 * Node (ERR_CHILD_PROCESS_STDIO_MAXBUFFER), timeout termination, and the
 * concurrency gate wiring. No network access and no installed yt-dlp
 * binary are required.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createExecutionGate } from "@/lib/ytdlp/gate";
import { runCommand, setCommandExecutionGate } from "@/lib/ytdlp/runner";

const FAKE_YTDLP = path.join(__dirname, "fake-yt-dlp.cjs");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  // Fresh default gate per test; individual tests may inject their own.
  setCommandExecutionGate(null);
});

afterEach(() => {
  setCommandExecutionGate(null);
});

describe("runCommand against a real process", () => {
  it("delivers the exact argument array to the process (no shell interpolation)", async () => {
    const logPath = path.join(makeTempDir("localtube-argv-"), "argv.jsonl");
    process.env.FAKE_YTDLP_LOG = logPath;

    const hostile = 'he said "run $(rm -rf /); & nothing"';
    const result = await runCommand(
      FAKE_YTDLP,
      [
        "--dump-single-json",
        "--extractor-args",
        `youtubetab:x=${hostile}`,
        "https://example.invalid/@h",
      ],
      { timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 },
    );

    expect(result.ok).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual([
      "--dump-single-json",
      "--extractor-args",
      `youtubetab:x=${hostile}`,
      "https://example.invalid/@h",
    ]);

    delete process.env.FAKE_YTDLP_LOG;
  });

  it("reports the fake tool version on --version", async () => {
    const result = await runCommand(FAKE_YTDLP, ["--version"], {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout.trim()).toBe("2026.08.19-fake");
      expect(result.stderr).toBe("");
    }
  });

  it("maps a genuinely missing executable to missing_executable", async () => {
    const result = await runCommand(path.join(makeTempDir("localtube-empty-"), "nope"), [], {
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("missing_executable");
    }
  });

  it("captures nonzero exit codes and bounds the stderr tail", async () => {
    const result = await runCommand(FAKE_YTDLP, ["localtube-fail-network"], {
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("nonzero_exit");
      expect(result.exitCode).toBe(1);
      expect(result.stderrTail).toContain("getaddrinfo");
      expect(result.stderrTail.length).toBeLessThanOrEqual(4000);
    }
  });

  it("terminates hung processes and reports a typed timeout", async () => {
    const startedAt = Date.now();
    const result = await runCommand(
      FAKE_YTDLP,
      ["https://example.invalid/watch?v=localtube-hang"],
      {
        timeoutMs: 500,
        maxOutputBytes: 1024 * 1024,
      },
    );
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("timeout");
      expect(result.signal).toBe("SIGTERM");
    }
    // The hard timeout must actually fire well before this test's own limit.
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);

  it("classifies oversized stdout as output_limit on this Node runtime", async () => {
    // Regression guard for Node ≥22's ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
    const result = await runCommand(FAKE_YTDLP, ["localtube-huge-output"], {
      timeoutMs: 15_000,
      maxOutputBytes: 1024 * 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("output_limit");
    }
  }, 20_000);

  it("classifies oversized stderr as output_limit too", async () => {
    const result = await runCommand(FAKE_YTDLP, ["localtube-huge-stderr"], {
      timeoutMs: 15_000,
      maxOutputBytes: 1024 * 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("output_limit");
    }
  }, 20_000);

  it("routes every spawn through the injected execution gate", async () => {
    let active = 0;
    let peak = 0;
    const inner = createExecutionGate(2);
    const countingGate = {
      run<T>(task: () => Promise<T>): Promise<T> {
        // Count only while the task actually executes under inner's
        // capacity — not while it sits queued.
        return inner.run(() => {
          active += 1;
          peak = Math.max(peak, active);
          return task().finally(() => {
            active -= 1;
          });
        });
      },
      get activeCount() {
        return inner.activeCount;
      },
      get queuedCount() {
        return inner.queuedCount;
      },
    };
    setCommandExecutionGate(countingGate);

    await Promise.all(
      Array.from({ length: 6 }, () =>
        runCommand(FAKE_YTDLP, ["--version"], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 }),
      ),
    );

    expect(peak).toBe(2);
    expect(countingGate.activeCount).toBe(0);
    expect(countingGate.queuedCount).toBe(0);
  });
});
