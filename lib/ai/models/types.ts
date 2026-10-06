/**
 * Provider model catalog contract (dynamic catalog stage). Browser-safe — no
 * Node imports.
 *
 * The catalog is the one vocabulary that Settings renders, the settings
 * validator accepts, and the chat/report layers resolve into runtime ids. It
 * comes from one of two places:
 *
 * - a live provider discovery snapshot persisted in SQLite, or
 * - the bundled catalog in `lib/ai/model-catalog.ts`, which remains the
 *   first-run/degraded fallback.
 *
 * Capability fields are deliberately open: provider-reported effort ids are
 * bounded strings, not a closed cross-provider enum, so a new provider variant
 * never breaks discovery. `effortsKnown` distinguishes "the provider told us
 * this model has no selectable efforts" from "we could not determine
 * capabilities"; only the former may be rendered as a confirmed lack.
 *
 * Runtime compatibility and access are separate axes. A model can be listed
 * in a provider's public catalog (access evidence: `catalog`) while the
 * installed runtime cannot resolve it yet (`runtimeCompatibility:
 * "unsupported"`), and vice versa. Nothing here proves subscription
 * entitlement or remaining quota.
 */
import type { AiBackendId } from "../backend-id";

/** How long a successful discovery stays fresh enough to skip a new refresh. */
export const CATALOG_FRESHNESS_MS = 5 * 60_000;

/** How long a newly discovered model keeps its `New` badge. */
export const NEW_MODEL_BADGE_MS = 7 * 24 * 60 * 60_000;

/** Per-provider discovery timeout; tests may inject a shorter one. */
export const CATALOG_DISCOVERY_TIMEOUT_MS = 15_000;

/** Bounded effort-option id: provider values are untrusted input. */
export const MAX_EFFORT_ID_LENGTH = 64;

/** Bounded public model id length. */
export const MAX_MODEL_ID_LENGTH = 160;

/** Optional provider-supplied suggestion to move to another model. */
export interface CatalogUpgradeHint {
  /** Public or runtime id of the suggested model. */
  modelId: string;
  /** Provider copy explaining why, client-safe; null when absent. */
  message: string | null;
}

/** One selectable reasoning variant exposed by a model. */
export interface CatalogReasoningOption {
  id: string;
  label: string;
  description: string;
}

/**
 * Whether the installed runtime can resolve this model right now. Unknown is
 * honest: a provider that exposes no version metadata must not be reported as
 * either supported or broken.
 */
export type ModelRuntimeCompatibility = "supported" | "unsupported" | "unknown";

/**
 * What evidence exists that the connected account can use this model. `catalog`
 * only means the provider lists it publicly; it is not proof of access.
 */
export type ModelAccessEvidence = "account" | "credential" | "catalog" | "unknown";

/** Where one catalog row came from. */
export type ModelCatalogSource = "bundled" | "discovered";

/**
 * Snapshot-level state. `bundled` means no authoritative snapshot exists yet
 * (first run or failed discovery with no cache); `live` and `empty` are both
 * successful authoritative results; `failed` retains whatever snapshot was
 * last successful while surfacing the error.
 */
export type ModelCatalogState = "bundled" | "live" | "empty" | "failed";

/** One normalized model entry shown and persisted by scope. */
export interface CatalogModel {
  provider: AiBackendId;
  /** Stable public id shown and persisted by scope. */
  id: string;
  /** Exact id the provider's CLI expects at execution time. */
  runtimeId: string;
  label: string;
  description: string;
  /** Selectable effort variants in provider order; [] when there are none. */
  reasoningOptions: CatalogReasoningOption[];
  /** Provider default effort; null when the provider named none. */
  defaultReasoningEffort: string | null;
  /** False when capabilities could not be determined. */
  effortsKnown: boolean;
  runtimeCompatibility: ModelRuntimeCompatibility;
  access: ModelAccessEvidence;
  /** Aliased runtime target (for example `sonnet` → `claude-sonnet-5`). */
  aliasTarget: string | null;
  /** True when the provider recommends this model as a default. */
  recommended: boolean;
  upgrade: CatalogUpgradeHint | null;
  source: ModelCatalogSource;
  /** First time discovery observed this model; null for bundled entries. */
  firstSeenAt: string | null;
}

