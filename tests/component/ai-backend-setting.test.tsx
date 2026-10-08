// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveAiBackendAction, saveAiChatModeSettingsAction } from "@/app/actions/settings";
import { AiBackendSetting } from "@/app/settings/ai-backend-setting";
import type { AiAuthSnapshot, ProviderAuthSnapshot } from "@/lib/ai/auth-types";
import { getDefaultAiChatModeSettings } from "@/lib/ai/model-catalog";

vi.mock("@/app/actions/settings", () => ({
  saveAiBackendAction: vi.fn(),
  saveAiChatModeSettingsAction: vi.fn(),
}));

const saveBackend = vi.mocked(saveAiBackendAction);
const saveModes = vi.mocked(saveAiChatModeSettingsAction);

function provider(overrides: Partial<ProviderAuthSnapshot> = {}): ProviderAuthSnapshot {
  return {
    installed: true,
    compatible: true,
    authenticated: false,
    subscription: false,
    method: "none",
    detail: null,
    keySaved: false,
    otherCredentialCount: 0,
    deviceCodeAvailable: true,
    attempt: null,
    signingOut: false,
    statusError: null,
    resolvedCommand: "codex",
    commandSource: "auto",
    ...overrides,
  };
}

function snapshotFixture(overrides: Partial<AiAuthSnapshot> = {}): AiAuthSnapshot {
  return {
    instanceId: "test-instance",
    revision: 1,
    checkedAt: "2026-09-16T12:00:00.000Z",
    backend: "codex",
    codex: provider(),
    opencode: provider(),
    claude: provider(),
    ...overrides,
  };
}

function renderSetting(
  status: AiAuthSnapshot | null = snapshotFixture(),
  platform = "linux",
): void {
  render(
    <AiBackendSetting
      initialBackend="codex"
      initialModeSettings={getDefaultAiChatModeSettings()}
      initialStatus={status}
      platform={platform}
    />,
  );
}

let serverSnapshot: AiAuthSnapshot;

