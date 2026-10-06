/**
 * Model catalog route tests (dynamic catalog stage): safe snapshot reads,
 * same-origin enforcement on the refresh mutation, provider allowlisting, and
 * the refresh response contract. Discovery adapters are fixtures; no CLI or
 * network call happens here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as GET_MODELS } from "@/app/api/ai/models/route";
import { POST as POST_REFRESH } from "@/app/api/ai/models/refresh/route";
import { ModelCatalogService, setModelCatalogForTests } from "@/lib/ai/models/catalog";
import type { ModelDiscoveryAdapter } from "@/lib/ai/models/adapters/types";
import type { CatalogModelDraft } from "@/lib/ai/models/repository";
import type { ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";

const tempDirs: string[] = [];
let db: ScopeDatabase;

function draft(id: string): CatalogModelDraft {
  return {
    id,
    runtimeId: id,
    label: id,
    description: "",
    reasoningOptions: [],
    defaultReasoningEffort: null,
    effortsKnown: true,
    runtimeCompatibility: "supported",
    access: "account",
    aliasTarget: null,
    recommended: false,
    upgrade: null,
  };
}

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

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-model-routes-"));
  tempDirs.push(dir);
  db = new Database(path.join(dir, "test.db"));
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
});

afterEach(() => {
  setModelCatalogForTests(null);
  db.close();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function installCatalog(
  adapters: Partial<Record<"codex" | "opencode" | "claude", ModelDiscoveryAdapter>>,
): void {
  setModelCatalogForTests(
    new ModelCatalogService({ db, adapters, identity: () => "test-connection" }),
  );
}

describe("GET /api/ai/models", () => {
  it("serves a safe bundled snapshot before any discovery", async () => {
    installCatalog({});
    const response = await GET_MODELS();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      providers: Record<string, { state: string; fallback: boolean; models: unknown[] }>;
    };
    expect(body.providers.codex.state).toBe("bundled");
    expect(body.providers.codex.fallback).toBe(true);
    expect(body.providers.codex.models.length).toBeGreaterThan(0);
    expect(body.providers.opencode).toBeDefined();
    expect(body.providers.claude).toBeDefined();
    // No credentials, account identifiers, or raw CLI output cross this line.
    expect(JSON.stringify(body)).not.toMatch(/token|apiKey|stderr/i);
  });
});

describe("POST /api/ai/models/refresh", () => {
  it("rejects cross-origin mutations", async () => {
    installCatalog({});
    const response = await POST_REFRESH(
      request("/api/ai/models/refresh", { method: "POST" }, { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects an unknown provider id", async () => {
    installCatalog({});
    const response = await POST_REFRESH(
      request("/api/ai/models/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "gemini" }),
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_provider");
  });

  it("refreshes one provider and returns the live snapshot", async () => {
    const discover = vi.fn(async () => ({
      models: [draft("gpt-6-astra")],
      runtimeVersion: null,
      source: "fixture",
    }));
    installCatalog({ codex: { provider: "codex", discover } });
    const response = await POST_REFRESH(
      request("/api/ai/models/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "codex" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(discover).toHaveBeenCalledTimes(1);
    const body = (await response.json()) as {
      providers: Record<string, { state: string; models: Array<{ id: string }> }>;
    };
    expect(body.providers.codex.state).toBe("live");
    expect(body.providers.codex.models.map((model) => model.id)).toEqual(["gpt-6-astra"]);
    // Untouched providers keep their bundled fallback.
    expect(body.providers.claude.state).toBe("bundled");

    const cached = await GET_MODELS();
    const cachedBody = (await cached.json()) as {
      providers: Record<string, { models: Array<{ id: string }> }>;
    };
    expect(cachedBody.providers.codex.models.map((model) => model.id)).toEqual(["gpt-6-astra"]);
  });

  it("refreshes every provider independently when none is named", async () => {
    const codex = vi.fn(async () => ({
      models: [draft("codex-model")],
      runtimeVersion: null,
      source: "fixture",
    }));
    const opencode = vi.fn(async () => {
      throw new Error("offline");
    });
    const claude = vi.fn(async () => ({
      models: [draft("claude-model")],
      runtimeVersion: null,
      source: "fixture",
    }));
    installCatalog({
      codex: { provider: "codex", discover: codex },
      opencode: { provider: "opencode", discover: opencode },
      claude: { provider: "claude", discover: claude },
    });
    const response = await POST_REFRESH(request("/api/ai/models/refresh", { method: "POST" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      providers: Record<string, { state: string }>;
    };
    // One provider's failure did not block the others.
    expect(body.providers.codex.state).toBe("live");
    expect(body.providers.claude.state).toBe("live");
    expect(body.providers.opencode.state).toBe("bundled");
  });
});

it("keeps automatic retries in backoff but allows an explicit manual retry", async () => {
  const discover = vi.fn(async () => {
    throw new Error("offline");
  });
  installCatalog({ codex: { provider: "codex", discover } });
  const refresh = (manual: boolean) =>
    POST_REFRESH(
      request("/api/ai/models/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "codex", manual }),
      }),
    );
  await refresh(false);
  await refresh(false);
  expect(discover).toHaveBeenCalledOnce();
  await refresh(true);
  expect(discover).toHaveBeenCalledTimes(2);
});
