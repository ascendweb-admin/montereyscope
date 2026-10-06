import { ChatWorkspace } from "./chat-view";
import { listThreads, resolveScope } from "@/lib/ai";
import { listAllVideosWithCreator } from "@/lib/videos/service";
import { listFeedTweets } from "@/lib/x/repository";
import { normalizeSourceRefs, type SourceRef } from "@/lib/content/model";
import { getDb } from "@/lib/db/connection";
import { listCategories, listCreatorCategoryAssignments } from "@/lib/categories";

// Threads and the cached source lists live in SQLite and must reflect new
// turns, deletions, and refreshes immediately.
export const dynamic = "force-dynamic";

/** YouTube/Rumble video ids are short base64-ish or slug strings. */
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,20}$/;

/** X status ids are long decimal strings. */
const TWEET_ID_PATTERN = /^\d{1,20}$/;

interface ChatPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function parseThreadId(value: string | string[] | undefined): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

/**
 * Parses the ?videos= scope (comma-joined ids from the collapsed panel's
 * expand, or a previous new-chat draft): validation, dedupe, order kept.
 */
function parseScopeIds(value: string | string[] | undefined): string[] {
  const raw = typeof value === "string" ? value : "";
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id.length > 0 && VIDEO_ID_PATTERN.test(id) && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Parses the ?sources= mixed deep link (`video:id,tweet:id`), validating
 * against the cached library and preserving order.
 */
function parseSourceParams(
  value: string | string[] | undefined,
  knownVideoIds: ReadonlySet<string>,
  knownTweetIds: ReadonlySet<string>,
): SourceRef[] {
  const raw = typeof value === "string" ? value : "";
  const refs: SourceRef[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const kind = trimmed.slice(0, separator);
    const id = trimmed.slice(separator + 1);
    if (kind === "video" && knownVideoIds.has(id)) {
      refs.push({ kind: "video", id });
    } else if (kind === "tweet" && TWEET_ID_PATTERN.test(id) && knownTweetIds.has(id)) {
      refs.push({ kind: "tweet", id });
    }
  }
  return normalizeSourceRefs(refs) ?? [];
}

/**
 * The full-screen AI Chat workspace: every saved conversation across every
 * source collection in one sidebar, with a large canvas for the open one.
 * Pure reads — the page only feeds the workspace the library index (for
 * citations and the source picker), the thread summaries, and the deep-link
 * params the collapsed panel's "Open full view" navigates with.
 */
export default async function ChatPage({ searchParams }: ChatPageProps) {
  const db = getDb();
  const categories = listCategories(db);
  const assignments = listCreatorCategoryAssignments(db);

  const params = await searchParams;
  const requestedThreadId = parseThreadId(params.thread);

  const videos = listAllVideosWithCreator(db);
  const knownVideoIds = new Set(videos.map((video) => video.id));
  const tweetRecords = listFeedTweets(db);
  const knownTweetIds = new Set(tweetRecords.map((record) => record.tweet.id));

  const requestedVideoIds = parseScopeIds(params.videos).filter((id) => knownVideoIds.has(id));
  const requestedSources = parseSourceParams(params.sources, knownVideoIds, knownTweetIds);

  // Transcript availability comes from the shared scope resolver so every
  // chat surface agrees on what can ground a conversation.
  const scope = resolveScope(
    db,
    videos.map((video) => video.id),
  );
  const hasTranscriptByVideoId = new Map(
    scope.videos.map((video) => [video.id, video.hasTranscript]),
  );

  // A valid thread deep link wins over a pending scope; the thread's own
  // scope is what its conversation continues in.
  const initialThreadId = requestedThreadId;
  const initialVideoIds =
    requestedThreadId !== null || requestedSources.length > 0 ? [] : requestedVideoIds;
  const initialSources = requestedThreadId !== null ? [] : requestedSources;

  return (
    <ChatWorkspace
      videos={videos.map((video) => ({
        id: video.id,
        creatorId: video.creatorId,
        title: video.title,
        creatorName: video.creatorName,
        thumbnailUrl: video.thumbnailUrl,
        categoryIds: (assignments.get(video.creatorId) ?? []).map((category) => category.id),
        hasTranscript: hasTranscriptByVideoId.get(video.id) ?? false,
      }))}
      tweets={tweetRecords.map((record) => ({
        id: record.tweet.id,
        creatorId: record.creatorId,
        authorHandle: record.tweet.author.handle,
        authorName: record.tweet.author.displayName,
        url: record.tweet.url,
        publishedAt: record.tweet.publishedAt,
        text: record.tweet.text,
        mediaPreviewUrl: record.tweet.media[0]?.previewUrl ?? record.tweet.media[0]?.url ?? null,
        categoryIds: (assignments.get(record.creatorId) ?? []).map((category) => category.id),
        readyForAnalysis:
          record.tweet.contentStatus === "complete" && record.tweet.text.trim().length > 0,
      }))}
      categories={categories}
      initialThreads={listThreads(db).map((thread) => ({
        id: thread.id,
        researchJobId: thread.researchJobId,
        title: thread.title,
        videoIds: thread.videoIds,
        selectedSources: thread.selectedSources,
        messageCount: thread.messageCount,
        mode: thread.mode,
        createdAt: thread.createdAt,
        lastMessageAt: thread.lastMessageAt,
      }))}
      initialThreadId={initialThreadId}
      initialVideoIds={initialVideoIds}
      initialSources={initialSources}
    />
  );
}
