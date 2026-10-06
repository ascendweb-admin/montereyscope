/**
 * Discovery adapter contract (dynamic catalog stage). Server-only.
 *
 * One adapter per provider turns a provider-specific, read-only discovery
 * procedure into normalized drafts. Adapters never write to the cache and
 * never submit prompts or run billable generation: they only ask the same
 * executable and authentication source that inference would use what it can
 * currently resolve. Failures are surfaced so the caller can retain the last
 * successful snapshot.
 */
import type { AiBackendId } from "../../backend-id";
import type { CatalogModelDraft } from "../repository";

/** Discovery is bounded by the caller's timeout signal. */
export interface DiscoveryContext {
  signal: AbortSignal;
}

/** A complete, authoritative discovery result ready to be stored. */
export interface DiscoveryOutcome {
  models: CatalogModelDraft[];
  /** Provider runtime version, when the discovery path reports one. */
  runtimeVersion: string | null;
  /** Human-readable, client-safe provenance (never a cache file path). */
  source: string;
}

export interface ModelDiscoveryAdapter {
  readonly provider: AiBackendId;
  discover(context: DiscoveryContext): Promise<DiscoveryOutcome>;
}

/** Raised when discovery cannot produce an authoritative catalog. */
export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}