/** One provider's catalog snapshot, safe to send to the browser. */
export interface ProviderCatalogSnapshot {
  /** Whether the server verified a usable connection; absent before the first probe. */
  connected?: boolean;
  /** Persisted monotonic connection generation, ordered across account changes. */
  generation?: number;
  /** Observation time also orders status-only responses at the same revision. */
  observedAt?: number;
  provider: AiBackendId;
  state: ModelCatalogState;
  /**
   * Opaque local credential-generation identity. The client replaces its
   * cached snapshot whenever this changes, so a lower revision from a new
   * connection is never mistaken for a stale response.
   */
  connectionKey: string;
  /** Monotonic per provider; the client drops stale responses. */
  revision: number;
  models: CatalogModel[];
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /**
   * When the first authoritative discovery established the baseline; models
   * first seen after it (and within the badge window) are new to the user.
   * Null for the bundled fallback.
   */
  baselineAt: string | null;
  /** Client-safe failure message; diagnostics stay in server logs. */
  error: string | null;
  /** True when a snapshot currently comes from the bundled fallback. */
  fallback: boolean;
  /** Client hint that a refresh is currently running. */
  refreshing: boolean;
}

/** Every provider's snapshot plus one shared timestamp. */
export interface ModelCatalogSnapshot {
  checkedAt: string;
  providers: Record<AiBackendId, ProviderCatalogSnapshot>;
}

/** The safe empty snapshot used before any provider has been read. */
export function emptyCatalogSnapshot(): ModelCatalogSnapshot {
  const provider = (id: AiBackendId): ProviderCatalogSnapshot => ({
    provider: id,
    state: "bundled",
    connectionKey: "bundled",
    revision: 0,
    models: [],
    lastAttemptAt: null,
    lastSuccessAt: null,
    baselineAt: null,
    error: null,
    fallback: true,
    refreshing: false,
  });
  return {
    checkedAt: new Date(0).toISOString(),
    providers: {
      codex: provider("codex"),
      opencode: provider("opencode"),
      claude: provider("claude"),
    },
  };
}

/** Bounds and trims an untrusted provider string before it enters the catalog. */
export function sanitizeCatalogText(value: unknown, maxLength = MAX_MODEL_ID_LENGTH): string {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function isModelId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_MODEL_ID_LENGTH;
}

/** Finds one model by public id, or null. */
export function findCatalogModel(models: readonly CatalogModel[], id: string): CatalogModel | null {
  return models.find((model) => model.id === id) ?? null;
}

/** True when a model is selectable for execution right now. */
export function isCatalogModelUsable(model: CatalogModel): boolean {
  return model.runtimeCompatibility === "supported";
}

/**
 * Validates one reasoning effort against a model's capabilities. Returns null
 * when it is acceptable: unknown capabilities accept any bounded id (the
 * provider default is used upstream), a confirmed list must contain it.
 */
export function validateEffortForModel(model: CatalogModel, effort: string | null): boolean {
  if (effort === null) {
    return true;
  }
  if (!model.effortsKnown) {
    return isModelId(effort) && effort.length <= MAX_EFFORT_ID_LENGTH;
  }
  return model.reasoningOptions.some((option) => option.id === effort);
}

/**
 * True when the model should show the `New` badge: first observed strictly
 * after the provider's initial baseline and less than seven days ago. The
 * whole first discovered catalog shares the baseline timestamp and is never
 * badged.
 */
export function isNewCatalogModel(
  model: CatalogModel,
  baselineAt: string | null,
  nowMs = Date.now(),
): boolean {
  if (model.firstSeenAt === null || baselineAt === null) {
    return false;
  }
  const seen = Date.parse(model.firstSeenAt);
  const baseline = Date.parse(baselineAt);
  if (!Number.isFinite(seen) || !Number.isFinite(baseline) || seen <= baseline) {
    return false;
  }
  const age = nowMs - seen;
  return age >= 0 && age < NEW_MODEL_BADGE_MS;
}

/**
 * True when a snapshot is fresh enough that an automatic refresh may skip it.
 * Only successful authoritative states (live/empty) are fresh; bundled and
 * failed snapshots always deserve a retry within their backoff window.
 */
export function isCatalogSnapshotFresh(
  snapshot: ProviderCatalogSnapshot,
  maxAgeMs = CATALOG_FRESHNESS_MS,
  nowMs = Date.now(),
): boolean {
  if (snapshot.state !== "live" && snapshot.state !== "empty") {
    return false;
  }
  if (snapshot.lastSuccessAt === null) {
    return false;
  }
  const at = Date.parse(snapshot.lastSuccessAt);
  return Number.isFinite(at) && nowMs - at < maxAgeMs;
}
