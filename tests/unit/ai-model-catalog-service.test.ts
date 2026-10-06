/**
 * Model catalog service and cache tests (dynamic catalog stage).
 *
 * Covers: first-run bundled fallback, atomic snapshot replacement, explicit
 * empty results, New-badge baselines, failure retention, refresh dedup,
 * manual bypass/cooldown, backoff, timeout cleanup, and discarding late
 * results after a credential change.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { ModelCatalogService, type ModelCatalogDeps } from "@/lib/ai/models/catalog";
import type { CatalogModelDraft } from "@/lib/ai/models/repository";
import {
  deleteProviderCatalog,
  readProviderCatalog,
  recordCatalogSuccess,
} from "@/lib/ai/models/repository";
import { DiscoveryError, type ModelDiscoveryAdapter } from "@/lib/ai/models/adapters/types";
import { getAuthManager } from "@/lib/ai/auth/manager";
import { bundledCatalogModels } from "@/lib/ai/models/bundled";
import { isNewCatalogModel, isCatalogSnapshotFresh } from "@/lib/ai/models/types";

const tempDirs: string[] = [];
let db: ScopeDatabase;
let service: ModelCatalogService | null = null;

function createTempDb(): ScopeDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-model-catalog-"));
  tempDirs.push(dir);
  const database = new Database(path.join(dir, "test.db"));
  database.pragma("foreign_keys = ON");
  runMigrations(database, ALL_MIGRATIONS);
  return database;
}

beforeEach(() => {
  db = createTempDb();
}, 30_000);

afterEach(() => {
  service?.dispose();
  service = null;
  db.close();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

function draft(id: string, overrides: Partial<CatalogModelDraft> = {}): CatalogModelDraft {
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
    ...overrides,
  };
}

function adapterFor(impl: ModelDiscoveryAdapter["discover"]): ModelDiscoveryAdapter {
  return { provider: "codex", discover: impl };
}

function makeService(
  adapters: Partial<Record<"codex" | "opencode" | "claude", ModelDiscoveryAdapter>>,
  overrides: Partial<ModelCatalogDeps> = {},
): ModelCatalogService {
  service = new ModelCatalogService({
    db,
    adapters,
    identity: () => "conn-a",
    ...overrides,
  });
  return service;
}

describe("model catalog service", () => {
  it("falls back to the bundled catalog before any discovery", () => {
    const catalog = makeService({});
    const snapshot = catalog.getSnapshot("codex");
    expect(snapshot.state).toBe("bundled");
    expect(snapshot.fallback).toBe(true);
    expect(snapshot.models).toEqual(bundledCatalogModels("codex"));
  });

  it("replaces the snapshot atomically and marks the first catalog as baseline", async () => {
    const catalog = makeService({
      codex: adapterFor(async () => ({
        models: [draft("gpt-6-astra"), draft("gpt-5.6-sol")],
        runtimeVersion: null,
        source: "fixture",
      })),
    });
    await catalog.refresh("codex", { manual: true });
    const live = catalog.getSnapshot("codex");
    expect(live.state).toBe("live");
    expect(live.fallback).toBe(false);
    expect(live.models.map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-5.6-sol"]);
    expect(live.models.every((model) => model.source === "discovered")).toBe(true);
    // The first catalog is a baseline: nothing is badged as new.
    expect(live.baselineAt).not.toBeNull();
    const nowMs = Date.parse(live.baselineAt ?? "");
    expect(
      live.models.every((model) => !isNewCatalogModel(model, live.baselineAt, nowMs + 1_000)),
    ).toBe(true);
    expect(readProviderCatalog(db, "codex")?.baselineAt).not.toBeNull();
  });

  it("preserves first-seen times and badges only later-discovered models", async () => {
    const firstSeen = Date.parse("2026-09-10T10:00:00.000Z");
    const laterMs = Date.parse("2026-09-18T10:00:00.000Z");
    let nowMs = firstSeen;
    const catalog = makeService(
      {
        codex: adapterFor(async () => ({
          models: [draft("gpt-5.6-sol")],
          runtimeVersion: null,
          source: "fixture",
        })),
      },
      { now: () => nowMs },
    );
    await catalog.refresh("codex", { manual: true });
    const originalSeen = catalog
      .getSnapshot("codex")
      .models.find((model) => model.id === "gpt-5.6-sol")?.firstSeenAt;

    service?.dispose();
    nowMs = laterMs;
    service = new ModelCatalogService({
      db,
      identity: () => "conn-a",
      now: () => nowMs,
      adapters: {
        codex: adapterFor(async () => ({
          models: [draft("gpt-5.6-sol"), draft("gpt-6-astra")],
          runtimeVersion: null,
          source: "fixture",
        })),
      },
    });
    await service.refresh("codex", { manual: true });
    const snapshot = service.getSnapshot("codex");
    const models = snapshot.models;
    const sol = models.find((model) => model.id === "gpt-5.6-sol");
    const astra = models.find((model) => model.id === "gpt-6-astra");
    expect(sol?.firstSeenAt).toBe(originalSeen);
    expect(isNewCatalogModel(sol!, snapshot.baselineAt, laterMs)).toBe(false);
    expect(isNewCatalogModel(astra!, snapshot.baselineAt, laterMs)).toBe(true);
    // Seven days later the badge expires.
    expect(isNewCatalogModel(astra!, snapshot.baselineAt, laterMs + 8 * 24 * 60 * 60_000)).toBe(
      false,
    );
  });

  it("treats an explicitly valid empty result as empty, not bundled", async () => {
    const catalog = makeService({
      codex: adapterFor(async () => ({ models: [], runtimeVersion: null, source: "fixture" })),
    });
    await catalog.refresh("codex", { manual: true });
    const snapshot = catalog.getSnapshot("codex");
    expect(snapshot.state).toBe("empty");
    expect(snapshot.models).toEqual([]);
    expect(snapshot.fallback).toBe(false);
    expect(isCatalogSnapshotFresh(snapshot, 60_000, Date.now())).toBe(true);
  });

  it("retains the last successful models when discovery fails", async () => {
    const catalog = makeService({
      codex: adapterFor(async () => ({
        models: [draft("gpt-5.6-sol")],
        runtimeVersion: null,
        source: "fixture",
      })),
    });
    await catalog.refresh("codex", { manual: true });
    service?.dispose();
    service = new ModelCatalogService({
      db,
      identity: () => "conn-a",
      adapters: {
        codex: adapterFor(async () => {
          throw new DiscoveryError("offline");
        }),
      },
    });
    await service.refresh("codex", { manual: true });
    const snapshot = service.getSnapshot("codex");
    expect(snapshot.state).toBe("failed");
    expect(snapshot.models.map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
    expect(snapshot.error).toBe("offline");
    expect(snapshot.lastSuccessAt).not.toBeNull();
  });

  it("falls back to bundled models on failure with no cache", async () => {
    const catalog = makeService({
      codex: adapterFor(async () => {
        throw new DiscoveryError("no CLI");
      }),
    });
    await catalog.refresh("codex", { manual: true });
    const snapshot = catalog.getSnapshot("codex");
    expect(snapshot.state).toBe("bundled");
    expect(snapshot.fallback).toBe(true);
    expect(snapshot.models).toEqual(bundledCatalogModels("codex"));
    expect(snapshot.error).toBe("no CLI");
  });

  it("deduplicates concurrent refreshes per provider", async () => {
    const resolvers: Array<() => void> = [];
    const discover = vi.fn(async () => {
      await new Promise<void>((resolve) => resolvers.push(resolve));
      return { models: [draft("gpt-5.6-sol")], runtimeVersion: null, source: "fixture" };
    });
    const catalog = makeService({ codex: adapterFor(discover) });
    const first = catalog.refresh("codex", { manual: true });
    const second = catalog.refresh("codex", { manual: true });
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers.forEach((resolve) => resolve());
    const [a, b] = await Promise.all([first, second]);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(a.revision).toBe(b.revision);
  });

  it("skips automatic refreshes while fresh and honors the manual cooldown", async () => {
    const discover = vi.fn(async () => ({
      models: [draft("gpt-5.6-sol")],
      runtimeVersion: null,
      source: "fixture",
    }));
    const catalog = makeService({ codex: adapterFor(discover) });
    await catalog.refresh("codex", { manual: true });
    expect(discover).toHaveBeenCalledTimes(1);

    // Fresh snapshot: automatic refresh is a no-op.
    await catalog.refresh("codex");
    expect(discover).toHaveBeenCalledTimes(1);

    // Manual inside the cooldown is also a no-op.
    await catalog.refresh("codex", { manual: true });
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("backs off after failures and resets on a manual retry", async () => {
    let nowMs = 1_000_000;
    let failing = true;
    const discover = vi.fn(async () => {
      if (failing) {
        throw new DiscoveryError("offline");
      }
      return { models: [draft("gpt-5.6-sol")], runtimeVersion: null, source: "fixture" };
    });
    const catalog = makeService({ codex: adapterFor(discover) }, { now: () => nowMs });
    await catalog.refresh("codex", { manual: true });
    expect(discover).toHaveBeenCalledTimes(1);

    // Automatic retry inside the backoff window stays put.
    nowMs += 5_000;
    await catalog.refresh("codex");
    expect(discover).toHaveBeenCalledTimes(1);

    // A manual retry bypasses backoff and succeeds.
    failing = false;
    await catalog.refresh("codex", { manual: true });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(catalog.getSnapshot("codex").state).toBe("live");
  });

  it("aborts a timed-out discovery and records a failure", async () => {
    let observedAbort = false;
    const catalog = makeService(
      {
        codex: adapterFor(
          (context) =>
            new Promise((_, reject) => {
              context.signal.addEventListener("abort", () => {
                observedAbort = true;
                reject(new DiscoveryError("aborted"));
              });
            }),
        ),
      },
      { timeoutMs: 20 },
    );
    await catalog.refresh("codex", { manual: true });
    expect(observedAbort).toBe(true);
    expect(catalog.getSnapshot("codex").state).toBe("bundled");
    expect(catalog.isRefreshing("codex")).toBe(false);
  });

  it("discards a late result when the credential generation changed", async () => {
    let identity = "conn-a";
    let finish!: () => void;
    const discover = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { models: [draft("gpt-6-astra")], runtimeVersion: null, source: "fixture" };
    });
    const catalog = makeService({ codex: adapterFor(discover) }, { identity: () => identity });
    const pending = catalog.refresh("codex", { manual: true });
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    identity = "conn-b";
    finish();
    const snapshot = await pending;
    // The old account's discovery was not published for the new identity.
    expect(snapshot.models.map((model) => model.id)).not.toContain("gpt-6-astra");
    expect(readProviderCatalog(db, "codex")).toBeNull();
  });

  it("keeps bundled models out once authoritative discovery removed them", async () => {
    const catalog = makeService({
      codex: adapterFor(async () => ({
        models: [draft("gpt-6-astra")],
        runtimeVersion: null,
        source: "fixture",
      })),
    });
    await catalog.refresh("codex", { manual: true });
    const models = catalog.getSnapshot("codex").models;
    expect(models.map((model) => model.id)).toEqual(["gpt-6-astra"]);
    expect(models.map((model) => model.id)).not.toContain("gpt-5.6-sol");
  });

  it("invalidates and re-discovers a provider when credentials change", async () => {
    const { mkdtempSync: mk, rmSync: rm } = await import("node:fs");
    const { tmpdir: tmp } = await import("node:os");
    const path = await import("node:path");
    const xdg = mk(path.join(tmp(), "scope-catalog-auth-"));
    const savedXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdg;
    try {
      recordCatalogSuccess(db, "opencode", {
        connectionKey: "conn-a",
        runtimeVersion: null,
        models: [draft("stale-model")],
        source: "fixture",
      });
      const catalog = makeService({
        opencode: {
          provider: "opencode",
          discover: async () => ({
            models: [draft("fresh-model")],
            runtimeVersion: null,
            source: "fixture",
          }),
        },
      });
      expect(catalog.getSnapshot("opencode").models.map((model) => model.id)).toEqual([
        "stale-model",
      ]);
      await getAuthManager().opencode.saveKey("sk-test-key-123456");
      await vi.waitFor(() =>
        expect(catalog.getSnapshot("opencode").models.map((model) => model.id)).toEqual([
          "fresh-model",
        ]),
      );
      expect(catalog.getSnapshot("opencode").state).toBe("live");
    } finally {
      if (savedXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = savedXdg;
      }
      rm(xdg, { recursive: true, force: true });
    }
  });

  it("clears a provider cache on invalidate", async () => {
    recordCatalogSuccess(db, "codex", {
      connectionKey: "conn-a",
      runtimeVersion: null,
      models: [draft("gpt-6-astra")],
      source: "fixture",
    });
    const catalog = makeService({});
    expect(catalog.getSnapshot("codex").state).toBe("live");
    catalog.invalidate("codex");
    expect(catalog.getSnapshot("codex").state).toBe("bundled");
    deleteProviderCatalog(db, "codex");
  });
});

it("retains an authoritative empty catalog after a later failure", async () => {
  let fail = false;
  const catalog = makeService({
    codex: adapterFor(async () => {
      if (fail) throw new DiscoveryError("offline");
      return { models: [], runtimeVersion: null, source: "fixture" };
    }),
  });
  await catalog.refresh("codex");
  fail = true;
  await catalog.refresh("codex", { manual: true });
  expect(catalog.getSnapshot("codex")).toMatchObject({
    state: "failed",
    models: [],
    fallback: false,
  });
  expect(catalog.getSnapshot("codex").lastSuccessAt).not.toBeNull();
});

it("bounds even an adapter that ignores cancellation", async () => {
  const catalog = makeService(
    { codex: adapterFor(() => new Promise(() => {})) },
    { timeoutMs: 20 },
  );
  await catalog.refresh("codex");
  expect(catalog.isRefreshing("codex")).toBe(false);
  expect(catalog.getSnapshot("codex").error).toMatch(/timed out/);
});

it("invalidates a fresh cache for an external account or runtime change", async () => {
  let identity = "account-a:runtime-1";
  const discover = vi.fn(async () => ({
    models: [draft(identity)],
    runtimeVersion: null,
    source: "fixture",
  }));
  const catalog = makeService(
    { codex: adapterFor(discover) },
    {
      connection: async () => ({ identity, connected: true }),
    },
  );
  await catalog.refresh("codex");
  const generation = catalog.getSnapshot("codex").generation!;
  identity = "account-b:runtime-1";
  await catalog.refresh("codex");
  expect(catalog.getSnapshot("codex").models[0].id).toBe(identity);
  identity = "account-b:runtime-2";
  await catalog.refresh("codex");
  expect(catalog.getSnapshot("codex").generation).toBeGreaterThan(generation);
  expect(discover).toHaveBeenCalledTimes(3);
});

it("does not discover disconnected providers or present their old catalog", async () => {
  let connected = true;
  const discover = vi.fn(async () => ({
    models: [draft("old")],
    runtimeVersion: null,
    source: "fixture",
  }));
  const catalog = makeService(
    { codex: adapterFor(discover) },
    {
      connection: async () => ({ identity: String(connected), connected }),
    },
  );
  await catalog.refresh("codex");
  connected = false;
  await catalog.refresh("codex", { manual: true });
  expect(discover).toHaveBeenCalledOnce();
  expect(catalog.getSnapshot("codex")).toMatchObject({ connected: false, models: [] });
});

it("restarts discovery for the new connection without waiting for an old result", async () => {
  let identity = "a";
  let finishOld!: (value: {
    models: CatalogModelDraft[];
    runtimeVersion: null;
    source: string;
  }) => void;
  const discover = vi.fn(() =>
    identity === "a"
      ? new Promise<{ models: CatalogModelDraft[]; runtimeVersion: null; source: string }>(
          (resolve) => {
            finishOld = resolve;
          },
        )
      : Promise.resolve({ models: [draft("new")], runtimeVersion: null, source: "fixture" }),
  );
  const catalog = makeService(
    { codex: adapterFor(discover) },
    {
      connection: async () => ({ identity, connected: true }),
    },
  );
  const old = catalog.refresh("codex");
  await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());
  identity = "b";
  await catalog.refresh("codex");
  finishOld({ models: [draft("old")], runtimeVersion: null, source: "fixture" });
  await old;
  expect(catalog.getSnapshot("codex").models.map((m) => m.id)).toEqual(["new"]);
});
