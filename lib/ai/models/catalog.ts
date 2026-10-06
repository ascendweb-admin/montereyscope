/**
 * Model catalog service (dynamic catalog stage). Server-only.
 *
 * The process-wide owner of provider discovery. It reads the persisted
 * snapshot (or the bundled fallback), runs the per-provider adapters behind a
 * 15-second timeout, deduplicates concurrent refreshes, backs off after
 * failures, and discards late results when the credential generation changes
 * mid-discovery — so a previous account's availability can never be presented
 * as the current one.
 *
 * The connection identity is a locally persisted credential-change generation
 * (`settings.ai_model_catalog_generation_<provider>`), not an account name or
 * identifier. It is stable across restarts (the cached snapshot renders
 * immediately on launch) and changes on login, logout, or credential
 * replacement.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import { getDb } from "@/lib/db/connection";
import type { AiBackendId } from "../backend-id";
import { readCatalogConnection, type CatalogConnection } from "./connection";
import { getAuthManager } from "../auth/manager";
import { bundledCatalogModels } from "./bundled";
import type { ModelDiscoveryAdapter } from "./adapters/types";
import { DiscoveryError } from "./adapters/types";
import { CodexModelDiscoveryAdapter } from "./adapters/codex";
import { OpenCodeModelDiscoveryAdapter } from "./adapters/opencode";
import { ClaudeModelDiscoveryAdapter } from "./adapters/claude";
import {
  deleteProviderCatalog,
  readProviderCatalog,
  recordCatalogFailure,
  recordCatalogSuccess,
} from "./repository";
import {
  CATALOG_DISCOVERY_TIMEOUT_MS,
  CATALOG_FRESHNESS_MS,
  isCatalogSnapshotFresh,
  type ModelCatalogSnapshot,
  type ProviderCatalogSnapshot,
} from "./types";

/** Backoff after consecutive failures; capped at five minutes. */
export const CATALOG_BACKOFF_BASE_MS = 30_000;
export const CATALOG_BACKOFF_MAX_MS = 5 * 60_000;

/** Manual refresh cooldown so a held button cannot spawn a storm. */
export const CATALOG_MANUAL_COOLDOWN_MS = 5_000;

const PROVIDERS: readonly AiBackendId[] = ["codex", "opencode", "claude"];

function generationKey(provider: AiBackendId): string {
  return `ai_model_catalog_generation_${provider}`;
}

