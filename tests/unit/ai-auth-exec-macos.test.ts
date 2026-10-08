import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileStatus } from "@/lib/ai/auth/exec";

afterEach(() => vi.unstubAllGlobals());

describe("macOS status probe failures", () => {
  it("identifies an actual deadline kill, including partial JSON output", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const result = await execFileStatus(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify({loggedIn:true})); setInterval(() => {}, 1000)"],
      300,
    );
    expect(result.failure).toBe("timeout");
    expect(result.exitCode).not.toBe(0);
  });

  it("distinguishes an absent CLI from a timed out one", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(await execFileStatus("/tmp/scope-no-such-claude-executable", [], 300)).toMatchObject({
      ran: false,
      failure: "missing_executable",
    });
  });

  it("leaves Linux result metadata unchanged", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    expect(await execFileStatus("/tmp/scope-no-such-claude-executable", [], 300)).toEqual({
      ran: false,
      exitCode: null,
      stdout: "",
      stderr: "",
    });
  });
});
