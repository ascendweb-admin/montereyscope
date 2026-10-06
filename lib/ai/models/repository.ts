/**
 * Catalog snapshot persistence (dynamic catalog stage). Server-only.
 *
 * One SQLite row per provider holds the last authoritative snapshot keyed by
 * an opaque connection identity (the credential generation, never an account
 * identifier). Writes are atomic: success replaces models and computes
 * first-seen timestamps in one transaction; failure only records the attempt
 * and error, retaining the last successful models. Tokens, keys, and account
 * identifiers never reach this table.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import type { AiBackendId } from "../backend-id";
import type { CatalogModel } from "./types";
import { sanitizeCatalogText, MAX_EFFORT_ID_LENGTH, MAX_MODEL_ID_LENGTH } from "./types";

/** A model draft before the repository assigns identity and first-seen time. */
export type CatalogModelDraft = Omit<CatalogModel, "provider" | "source" | "firstSeenAt"> & {
  firstSeenAt?: string | null;
};

export interface StoredProviderCatalog {
  provider: AiBackendId;
  connectionKey: string;
  runtimeVersion: string | null;
  state: "live" | "empty" | "failed";
  revision: number;
  models: CatalogModel[];
  source: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  baselineAt: string | null;
  updatedAt: string;
}

interface CatalogRow {
  provider: string;
  connection_key: string;
  runtime_version: string | null;
  state: string;
  revision: number;
  models: string;
  source: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  baseline_at: string | null;
  updated_at: string;
}

const PROVIDERS: readonly AiBackendId[] = ["codex", "opencode", "claude"];

function isProvider(value: unknown): value is AiBackendId {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parses one stored model entry, dropping anything malformed. */
function parseCatalogModel(raw: unknown): CatalogModel | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const provider = record.provider;
  const id = record.id;
  const runtimeId = record.runtimeId;
  if (
    !isProvider(provider) ||
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > MAX_MODEL_ID_LENGTH ||
    typeof runtimeId !== "string" ||
    runtimeId.length === 0 ||
    runtimeId.length > MAX_MODEL_ID_LENGTH
  ) {
    return null;
  }
  const optionsRaw = Array.isArray(record.reasoningOptions) ? record.reasoningOptions : [];
  const reasoningOptions = optionsRaw.flatMap((entry) => {
    const option = asRecord(entry);
    if (option === null) {
      return [];
    }
    const optionId = sanitizeCatalogText(option.id, MAX_EFFORT_ID_LENGTH);
    if (optionId.length === 0) {
      return [];
    }
    return [
      {
        id: optionId,
        label: sanitizeCatalogText(option.label, 80) || optionId,
        description: sanitizeCatalogText(option.description, 240),
      },
    ];
  });
  const compatibility = record.runtimeCompatibility;
  const access = record.access;
  const source = record.source;
  const upgradeRaw = asRecord(record.upgrade);
  const upgrade = upgradeRaw
    ? {
        modelId: sanitizeCatalogText(upgradeRaw.modelId, MAX_MODEL_ID_LENGTH),
        message: sanitizeCatalogText(upgradeRaw.message, 400) || null,
      }
    : null;
  return {
    provider,
    id,
    runtimeId,
    label: sanitizeCatalogText(record.label, 120) || id,
    description: sanitizeCatalogText(record.description, 400),
    reasoningOptions,
    defaultReasoningEffort:
      typeof record.defaultReasoningEffort === "string" &&
      record.defaultReasoningEffort.length <= MAX_EFFORT_ID_LENGTH
        ? record.defaultReasoningEffort
        : null,
    effortsKnown: record.effortsKnown === true,
    runtimeCompatibility:
      compatibility === "supported" || compatibility === "unsupported" ? compatibility : "unknown",
    access:
      access === "account" || access === "credential" || access === "catalog" ? access : "unknown",
    aliasTarget:
      typeof record.aliasTarget === "string" && record.aliasTarget.length > 0
        ? record.aliasTarget.slice(0, MAX_MODEL_ID_LENGTH)
        : null,
    recommended: record.recommended === true,
    // A malformed upgrade hint degrades to none rather than a broken link.
    upgrade: upgrade && upgrade.modelId.length > 0 ? upgrade : null,
    source: source === "discovered" ? "discovered" : "bundled",
    firstSeenAt:
      typeof record.firstSeenAt === "string" && Number.isFinite(Date.parse(record.firstSeenAt))
        ? record.firstSeenAt
        : null,
  };
}

function parseCatalogModels(json: string): CatalogModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((entry) => {
    const model = parseCatalogModel(entry);
    return model ? [model] : [];
  });
}

function toStored(row: CatalogRow): StoredProviderCatalog {
  const provider = isProvider(row.provider) ? row.provider : "codex";
  const state = row.state === "live" || row.state === "empty" ? row.state : "failed";
  return {
    provider,
    connectionKey: row.connection_key,
    runtimeVersion: row.runtime_version,
    state,
    revision: Number(row.revision),
    models: parseCatalogModels(row.models),
    source: row.source,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    baselineAt: row.baseline_at,
    updatedAt: row.updated_at,
  };
}

