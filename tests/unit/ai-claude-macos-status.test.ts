import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getClaudeAuthStatus } from "@/lib/ai/auth/claude-login";
import { execFileStatus } from "@/lib/ai/auth/exec";
import { AuthManager } from "@/lib/ai/auth/manager";

vi.mock("@/lib/ai/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/claude")>()),
  resolveClaudeLaunch: vi.fn(async () => ({
    command: "claude",
    argsPrefix: [],
    resolvedCommand: "claude",
    kind: "native",
    detail: null,
  })),
}));

vi.mock("@/lib/ai/auth/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/auth/exec")>()),
  execFileStatus: vi.fn(),
}));

const probe = vi.mocked(execFileStatus);
const version = { ran: true, exitCode: 0, stdout: "2.1.241 (Claude Code)", stderr: "" };
const signedIn = {
  ran: true,
  exitCode: 0,
  stdout: JSON.stringify({ loggedIn: true, authMethod: "oauth" }),
  stderr: "",
};
const unreadable = { ran: true, exitCode: 1, stdout: "", stderr: "Keychain unavailable" };

function platform(value: NodeJS.Platform) {
  vi.stubGlobal("process", { ...process, platform: value });
}

beforeEach(() => {
  probe.mockReset();
  platform("darwin");
});

afterEach(() => vi.unstubAllGlobals());

describe("macOS Claude connection checks", () => {
  it("allows a slower CLI startup and Keychain status check", async () => {
    probe.mockResolvedValueOnce(version).mockResolvedValueOnce(signedIn);
    expect(await getClaudeAuthStatus()).toMatchObject({ authenticated: true, subscription: true });
    expect(probe.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [["--version"], 15_000],
      [["auth", "status", "--json"], 30_000],
    ]);
  });

  it.each([
    { ...version, exitCode: 1, failure: "timeout" as const },
    { ...version, exitCode: 1, failure: "spawn_failed" as const },
    { ...version, exitCode: 1 },
    { ...version, stdout: "" },
    { ran: false, exitCode: null, stdout: "", stderr: "", failure: "timeout" as const },
  ])("reports an unavailable version probe as unknown, not signed out: %j", async (result) => {
    probe.mockResolvedValueOnce(result);
    expect(await getClaudeAuthStatus()).toMatchObject({ statusError: true });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("still reports a genuinely missing executable", async () => {
    probe.mockResolvedValueOnce({
      ran: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      failure: "missing_executable",
    });
    const status = await getClaudeAuthStatus();
    expect(status.installed).toBe(false);
    expect(status.statusError).toBeUndefined();
  });

  it.each([
    unreadable,
    { ...signedIn, exitCode: 1 },
    { ...signedIn, exitCode: 1, failure: "timeout" as const },
    { ...signedIn, ran: false, exitCode: null, failure: "spawn_failed" as const },
  ])("keeps failed status checks out of the signed-out path: %j", async (result) => {
    probe.mockResolvedValueOnce(version).mockResolvedValueOnce(result);
    const manager = new AuthManager();
    try {
      const status = await manager.getProviderSnapshot("claude");
      expect(status.statusError).toMatchObject({ code: "status_unavailable" });
      expect(status.statusError?.message).toContain("may still be signed in");
      expect(status.attempt).toBeNull();
      expect(probe.mock.calls.every((call) => !call[1].includes("logout"))).toBe(true);
    } finally {
      manager.dispose();
    }
  });

  it("accepts an explicit signed-out response with the CLI's exit code 1", async () => {
    probe.mockResolvedValueOnce(version).mockResolvedValueOnce({
      ran: true,
      exitCode: 1,
      stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }),
      stderr: "",
    });
    const manager = new AuthManager();
    try {
      expect(await manager.getProviderSnapshot("claude")).toMatchObject({
        installed: true,
        authenticated: false,
        statusError: null,
      });
    } finally {
      manager.dispose();
    }
  });

  it("recovers on Check again without starting a new login", async () => {
    probe
      .mockResolvedValueOnce(version)
      .mockResolvedValueOnce(unreadable)
      .mockResolvedValueOnce(version)
      .mockResolvedValueOnce(signedIn);
    const manager = new AuthManager();
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      expect((await manager.getProviderSnapshot("claude")).statusError).not.toBeNull();
      now.mockReturnValue(2_001);
      expect(await manager.getProviderSnapshot("claude")).toMatchObject({
        authenticated: true,
        subscription: true,
        statusError: null,
        attempt: null,
      });
    } finally {
      now.mockRestore();
      manager.dispose();
    }
  });

  it("does not let model discovery treat a failed check as a confirmed logout", async () => {
    probe.mockResolvedValueOnce(version).mockResolvedValueOnce(unreadable);
    const manager = new AuthManager();
    try {
      await expect(manager.getCatalogConnection("claude")).rejects.toThrow(
        "Could not check Claude connection",
      );
    } finally {
      manager.dispose();
    }
  });

  it.each(["linux", "win32"] as const)(
    "leaves %s connection handling and deadlines unchanged",
    async (value) => {
      platform(value);
      probe.mockResolvedValueOnce(version).mockResolvedValueOnce(unreadable);
      const manager = new AuthManager();
      try {
        expect(await manager.getProviderSnapshot("claude")).toMatchObject({
          authenticated: false,
          statusError: null,
        });
        expect(probe.mock.calls.map((call) => call[2])).toEqual([4_000, 10_000]);
      } finally {
        manager.dispose();
      }
    },
  );
});
