import { describe, expect, it, vi } from "vitest";
import { AuthManager } from "@/lib/ai/auth/manager";
import type { CodexAccountClient } from "@/lib/ai/auth/codex-account-client";

function fakeClient() {
  return {
    onNotification: vi.fn<(handler: (method: string, params: unknown) => void) => () => void>(
      () => () => {},
    ),
    readAccount: vi.fn(
      async (): Promise<{
        account: { type: "chatgpt"; email: null; planType: string } | null;
        requiresOpenaiAuth: boolean;
      }> => ({ account: null, requiresOpenaiAuth: true }),
    ),
    onExit: vi.fn(),
    startBrowserLogin: vi.fn(async () => ({
      loginId: "login",
      authorizationUrl: "https://auth.openai.com/login",
    })),
    cancelLogin: vi.fn(async () => "canceled"),
    close: vi.fn(async () => {}),
  };
}

describe("Codex login cleanup", () => {
  it("does not close a replacement login while the old cancellation settles", async () => {
    const oldClient = fakeClient();
    const newClient = fakeClient();
    let resolveCancel!: (value: string) => void;
    oldClient.cancelLogin.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCancel = resolve;
        }),
    );
    const clients = [oldClient, newClient];
    const manager = new AuthManager({
      connectCodex: async () => clients.shift() as unknown as CodexAccountClient,
    });
    await manager.codex.start("browser");
    const cancellation = manager.codex.cancel();
    expect((await manager.codex.start("browser")).ok).toBe(true);
    resolveCancel("canceled");
    await cancellation;
    expect(oldClient.close).toHaveBeenCalledOnce();
    expect(newClient.close).not.toHaveBeenCalled();
    expect(manager.codex.describe().inProgress).toBe(true);
    manager.dispose();
  });
});

describe("Codex login verification", () => {
  it.each(["empty", "error"])(
    "verifies persisted credentials when the login process returns %s",
    async (result) => {
      const login = fakeClient();
      const fresh = fakeClient();
      if (result === "error") login.readAccount.mockRejectedValue(new Error("read failed"));
      fresh.readAccount.mockResolvedValue({
        account: { type: "chatgpt", email: null, planType: "plus" },
        requiresOpenaiAuth: true,
      });
      const clients = [login, fresh];
      const connect = vi.fn(async () => clients.shift() as unknown as CodexAccountClient);
      const manager = new AuthManager({ connectCodex: connect });
      try {
        await manager.codex.start("browser");
        const notify = login.onNotification.mock.calls[0][0];
        notify("account/login/completed", { loginId: "login", success: true });
        notify("account/login/completed", { loginId: "login", success: true });
        await vi.waitFor(() => expect(manager.codex.describe().inProgress).toBe(false));
        expect(manager.codex.describe().lastError).toBeNull();
        expect(connect).toHaveBeenCalledTimes(2);
        expect(fresh.close).toHaveBeenCalledOnce();
        expect(login.close).toHaveBeenCalledOnce();
      } finally {
        manager.dispose();
      }
    },
  );

  it.each([true, false])(
    "keeps an unverified login failed (completion success: %s)",
    async (success) => {
      const login = fakeClient();
      const fresh = fakeClient();
      const clients = [login, fresh];
      const connect = vi.fn(async () => clients.shift() as unknown as CodexAccountClient);
      const manager = new AuthManager({ connectCodex: connect });
      try {
        await manager.codex.start("browser");
        login.onNotification.mock.calls[0][0]("account/login/completed", {
          loginId: "login",
          success,
        });
        await vi.waitFor(() => expect(manager.codex.describe().inProgress).toBe(false));
        expect(manager.codex.describe().lastError).toContain("unsuccessful");
        expect(connect).toHaveBeenCalledTimes(success ? 2 : 1);
      } finally {
        manager.dispose();
      }
    },
  );
});

describe("credential change notification", () => {
  it("notifies catalog listeners when an OpenCode key is saved or removed", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "scope-auth-notify-"));
    const savedXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dir;
    const manager = new AuthManager();
    try {
      const provider = vi.fn();
      const unsubscribe = manager.onProviderAuthChanged(provider);
      expect((await manager.opencode.saveKey("sk-test-key-123456")).ok).toBe(true);
      expect(provider).toHaveBeenLastCalledWith("opencode");
      expect((await manager.opencode.removeKey()).ok).toBe(true);
      expect(provider).toHaveBeenCalledTimes(2);
      unsubscribe();
      expect((await manager.opencode.saveKey("sk-test-key-123456")).ok).toBe(true);
      expect(provider).toHaveBeenCalledTimes(2);
    } finally {
      manager.dispose();
      if (savedXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = savedXdg;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("detects an external switch between two signed-in Codex accounts without exposing identity", async () => {
  let email = "first@example.test";
  const client = {
    ...fakeClient(),
    readAccount: async () => ({
      account: { type: "chatgpt", email, planType: "plus" },
      requiresOpenaiAuth: true,
    }),
  };
  const manager = new AuthManager({
    connectCodex: async () => client as unknown as CodexAccountClient,
  });
  try {
    const first = await manager.getCatalogConnection("codex");
    email = "second@example.test";
    const second = await manager.getCatalogConnection("codex");
    expect(first.connected).toBe(true);
    expect(second.connected).toBe(true);
    expect(second.identity).not.toBe(first.identity);
    const publicSnapshot = JSON.stringify(await manager.getProviderSnapshot("codex"));
    expect(publicSnapshot).not.toContain(email);
    expect(publicSnapshot).not.toContain(second.identity);
  } finally {
    manager.dispose();
  }
});
