/*
 * AI auth route tests (provider-auth stage): same-origin enforcement, bounded
 * JSON bodies, provider allowlisting, and the no-store snapshot contract.
 * Provider processes are never started here: fixture managers stand in for
 * the status snapshot and the busy/cancel paths short-circuit before any CLI
 * is touched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { beginAiRun } from "@/lib/ai/active-runs";
import { AuthManager, setAuthManagerForTests } from "@/lib/ai/auth/manager";
import { CodexAccountError } from "@/lib/ai/auth/codex-account-client";
import {
  authJson,
  isSameOriginMutation,
  readBoundedJson,
  statusForAuthError,
} from "@/lib/ai/auth/http";
import type { AiAuthSnapshot, ProviderAuthSnapshot } from "@/lib/ai/auth-types";
import { closeDatabase } from "@/lib/db/connection";
import { GET as GET_AUTH } from "@/app/api/ai/auth/route";
import {
  DELETE as DELETE_CODEX_LOGIN,
  POST as POST_CODEX_LOGIN,
} from "@/app/api/ai/auth/codex-login/route";
import { DELETE as DELETE_CLAUDE_LOGIN } from "@/app/api/ai/auth/claude-login/route";
import { POST as POST_CLAUDE_CODE } from "@/app/api/ai/auth/claude-login/code/route";
import { POST as POST_OPENCODE } from "@/app/api/ai/auth/opencode/route";
import { POST as POST_LOGOUT } from "@/app/api/ai/auth/[provider]/logout/route";

const tempDirs: string[] = [];
const savedDbPath = process.env.SCOPE_DB_PATH;

function snapshotFixture(): AiAuthSnapshot {
  const provider: ProviderAuthSnapshot = {
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
  };
  return {
    instanceId: "test-instance",
    revision: 7,
    checkedAt: "2026-09-16T12:00:00.000Z",
    backend: "codex",
    codex: { ...provider, method: "chatgpt", authenticated: true, subscription: true },
    opencode: { ...provider },
    claude: { ...provider },
  };
}

class FixtureManager extends AuthManager {
  constructor(private readonly fixture: AiAuthSnapshot) {
    super();
  }

  override async getSnapshot(): Promise<AiAuthSnapshot> {
    return this.fixture;
  }
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-auth-routes-"));
  tempDirs.push(dir);
  process.env.SCOPE_DB_PATH = path.join(dir, "test.db");
  closeDatabase();
  setAuthManagerForTests(null);
});

afterEach(() => {
  setAuthManagerForTests(null);
  closeDatabase();
  if (savedDbPath === undefined) {
    delete process.env.SCOPE_DB_PATH;
  } else {
    process.env.SCOPE_DB_PATH = savedDbPath;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function request(
  url: string,
  init: RequestInit = {},
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://127.0.0.1:3000${url}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...headers },
  });
}

describe("auth http helpers", () => {
  it("allows same-origin mutations and non-browser clients", () => {
    expect(isSameOriginMutation(request("/api/ai/auth/opencode"))).toBe(true);
    expect(
      isSameOriginMutation(
        request("/api/ai/auth/opencode", {}, { origin: "http://127.0.0.1:3000" }),
      ),
    ).toBe(true);
    // Next normalizes request.url to localhost; the browser's own 127.0.0.1
    // origin must still be accepted when the Host header matches.
    const normalized = new Request("http://localhost:3000/api/ai/auth/opencode", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" },
    });
    expect(isSameOriginMutation(normalized)).toBe(true);
    const spoofed = new Request("http://localhost:3000/api/ai/auth/opencode", {
      method: "POST",
      headers: { origin: "https://evil.example.com", host: "127.0.0.1:3000" },
    });
    expect(isSameOriginMutation(spoofed)).toBe(false);
    expect(
      isSameOriginMutation(
        request("/api/ai/auth/opencode", {}, { origin: "https://evil.example.com" }),
      ),
    ).toBe(false);
    expect(
      isSameOriginMutation(request("/api/ai/auth/opencode", {}, { origin: "not a url" })),
    ).toBe(false);
  });

  it("rejects oversized and malformed bodies", async () => {
    const oversized = await readBoundedJson(
      request("/api/ai/auth/opencode", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "999999" },
        body: "{}",
      }),
      1_024,
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.response.status).toBe(413);
    }

    const malformed = await readBoundedJson(
      request("/api/ai/auth/opencode", { method: "POST", body: "{not json" }),
      1_024,
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.response.status).toBe(400);
    }

    const empty = await readBoundedJson(
      request("/api/ai/auth/opencode", { method: "POST" }),
      1_024,
    );
    expect(empty).toEqual({ ok: true, value: {} });
  });

  it("maps auth error codes onto HTTP statuses", () => {
    expect(statusForAuthError(undefined)).toBe(200);
    expect(statusForAuthError({ code: "in_progress", message: "" })).toBe(409);
    expect(statusForAuthError({ code: "provider_busy", message: "" })).toBe(409);
    expect(statusForAuthError({ code: "invalid_key", message: "" })).toBe(400);
    expect(statusForAuthError({ code: "save_failed", message: "" })).toBe(500);
  });

  it("always answers with no-store", () => {
    expect(authJson({ ok: true }).headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /api/ai/auth", () => {
  it("returns the shared snapshot with no-store and never leaks CLI output", async () => {
    setAuthManagerForTests(new FixtureManager(snapshotFixture()));
    const response = await GET_AUTH();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as AiAuthSnapshot;
    expect(body.revision).toBe(7);
    expect(body.codex).toMatchObject({ authenticated: true, subscription: true });
    expect(body.opencode).toMatchObject({ keySaved: false });
  });
});

describe("codex login routes", () => {
  it("rejects a cross-origin start", async () => {
    const response = await POST_CODEX_LOGIN(
      request(
        "/api/ai/auth/codex-login",
        { method: "POST" },
        { origin: "https://evil.example.com" },
      ),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "cross_origin" } });
  });

  it("reports no active attempt to cancel", async () => {
    const manager = new AuthManager({
      connectCodex: () => {
        throw new CodexAccountError("spawn", "codex is not available");
      },
    });
    setAuthManagerForTests(manager);
    const response = await DELETE_CODEX_LOGIN(
      request("/api/ai/auth/codex-login", { method: "DELETE", body: JSON.stringify({}) }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("nothing_to_cancel");
  });
});

describe("claude login routes", () => {
  it("reports no active attempt to cancel", async () => {
    const response = await DELETE_CLAUDE_LOGIN(
      request("/api/ai/auth/claude-login", { method: "DELETE", body: JSON.stringify({}) }),
    );
    expect(response.status).toBe(409);
  });

  it("requires a code for the code route", async () => {
    const response = await POST_CLAUDE_CODE(
      request("/api/ai/auth/claude-login/code", {
        method: "POST",
        body: JSON.stringify({ attemptId: "abc" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_code" } });
  });
});

describe("opencode route", () => {
  it("refuses a key that does not look like a key without touching the store", async () => {
    const response = await POST_OPENCODE(
      request("/api/ai/auth/opencode", {
        method: "POST",
        body: JSON.stringify({ apiKey: "no" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_key" },
    });
  });
});

describe("logout route", () => {
  it("refuses an unknown provider", async () => {
    const response = await POST_LOGOUT(
      request("/api/ai/auth/not-a-provider/logout", { method: "POST" }),
      {
        params: Promise.resolve({ provider: "not-a-provider" }),
      },
    );
    expect(response.status).toBe(404);
  });

  it("refuses sign-out while a run for the provider is active", async () => {
    const manager = new AuthManager({
      connectCodex: () => {
        throw new CodexAccountError("spawn", "codex is not available");
      },
    });
    setAuthManagerForTests(manager);
    for (const provider of ["claude", "opencode"] as const) {
      const release = beginAiRun(provider);
      try {
        const response = await POST_LOGOUT(
          request(`/api/ai/auth/${provider}/logout`, { method: "POST" }),
          { params: Promise.resolve({ provider }) },
        );
        expect(response.status).toBe(409);
        const body = (await response.json()) as { ok: boolean; error?: { code: string } };
        expect(body.error?.code).toBe("provider_busy");
      } finally {
        release();
      }
    }
  });
});
