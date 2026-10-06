/**
 * AI run accounting (provider-auth stage). Server-only, dependency-free.
 *
 * Signing a provider out while it is answering a chat turn or writing a
 * report would leave that run authenticated against a credential that no
 * longer exists. This module is the single place that knows which providers
 * have work in flight and which are mid-sign-out, so backend dispatch can
 * refuse new runs during a sign-out and the logout route can refuse while a
 * run is active. It intentionally has no imports so both the backend
 * dispatcher and the auth manager can share it without a cycle.
 */
import type { AiBackendId } from "./backend-id";

const activeRuns = new Map<AiBackendId, number>();
const signingOut = new Set<AiBackendId>();

/** Increments the provider's run count; returns the matching release. */
export function beginAiRun(backend: AiBackendId): () => void {
  activeRuns.set(backend, (activeRuns.get(backend) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const next = (activeRuns.get(backend) ?? 1) - 1;
    if (next <= 0) {
      activeRuns.delete(backend);
    } else {
      activeRuns.set(backend, next);
    }
  };
}

/** Number of AI runs currently in flight for the provider. */
export function activeAiRuns(backend: AiBackendId): number {
  return activeRuns.get(backend) ?? 0;
}

/** True while the provider is answering a turn or writing a report. */
export function isAiProviderBusy(backend: AiBackendId): boolean {
  return activeAiRuns(backend) > 0;
}

/** Marks the provider as settling a sign-out; new runs must wait. */
export function setProviderSigningOut(backend: AiBackendId, value: boolean): void {
  if (value) {
    signingOut.add(backend);
  } else {
    signingOut.delete(backend);
  }
}

/** True while the provider is mid-sign-out. */
export function isProviderSigningOut(backend: AiBackendId): boolean {
  return signingOut.has(backend);
}
