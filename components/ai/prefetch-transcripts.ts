"use client";

/**
 * Fire-and-forget transcript prefetch: asks the server to start fetching
 * captions for videos the user just picked, so the first chat answer does
 * not wait on them. Each video is requested at most once per page session;
 * the server skips videos that already have a transcript.
 */
const requested = new Set<string>();

export function prefetchTranscripts(videoIds: readonly string[]): void {
  const fresh = [...new Set(videoIds)].filter((id) => !requested.has(id));
  if (fresh.length === 0) {
    return;
  }
  for (const id of fresh) {
    requested.add(id);
  }
  void fetch("/api/ai/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ videoIds: fresh }),
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
    })
    .catch(() => {
      // Purely an optimization: the chat turn fetches whatever is missing.
      for (const id of fresh) {
        requested.delete(id);
      }
    });
}