function mockFetch(handler?: (url: string, init?: RequestInit) => unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (handler) {
        const override = handler(url, init);
        if (override !== undefined) {
          return new Response(JSON.stringify(override), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
      if (url === "/api/ai/auth") {
        return new Response(JSON.stringify(serverSnapshot), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, snapshot: serverSnapshot }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  saveBackend.mockReset();
  saveModes.mockReset();
  serverSnapshot = snapshotFixture();
  mockFetch();
  vi.stubGlobal("open", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AiBackendSetting", () => {
  it("lets a Mac retry an unavailable Claude status without asking it to sign in again", async () => {
    serverSnapshot = snapshotFixture({
      claude: provider({
        statusError: {
          code: "status_unavailable",
          message:
            "Claude's sign-in status could not be checked. You may still be signed in. Check again.",
        },
      }),
    });
    renderSetting(serverSnapshot, "darwin");
    expect(screen.getByText("Status unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with Claude" })).toBeNull();
    serverSnapshot = snapshotFixture({
      claude: provider({ authenticated: true, subscription: true, method: "subscription" }),
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Check again" }).at(-1)!);
    await waitFor(() => expect(screen.getByText("Signed in with Claude")).toBeTruthy());
    expect(
      vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes("claude-login")),
    ).toBe(true);
  });

  it("accepts a restarted server and ignores responses from its retired instance", async () => {
    renderSetting(snapshotFixture({ revision: 50 }));
    serverSnapshot = snapshotFixture({
      instanceId: "restarted-server",
      revision: 1,
      claude: provider({ authenticated: true, subscription: true }),
    });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(screen.getByText("Signed in with Claude")).toBeTruthy());
    serverSnapshot = snapshotFixture({ revision: 51 });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Signed in with Claude")).toBeTruthy();
  });

  it("separates provider selection from account actions", async () => {
    saveBackend.mockResolvedValue({ ok: true, savedValue: "claude" });
    renderSetting();

    expect(screen.getByRole("radio", { name: /Codex/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /OpenCode Go/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Claude Code/ })).toBeTruthy();

    // Clicking a connect action must not select the provider.
    fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("codex-login"))).toBe(
        true,
      ),
    );
    expect(saveBackend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: /Claude Code/ }));
    await waitFor(() => expect(saveBackend).toHaveBeenCalledWith("claude"));
    await waitFor(() => expect(screen.getByText("Claude Code chat defaults")).toBeTruthy());
  });

  it("offers sign-out behind a shared-CLI confirmation dialog", async () => {
    serverSnapshot = snapshotFixture({
      codex: provider({
        authenticated: true,
        subscription: true,
        method: "chatgpt",
        detail: "plus plan",
      }),
    });
    renderSetting(serverSnapshot);

    expect(screen.getByText("Signed in with ChatGPT")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/shared codex CLI/i)).toBeTruthy();
    const logoutCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url) === "/api/ai/auth/codex/logout");
    expect(logoutCalls).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/ai/auth/codex/logout"),
      ).toBe(true),
    );
  });

  it("never claims a subscription for a non-subscription Claude login", () => {
    serverSnapshot = snapshotFixture({
      claude: provider({
        authenticated: true,
        subscription: false,
        method: "api_key",
        detail: "v2.1.241",
      }),
    });
    renderSetting(serverSnapshot);

    expect(screen.getByText("Connected — not a subscription login")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Sign out" }).length).toBeGreaterThan(0);
  });

  it("shows platform install help and the privacy note for a missing CLI", () => {
    serverSnapshot = snapshotFixture({
      claude: provider({ installed: false, compatible: false }),
    });
    renderSetting(serverSnapshot);

    expect(screen.getByText("claude CLI not found")).toBeTruthy();
    expect(screen.getByText(/curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Claude Code setup guide/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with Claude" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /Check again/ }).length).toBeGreaterThan(0);
    expect(screen.getByText(/transmitted to the provider you selected/)).toBeTruthy();
  });

  it("distinguishes an incompatible CLI from a missing one", () => {
    serverSnapshot = snapshotFixture({
      claude: provider({ installed: true, compatible: false }),
    });
    renderSetting(serverSnapshot);

    expect(screen.getByText("CLI is too old")).toBeTruthy();
    expect(screen.getByText(/Update Claude Code to the latest version/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with Claude" })).toBeNull();
  });

  it("uses Windows install commands when the host is Windows", () => {
    serverSnapshot = snapshotFixture({
      codex: provider({ installed: false, compatible: false }),
    });
    renderSetting(serverSnapshot, "win32");

    expect(screen.getByText(/install\.ps1/)).toBeTruthy();
    expect(screen.getByText(/if an npm install is not detected/i)).toBeTruthy();
  });

  it("uses macOS install commands and Homebrew alternatives when the host is macOS", () => {
    serverSnapshot = snapshotFixture({
      claude: provider({ installed: false, compatible: false }),
    });
    renderSetting(serverSnapshot, "darwin");

    expect(screen.getByText(/claude\.ai\/install\.sh/)).toBeTruthy();
    expect(screen.getByText(/brew install --cask claude-code/)).toBeTruthy();
  });

  it("reports status failure with a retry action and no false signed-out claim", () => {
    renderSetting(null);
    expect(screen.getByText(/provider status could not be read/i)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Check again/ }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Not signed in")).toBeNull();
  });

  it("tracks a Claude sign-in attempt with progress, cancel, and code fallback", async () => {
    const attempt = {
      id: "attempt-1",
      phase: "waiting_for_browser" as const,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      authorizationUrl: "https://claude.com/cai/oauth/authorize?code=true",
      verificationUrl: null,
      userCode: null,
      error: null,
    };
    serverSnapshot = snapshotFixture({ claude: provider({ attempt }) });
    mockFetch((url) => {
      if (url === "/api/ai/auth/claude-login") {
        return { ok: true, snapshot: serverSnapshot };
      }
      return undefined;
    });
    renderSetting(snapshotFixture({ claude: provider() }));

    fireEvent.click(screen.getByRole("button", { name: "Sign in with Claude" }));
    await waitFor(() =>
      expect(screen.getByText("Finish signing in in your browser.")).toBeTruthy(),
    );
    expect(screen.getByRole("link", { name: /Open browser again/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Have a sign-in code?" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("Sign-in code")).toBeTruthy();
  });

  it("guides the OpenCode Go key dialog and clears the field on dismissal", async () => {
    renderSetting(snapshotFixture({ opencode: provider({ otherCredentialCount: 2 }) }));

    expect(screen.getByText("Other OpenCode credentials only")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect OpenCode Go" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Open the OpenCode dashboard/)).toBeTruthy();
    expect(within(dialog).getByText(/Subscribe to Go/)).toBeTruthy();
    const input = within(dialog).getByLabelText("OpenCode Go API key") as HTMLInputElement;
    expect(input.type).toBe("password");

    fireEvent.click(within(dialog).getByRole("button", { name: "Show key" }));
    expect(input.type).toBe("text");

    fireEvent.change(input, { target: { value: "go-key-123456" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Connect OpenCode Go" }));
    const reopened = screen.getByRole("dialog");
    expect((within(reopened).getByLabelText("OpenCode Go API key") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("saves an explicit provider executable through the path route", async () => {
    serverSnapshot = snapshotFixture({
      codex: provider({ installed: false, compatible: false }),
    });
    const updated = snapshotFixture({
      codex: provider({
        resolvedCommand: "/opt/tools/codex",
        commandSource: "override",
      }),
    });
    mockFetch((url, init) => {
      if (url === "/api/ai/auth/codex/path" && init?.method === "POST") {
        return { ok: true, snapshot: updated };
      }
      return undefined;
    });
    renderSetting(serverSnapshot);

    fireEvent.click(screen.getByRole("button", { name: "Set executable path" }));
    fireEvent.change(screen.getByLabelText("Codex executable path"), {
      target: { value: "/opt/tools/codex" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save path" }));

    await waitFor(() =>
      expect(
        screen.getByText("Executable path saved. Scope now uses it for this provider."),
      ).toBeTruthy(),
    );
    const call = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url) === "/api/ai/auth/codex/path");
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ path: "/opt/tools/codex" });
    expect(screen.getByRole("button", { name: "Change executable path" })).toBeTruthy();
  });

  it("clears a saved executable path back to automatic discovery", async () => {
    const overridden = snapshotFixture({
      codex: provider({ resolvedCommand: "/opt/tools/codex", commandSource: "override" }),
    });
    const automatic = snapshotFixture({
      codex: provider({ resolvedCommand: "codex", commandSource: "auto" }),
    });
    mockFetch((url, init) => {
      if (url === "/api/ai/auth/codex/path" && init?.method === "DELETE") {
        return { ok: true, snapshot: automatic };
      }
      return undefined;
    });
    renderSetting(overridden);

    fireEvent.click(screen.getByRole("button", { name: "Change executable path" }));
    fireEvent.click(screen.getByRole("button", { name: "Use automatic" }));

    await waitFor(() =>
      expect(
        screen.getByText("Executable path cleared. Scope uses automatic discovery again."),
      ).toBeTruthy(),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use automatic" })).toBeNull());
  });

  it("saves the OpenCode Go key through the API and reports the saved state", async () => {
    serverSnapshot = snapshotFixture({
      opencode: provider({
        authenticated: true,
        keySaved: true,
        method: "api_key",
        detail: "Access is checked when you use it.",
      }),
    });
    renderSetting(snapshotFixture({ opencode: provider() }));

    fireEvent.click(screen.getByRole("button", { name: "Connect OpenCode Go" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("OpenCode Go API key"), {
      target: { value: "go-key-123456" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));

    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(
            ([url, init]) => String(url) === "/api/ai/auth/opencode" && init?.method === "POST",
          ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getByText("OpenCode Go key saved")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Replace key" })).toBeTruthy();
  });
});
