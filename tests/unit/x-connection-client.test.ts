// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { requestXConnection, xLoginPending } from "@/lib/x/connection-client";

afterEach(() => {
  delete window.scopeX;
});

function desktopData(overrides: Record<string, unknown> = {}) {
  return {
    connected: false,
    canConnect: true,
    user: null,
    phase: "disconnected",
    attemptId: "3",
    errorCode: null,
    sessionOnly: false,
    restoring: false,
    storage: { state: "not_saved", reason: "missing_file", backend: "gnome_libsecret" },
    ...overrides,
  };
}

function installBridge(handlers: Partial<Record<string, () => Promise<unknown>>> = {}) {
  const calls: string[] = [];
  const reply = (data: unknown) => ({ ok: true, data });
  const record = {
    status: async () => (calls.push("status"), reply(desktopData())),
    connect: async () => (calls.push("connect"), reply(desktopData())),
    cancel: async () => (calls.push("cancel"), reply(desktopData())),
    disconnect: async () => (calls.push("disconnect"), reply(desktopData())),
    focus: async () => (calls.push("focus"), reply(desktopData())),
    "retry-storage": async () => (calls.push("retry-storage"), reply(desktopData())),
    ...handlers,
  };
  window.scopeX = record as unknown as Window["scopeX"];
  return calls;
}

describe("desktop X connection client", () => {
  it("passes through bounded storage status and restore progress", async () => {
    installBridge({
      status: async () => ({
        ok: true,
        data: desktopData({
          connected: true,
          user: { userId: "1", handle: "reader", displayName: "Reader", avatarUrl: null },
          restoring: true,
          storage: { state: "saved", reason: null, backend: "gnome_libsecret" },
        }),
      }),
    });
    const status = await requestXConnection("status");
    expect(status.capability).toBe("connected");
    expect(status.restoring).toBe(true);
    expect(status.storage).toEqual({ state: "saved", reason: null, backend: "gnome_libsecret" });
  });

  it("drops unbounded or malformed storage payloads", async () => {
    installBridge({
      status: async () => ({
        ok: true,
        data: desktopData({ storage: { state: "definitely-not", reason: "x", backend: 42 } }),
      }),
    });
    const status = await requestXConnection("status");
    expect(status.storage).toBeNull();
  });

  it("dispatches retry-storage through the narrow bridge", async () => {
    const calls = installBridge({
      "retry-storage": async () => {
        calls.push("retry-storage");
        return {
          ok: true,
          data: desktopData({
            storage: { state: "saved", reason: null, backend: "gnome_libsecret" },
          }),
        };
      },
    });
    const status = await requestXConnection("retry-storage");
    expect(calls).toEqual(["retry-storage"]);
    expect(status.storage?.state).toBe("saved");
  });

  it("surfaces a refused bridge operation as a typed message", async () => {
    installBridge({
      connect: async () => ({ ok: false, error: { code: "session_expired" } }),
    });
    await expect(requestXConnection("connect")).rejects.toThrow(/session has expired/i);
  });

  it("recognizes pending login phases", () => {
    expect(xLoginPending({ phase: "verifying" } as never)).toBe(true);
    expect(xLoginPending({ phase: "connected" } as never)).toBe(false);
  });
});
