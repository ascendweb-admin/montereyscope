/**
 * Shared content-source references. A selected source is a kind + id pair:
 * `video` refers to a cached video row, `tweet` to a cached X post. UI keys
 * are derived from both fields; tweets never masquerade as videos. Pure —
 * safe to import from client components.
 */

export type ContentKind = "video" | "tweet";

export interface SourceRef {
  kind: ContentKind;
  id: string;
}

/** Stable, collision-free key for selection sets, arrays, and React keys. */
export function sourceKey(ref: SourceRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function isSourceRef(value: unknown): value is SourceRef {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.kind === "video" || record.kind === "tweet") &&
    typeof record.id === "string" &&
    record.id.trim().length > 0
  );
}

/**
 * Normalizes a user/API-provided source list: validates every entry, trims
 * ids, collapses duplicates by key, and preserves request order.
 * Returns null when any entry is malformed.
 */
export function normalizeSourceRefs(value: unknown): SourceRef[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const seen = new Set<string>();
  const refs: SourceRef[] = [];
  for (const entry of value) {
    if (!isSourceRef(entry)) {
      return null;
    }
    const ref: SourceRef = { kind: entry.kind, id: entry.id.trim() };
    const key = sourceKey(ref);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

/** Legacy video-only id list → source refs, preserving order. */
export function videoIdsToSourceRefs(videoIds: readonly string[]): SourceRef[] {
  const seen = new Set<string>();
  const refs: SourceRef[] = [];
  for (const raw of videoIds) {
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    refs.push({ kind: "video", id });
  }
  return refs;
}

/** Only the video ids of a ref list, in order — for legacy columns/payloads. */
export function sourceRefsToVideoIds(refs: readonly SourceRef[]): string[] {
  return refs.filter((ref) => ref.kind === "video").map((ref) => ref.id);
}

/** Versioned persistence document for selections (threads and reports). */
export interface SourceRefsDocument {
  version: 1;
  sources: SourceRef[];
}

export function encodeSourceRefs(refs: readonly SourceRef[]): string {
  const document: SourceRefsDocument = { version: 1, sources: [...refs] };
  return JSON.stringify(document);
}

/** Parses a stored document; accepts a bare array for forward compatibility. */
export function decodeSourceRefs(json: string | null | undefined): SourceRef[] | null {
  if (json == null || json.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return normalizeSourceRefs(parsed);
    }
    if (typeof parsed === "object" && parsed !== null) {
      const document = parsed as Partial<SourceRefsDocument>;
      if (document.version === 1) {
        return normalizeSourceRefs(document.sources);
      }
    }
    return null;
  } catch {
    return null;
  }
}