/** Reads one provider's stored snapshot; null when nothing is cached. */
export function readProviderCatalog(
  db: ScopeDatabase,
  provider: AiBackendId,
): StoredProviderCatalog | null {
  const row = db
    .prepare<[string], CatalogRow>("SELECT * FROM ai_model_catalog WHERE provider = ?")
    .get(provider);
  return row ? toStored(row) : null;
}

export interface CatalogSuccessInput {
  connectionKey: string;
  runtimeVersion: string | null;
  /** Complete, validated model list; [] is a valid authoritative result. */
  models: readonly CatalogModelDraft[];
  source: string;
  now?: string;
}

/**
 * Atomically replaces one provider's snapshot after a complete discovery.
 * First-seen timestamps are preserved by id; models first observed after the
 * initial baseline get the discovery time (and therefore the `New` badge),
 * while the initial baseline itself stamps every model with the same time so
 * nothing in the first catalog is badged.
 */
export function recordCatalogSuccess(
  db: ScopeDatabase,
  provider: AiBackendId,
  input: CatalogSuccessInput,
): StoredProviderCatalog {
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    const previous = readProviderCatalog(db, provider);
    const sameConnection = previous !== null && previous.connectionKey === input.connectionKey;
    const baselineAt = sameConnection ? (previous.baselineAt ?? now) : now;
    const priorFirstSeen = new Map<string, string | null>();
    if (sameConnection && previous !== null) {
      for (const model of previous.models) {
        priorFirstSeen.set(model.id, model.firstSeenAt);
      }
    }
    const models: CatalogModel[] = input.models.map((draft) => ({
      ...draft,
      provider,
      source: "discovered",
      firstSeenAt: priorFirstSeen.get(draft.id) ?? now,
    }));
    const state: StoredProviderCatalog["state"] = models.length > 0 ? "live" : "empty";
    const revision = (sameConnection && previous !== null ? previous.revision : 0) + 1;
    db.prepare(
      `INSERT INTO ai_model_catalog
         (provider, connection_key, runtime_version, state, revision, models, source,
          last_attempt_at, last_success_at, last_error, baseline_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT (provider) DO UPDATE SET
         connection_key = excluded.connection_key,
         runtime_version = excluded.runtime_version,
         state = excluded.state,
         revision = excluded.revision,
         models = excluded.models,
         source = excluded.source,
         last_attempt_at = excluded.last_attempt_at,
         last_success_at = excluded.last_success_at,
         last_error = NULL,
         baseline_at = excluded.baseline_at,
         updated_at = excluded.updated_at`,
    ).run(
      provider,
      input.connectionKey,
      input.runtimeVersion,
      state,
      revision,
      JSON.stringify(models),
      input.source,
      now,
      now,
      baselineAt,
      now,
    );
    const stored = readProviderCatalog(db, provider);
    if (stored === null) {
      throw new Error(`Catalog snapshot for ${provider} vanished after write.`);
    }
    return stored;
  })();
}

export interface CatalogFailureInput {
  connectionKey: string;
  /** Client-safe message; diagnostics stay in server logs. */
  error: string;
  now?: string;
}

/**
 * Records a failed discovery attempt. The last successful models are retained
 * only when the connection identity is unchanged; a failure after an account
 * switch clears the previous account's availability rather than presenting it
 * as current.
 */
export function recordCatalogFailure(
  db: ScopeDatabase,
  provider: AiBackendId,
  input: CatalogFailureInput,
): StoredProviderCatalog {
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    const previous = readProviderCatalog(db, provider);
    const sameConnection = previous !== null && previous.connectionKey === input.connectionKey;
    if (previous === null || !sameConnection) {
      db.prepare(
        `INSERT INTO ai_model_catalog
           (provider, connection_key, runtime_version, state, revision, models, source,
            last_attempt_at, last_success_at, last_error, baseline_at, updated_at)
         VALUES (?, ?, NULL, 'failed', 1, '[]', NULL, ?, NULL, ?, NULL, ?)
         ON CONFLICT (provider) DO UPDATE SET
           connection_key = excluded.connection_key,
           runtime_version = NULL,
           state = 'failed',
           revision = excluded.revision,
           models = '[]',
           source = NULL,
           last_attempt_at = excluded.last_attempt_at,
           last_success_at = NULL,
           last_error = excluded.last_error,
           baseline_at = NULL,
           updated_at = excluded.updated_at`,
      ).run(provider, input.connectionKey, now, input.error, now);
    } else {
      db.prepare(
        `UPDATE ai_model_catalog
         SET state = 'failed', last_attempt_at = ?, last_error = ?,
             revision = revision + 1, updated_at = ?
         WHERE provider = ?`,
      ).run(now, input.error, now, provider);
    }
    const stored = readProviderCatalog(db, provider);
    if (stored === null) {
      throw new Error(`Catalog snapshot for ${provider} vanished after failure write.`);
    }
    return stored;
  })();
}

/** Removes one provider's cached snapshot (login/logout invalidation). */
export function deleteProviderCatalog(db: ScopeDatabase, provider: AiBackendId): void {
  db.prepare("DELETE FROM ai_model_catalog WHERE provider = ?").run(provider);
}

/** Removes every cached snapshot; intended for tests and maintenance. */
export function deleteAllProviderCatalogs(db: ScopeDatabase): void {
  db.prepare("DELETE FROM ai_model_catalog").run();
}