/** Reads the persisted credential-change generation for one provider. */
export function readCatalogGeneration(db: ScopeDatabase, provider: AiBackendId): number {
  const row = db
    .prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
    .get(generationKey(provider));
  const parsed = row ? Number(row.value) : 1;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

/** Bumps the persisted credential-change generation for one provider. */
export function bumpCatalogGeneration(db: ScopeDatabase, provider: AiBackendId): number {
  const next = readCatalogGeneration(db, provider) + 1;
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(generationKey(provider), String(next));
  return next;
}

/** The opaque connection identity stored alongside a catalog snapshot. */
export function catalogConnectionKey(db: ScopeDatabase, provider: AiBackendId): string {
  return `${provider}:g${readCatalogGeneration(db, provider)}`;
}

export interface ModelCatalogDeps {
  /** The database, or a getter so long-lived services never cache a stale connection. */
  db: ScopeDatabase | (() => ScopeDatabase);
  /** Per-provider adapter overrides (tests inject fixtures). */
  adapters?: Partial<Record<AiBackendId, ModelDiscoveryAdapter>>;
  /** Overrides the connection identity (tests). */
  identity?: (provider: AiBackendId) => string;
  /** Production connection probe; injected separately from discovery for tests. */
  connection?: (provider: AiBackendId) => Promise<CatalogConnection>;
  /** Discovery timeout; defaults to 15 seconds. */
  timeoutMs?: number;
  /** Clock override (tests). */
  now?: () => number;
}

export interface RefreshOptions {
  /** Bypass the freshness TTL but respect backoff (post-error retry). */
  force?: boolean;
  /** Explicit user retry: bypasses backoff, resets it, applies cooldown. */
  manual?: boolean;
  /** Caller-held database override so a late refresh never reopens one. */
  db?: ScopeDatabase;
}

export class ModelCatalogService {
  private readonly db: () => ScopeDatabase;
  private readonly adapters: Record<AiBackendId, ModelDiscoveryAdapter>;
  private readonly identityOf: (provider: AiBackendId) => string;
  private readonly connectionProbe?: ModelCatalogDeps["connection"];
  private readonly connectionChecks = new Map<AiBackendId, Promise<boolean>>();
  private readonly connected = new Map<AiBackendId, boolean>();
  private readonly connectionErrors = new Map<AiBackendId, string>();
  private readonly epochs = new Map<AiBackendId, number>();
  private readonly activeControllers = new Map<AiBackendId, AbortController>();
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly inFlight = new Map<AiBackendId, Promise<ProviderCatalogSnapshot>>();
  private readonly failureCount = new Map<AiBackendId, number>();
  private readonly nextEligibleAt = new Map<AiBackendId, number>();
  private readonly manualCooldownUntil = new Map<AiBackendId, number>();
  private readonly controllers = new Set<AbortController>();
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  constructor(deps: ModelCatalogDeps) {
    const dbSource = deps.db;
    this.db = typeof dbSource === "function" ? dbSource : () => dbSource;
    this.adapters = {
      codex: deps.adapters?.codex ?? new CodexModelDiscoveryAdapter(),
      opencode: deps.adapters?.opencode ?? new OpenCodeModelDiscoveryAdapter(),
      claude: deps.adapters?.claude ?? new ClaudeModelDiscoveryAdapter(),
    };
    this.identityOf = deps.identity ?? ((provider) => catalogConnectionKey(this.db(), provider));
    this.connectionProbe = deps.connection;
    this.timeoutMs = deps.timeoutMs ?? CATALOG_DISCOVERY_TIMEOUT_MS;
    this.now = deps.now ?? (() => Date.now());
    const unsubscribe = getAuthManager().onProviderAuthChanged((provider) => {
      this.handleAuthChanged(provider);
    });
    this.disposers.push(unsubscribe);
  }

  /** True while a discovery for this provider is running. */
  isRefreshing(provider: AiBackendId): boolean {
    return this.inFlight.has(provider);
  }

  /**
   * Current snapshot for one provider; never throws on bad stored data. The
   * optional database override lets an in-flight caller (a chat turn holding
   * its own connection) resolve against that exact connection instead of
   * reopening the process-wide one late.
   */
  getSnapshot(provider: AiBackendId, db?: ScopeDatabase): ProviderCatalogSnapshot {
    const refreshing = this.inFlight.has(provider);
    const connected = this.connected.get(provider);
    const observedAt = this.now();
    const connectionError = this.connectionErrors.get(provider) ?? null;
    const generation = readCatalogGeneration(db ?? this.db(), provider);
    const stored = readProviderCatalog(db ?? this.db(), provider);
    const identity = this.identityOf(provider);
    const bundled = () => bundledCatalogModels(provider);
    if (
      connected === false ||
      (this.connectionProbe && connected === undefined && !this.connectionErrors.has(provider))
    ) {
      return {
        provider,
        state: "bundled",
        connectionKey: identity,
        generation,
        observedAt,
        revision: stored?.revision ?? 0,
        models: [],
        lastAttemptAt: null,
        lastSuccessAt: null,
        baselineAt: null,
        error: null,
        fallback: false,
        refreshing,
        connected,
      };
    }
    if (stored === null || stored.connectionKey !== identity) {
      return {
        provider,
        state: "bundled",
        connectionKey: identity,
        revision: 0,
        models: bundled(),
        lastAttemptAt: stored?.lastAttemptAt ?? null,
        lastSuccessAt: null,
        baselineAt: null,
        error: connectionError,
        fallback: true,
        refreshing,
        connected,
        generation,
        observedAt,
      };
    }
    if (stored.state === "failed" && stored.lastSuccessAt === null) {
      return {
        provider,
        state: "bundled",
        connectionKey: identity,
        revision: stored.revision,
        models: bundled(),
        lastAttemptAt: stored.lastAttemptAt,
        lastSuccessAt: null,
        baselineAt: null,
        error: connectionError ?? stored.lastError,
        fallback: true,
        refreshing,
        connected,
        generation,
        observedAt,
      };
    }
    return {
      provider,
      // A failed attempt after a successful snapshot keeps the models but
      // reports the failure honestly.
      state: stored.state,
      connectionKey: identity,
      revision: stored.revision,
      models: stored.models,
      lastAttemptAt: stored.lastAttemptAt,
      lastSuccessAt: stored.lastSuccessAt,
      baselineAt: stored.baselineAt,
      error: connectionError ?? stored.lastError,
      fallback: false,
      refreshing,
      connected,
      generation,
      observedAt,
    };
  }

  /** Every provider's snapshot plus one shared timestamp. */
  getFullSnapshot(): ModelCatalogSnapshot {
    return {
      checkedAt: new Date().toISOString(),
      providers: {
        codex: this.getSnapshot("codex"),
        opencode: this.getSnapshot("opencode"),
        claude: this.getSnapshot("claude"),
      },
    };
  }

  /**
   * Refreshes one provider's catalog. Concurrent calls share one discovery.
   * Automatic calls skip fresh snapshots and respect failure backoff; a
   * manual call bypasses both but still shares in-flight work.
   */
  async refresh(
    provider: AiBackendId,
    options: RefreshOptions = {},
  ): Promise<ProviderCatalogSnapshot> {
    if (this.disposed) {
      return this.getSnapshot(provider, options.db);
    }
    if (!(await this.checkConnection(provider))) {
      return this.getSnapshot(provider, options.db);
    }
    const existing = this.inFlight.get(provider);
    if (existing !== undefined) {
      return existing;
    }
    const now = this.now();
    if (options.manual === true) {
      if (now < (this.manualCooldownUntil.get(provider) ?? 0)) {
        return this.getSnapshot(provider, options.db);
      }
    } else {
      if (
        !options.force &&
        isCatalogSnapshotFresh(this.getSnapshot(provider, options.db), CATALOG_FRESHNESS_MS, now)
      ) {
        return this.getSnapshot(provider, options.db);
      }
      if (now < (this.nextEligibleAt.get(provider) ?? 0)) {
        return this.getSnapshot(provider, options.db);
      }
    }
    if (options.manual === true) {
      this.failureCount.delete(provider);
      this.nextEligibleAt.delete(provider);
    }
    const promise = this.runRefresh(provider, options.db).finally(() => {
      if (this.inFlight.get(provider) === promise) this.inFlight.delete(provider);
    });
    this.inFlight.set(provider, promise);
    if (options.manual === true) {
      this.manualCooldownUntil.set(provider, now + CATALOG_MANUAL_COOLDOWN_MS);
    }
    return promise;
  }

  /** Refreshes every provider independently; one failure cannot block others. */
  async refreshAll(options: RefreshOptions = {}): Promise<ModelCatalogSnapshot> {
    await Promise.allSettled(PROVIDERS.map((provider) => this.refresh(provider, options)));
    return this.getFullSnapshot();
  }

  /**
   * Drops the cached snapshot for a provider and resets backoff, then
   * refreshes in the background. Called when credentials change.
   */
  private handleAuthChanged(provider: AiBackendId): void {
    if (this.disposed) {
      return;
    }
    this.resetConnection(provider);
    // Let the auth operation finish before probing; never re-discover while signed out.
    queueMicrotask(() => {
      if (!this.disposed) void this.refresh(provider, { force: true }).catch(() => {});
    });
  }

  private resetConnection(provider: AiBackendId): void {
    this.epochs.set(provider, (this.epochs.get(provider) ?? 0) + 1);
    this.activeControllers.get(provider)?.abort();
    this.inFlight.delete(provider);
    bumpCatalogGeneration(this.db(), provider);
    deleteProviderCatalog(this.db(), provider);
    this.failureCount.delete(provider);
    this.nextEligibleAt.delete(provider);
    this.manualCooldownUntil.delete(provider);
  }

  /** Recheck account/runtime even when the catalog TTL has not elapsed. */
  async checkConnection(provider: AiBackendId): Promise<boolean> {
    if (!this.connectionProbe) return true;
    const pending = this.connectionChecks.get(provider);
    if (pending) return pending;
    const check = (async () => {
      try {
        const connection = await this.connectionProbe!(provider);
        if (this.disposed) return false;
        const db = this.db();
        const key = `ai_model_catalog_identity_${provider}`;
        const previous = db
          .prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
          .get(key);
        if (previous?.value !== connection.identity) {
          this.resetConnection(provider);
          db.prepare(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          ).run(key, connection.identity);
        }
        this.connectionErrors.delete(provider);
        this.connected.set(provider, connection.connected);
        return connection.connected;
      } catch {
        // A failed probe is not a sign-out. Retain the last known catalog,
        // visibly stale, but do not launch discovery against unknown credentials.
        this.connectionErrors.set(
          provider,
          "Could not verify the provider connection. Showing the last known list.",
        );
        return false;
      }
    })().finally(() => this.connectionChecks.delete(provider));
    this.connectionChecks.set(provider, check);
    return check;
  }

  async readSnapshot(): Promise<ModelCatalogSnapshot> {
    await Promise.allSettled(PROVIDERS.map((provider) => this.checkConnection(provider)));
    return this.getFullSnapshot();
  }

  /** Drops the cached snapshot without refreshing; intended for tests. */
  invalidate(provider: AiBackendId): void {
    deleteProviderCatalog(this.db(), provider);
    this.failureCount.delete(provider);
    this.nextEligibleAt.delete(provider);
  }

  private backoffMs(provider: AiBackendId): number {
    const failures = this.failureCount.get(provider) ?? 1;
    return Math.min(CATALOG_BACKOFF_BASE_MS * 2 ** (failures - 1), CATALOG_BACKOFF_MAX_MS);
  }

  private async runRefresh(
    provider: AiBackendId,
    db?: ScopeDatabase,
  ): Promise<ProviderCatalogSnapshot> {
    const database = db ?? this.db();
    const identity = this.identityOf(provider);
    const epoch = this.epochs.get(provider) ?? 0;
    const current = () =>
      !this.disposed &&
      this.identityOf(provider) === identity &&
      (this.epochs.get(provider) ?? 0) === epoch;
    const attemptedAt = new Date(this.now()).toISOString();
    const controller = new AbortController();
    this.controllers.add(controller);
    this.activeControllers.set(provider, controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new DiscoveryError("Model discovery timed out or was cancelled.")),
          { once: true },
        );
      });
      const outcome = await Promise.race([
        this.adapters[provider].discover({ signal: controller.signal }),
        aborted,
      ]);
      // Authentication may have changed externally during the probe.
      const stillConnected = await this.checkConnection(provider);
      if (!stillConnected || !current() || controller.signal.aborted) {
        // Credentials changed mid-discovery; the result belongs to the old
        // connection and must not be published.
        return this.getSnapshot(provider, db);
      }
      recordCatalogSuccess(database, provider, {
        connectionKey: identity,
        runtimeVersion: outcome.runtimeVersion,
        models: outcome.models,
        source: outcome.source,
        now: attemptedAt,
      });
      this.failureCount.delete(provider);
      this.nextEligibleAt.delete(provider);
    } catch (error) {
      const message =
        error instanceof DiscoveryError ? error.message : "Model discovery failed unexpectedly.";
      if (error instanceof DiscoveryError) {
        console.warn(`[ai/models] ${provider} discovery failed: ${message}`);
      } else {
        console.error(`[ai/models] ${provider} discovery failed:`, error);
      }
      if (current()) {
        recordCatalogFailure(database, provider, {
          connectionKey: identity,
          error: message,
          now: attemptedAt,
        });
      }
      if (!current()) return this.getSnapshot(provider, db);
      const failures = (this.failureCount.get(provider) ?? 0) + 1;
      this.failureCount.set(provider, failures);
      this.nextEligibleAt.set(provider, this.now() + this.backoffMs(provider));
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      if (this.activeControllers.get(provider) === controller)
        this.activeControllers.delete(provider);
    }
    return this.getSnapshot(provider, db);
  }

  /** Aborts in-flight discoveries; safe to call from a shutdown hook. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers.clear();
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

const CATALOG_KEY = Symbol.for("scope.ai.model-catalog.v1");
const CATALOG_SHUTDOWN_KEY = Symbol.for("scope.ai.model-catalog.shutdown.v1");

interface CatalogGlobal {
  [CATALOG_KEY]?: ModelCatalogService;
  [CATALOG_SHUTDOWN_KEY]?: boolean;
}

function installShutdownHook(): void {
  const globalState = globalThis as CatalogGlobal;
  if (globalState[CATALOG_SHUTDOWN_KEY]) {
    return;
  }
  globalState[CATALOG_SHUTDOWN_KEY] = true;
  process.once("exit", () => {
    globalState[CATALOG_KEY]?.dispose();
  });
}

/** The process-wide catalog service; every route bundle shares this instance. */
export function getModelCatalog(): ModelCatalogService {
  const globalState = globalThis as CatalogGlobal;
  if (globalState[CATALOG_KEY] === undefined) {
    const service = new ModelCatalogService({
      db: () => getDb(),
      connection: readCatalogConnection,
    });
    globalState[CATALOG_KEY] = service;
    installShutdownHook();
  }
  return globalState[CATALOG_KEY];
}

/** Installs a service (tests use an injected one); never used in production. */
export function setModelCatalogForTests(service: ModelCatalogService | null): void {
  const globalState = globalThis as CatalogGlobal;
  if (service === null) {
    globalState[CATALOG_KEY]?.dispose();
    delete globalState[CATALOG_KEY];
    return;
  }
  globalState[CATALOG_KEY] = service;
}
