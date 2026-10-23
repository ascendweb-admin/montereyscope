/**
 * Likely-same-person matching. Pure (no database), so the add flow and the
 * link dialog can run it in the browser while the library's suggestions run
 * it on the server: a person is suggested, never linked, on an exact
 * normalized name match or a shared handle.
 */

/** Lowercase, accent-free, letters and digits only: "Jané Doe!" → "janedoe". */
export function normalizeIdentity(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export interface IdentityCandidate {
  displayName: string;
  handles: readonly (string | null)[];
}

/**
 * True when two identities plausibly name the same person: the same
 * normalized display name, a shared handle, or one side's handle spelling the
 * other's name. Keys shorter than three characters never match on their own.
 */
export function identitiesMatch(a: IdentityCandidate, b: IdentityCandidate): boolean {
  const keysOf = (candidate: IdentityCandidate): Set<string> =>
    new Set(
      [candidate.displayName, ...candidate.handles]
        .map(normalizeIdentity)
        .filter((key) => key.length >= 3),
    );
  const left = keysOf(a);
  for (const key of keysOf(b)) {
    if (left.has(key)) {
      return true;
    }
  }
  return false;
}
