import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChatSource } from "@/lib/content/chat-source";
import { sourceKey, type SourceRef } from "@/lib/content/model";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Who a video is cited under. A manifest entry names the hosting channel in
 * `creator`; when it also lists the people it features, the citation reads
 * "{person} on {channel}", labelled with the first person who is not the
 * channel itself (the same rule the feed and the picker use). Entries from
 * before that field existed have no `featuring`, and read exactly as they did.
 */
function citedCreator(entry: Record<string, unknown>): Pick<ChatSource, "creator" | "channelName"> {
  const channel = typeof entry.creator === "string" ? entry.creator : undefined;
  const featuring = Array.isArray(entry.featuring)
    ? entry.featuring.filter(
        (name): name is string => typeof name === "string" && name.trim().length > 0,
      )
    : [];
  const person = featuring.find((name) => name !== channel);
  return person !== undefined && channel !== undefined
    ? { creator: person, channelName: channel }
    : { creator: channel };
}

/** Saved conversations keep their citations when their live feed cache is evicted. */
export function archivedChatSources(workDir: string, selected: readonly SourceRef[]): ChatSource[] {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(workDir, "manifest.json"), "utf8"));
    if (!record(manifest)) return [];
    const entries =
      manifest.version === 2 && Array.isArray(manifest.sources)
        ? manifest.sources
        : manifest.version === undefined &&
            record(manifest.scope) &&
            Array.isArray(manifest.scope.videos)
          ? manifest.scope.videos.filter(record).map((video) => ({
              ...video,
              kind: "video",
              platform: "youtube",
              readyForAnalysis: video.hasTranscript,
            }))
          : [];
    const wanted = new Set(selected.map(sourceKey));
    const sources: ChatSource[] = [];
    for (const entry of entries) {
      if (
        !record(entry) ||
        (entry.kind !== "video" && entry.kind !== "tweet") ||
        typeof entry.id !== "string" ||
        typeof entry.title !== "string" ||
        !entry.readyForAnalysis ||
        !wanted.has(sourceKey({ kind: entry.kind, id: entry.id }))
      )
        continue;
      let url: string | undefined;
      try {
        const parsed = new URL(String(entry.url));
        if (parsed.protocol === "https:" || parsed.protocol === "http:") url = parsed.href;
      } catch {
        /* Legacy snapshots may have no URL. */
      }
      sources.push({
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        // Old post manifests name the saved account, which may have reposted
        // someone else. Its post title and original URL remain unambiguous.
        ...(entry.kind === "video" ? citedCreator(entry) : {}),
        platform:
          entry.platform === "youtube" || entry.platform === "rumble" ? entry.platform : undefined,
        url,
        publishedAt: typeof entry.publishedAt === "string" ? entry.publishedAt : null,
        durationSeconds:
          typeof entry.durationSeconds === "number" && Number.isFinite(entry.durationSeconds)
            ? entry.durationSeconds
            : null,
      });
    }
    return sources;
  } catch {
    // Missing or old/corrupt job files must not prevent reading the conversation.
    return [];
  }
}
