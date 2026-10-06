import { FeedView, type FeedItemModel } from "./feed-view";
import { listCreatorCategoryAssignments, listCategories } from "@/lib/categories";
import { listCreators } from "@/lib/creators/repository";
import { listFeedVideos } from "@/lib/videos/repository";
import { listFeedTweets } from "@/lib/x/repository";
import { getDb } from "@/lib/db/connection";

// The cached feed lives in SQLite and must reflect refreshes and transcript
// extractions immediately.
export const dynamic = "force-dynamic";

/** Descriptions render as a two-line snippet; keep the payload lean. */
const DESCRIPTION_SNIPPET_LENGTH = 240;

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DESCRIPTION_SNIPPET_LENGTH
    ? `${flat.slice(0, DESCRIPTION_SNIPPET_LENGTH).trimEnd()}…`
    : flat;
}

/**
 * The unified feed: the newest cached videos, livestreams, and X posts
 * across every saved creator, straight from the local cache. Pure reads —
 * extraction, fetching, and chat run from the row actions, and kind /
 * platform / category filtering happens on the prebuilt items in the client
 * view.
 */
export default function FeedPage() {
  const db = getDb();
  const creators = listCreators(db);
  const categories = listCategories(db);
  const assignments = listCreatorCategoryAssignments(db);
  const uncategorizedCreatorCount = creators.filter(
    (creator) => (assignments.get(creator.id) ?? []).length === 0,
  ).length;

  const videoItems: FeedItemModel[] = listFeedVideos(db).map((video) => ({
    kind: "video",
    id: video.id,
    creatorId: video.creatorId,
    creatorName: video.creatorName,
    creatorAvatarUrl: video.creatorAvatarUrl,
    creatorPlatform: video.creatorPlatform,
    title: video.title,
    url: video.url,
    thumbnailUrl: video.thumbnailUrl,
    publishedAt: video.publishedAt,
    durationSeconds: video.durationSeconds,
    liveStatus: video.liveStatus,
    description: video.description ? snippet(video.description) : null,
    hasTranscript: video.hasTranscript,
    categoryIds: (assignments.get(video.creatorId) ?? []).map((category) => category.id),
  }));

  const tweetItems: FeedItemModel[] = listFeedTweets(db).map((record) => {
    const tweet = record.tweet;
    return {
      kind: "tweet",
      id: tweet.id,
      creatorId: record.creatorId,
      creatorName: tweet.author.displayName,
      creatorAvatarUrl: tweet.author.avatarUrl,
      creatorPlatform: "x",
      text: snippet(tweet.text),
      fullText: tweet.text,
      url: tweet.url,
      publishedAt: tweet.publishedAt,
      timelineKind: record.timelineKind,
      authorHandle: tweet.author.handle,
      authorName: tweet.author.displayName,
      isRepost: tweet.isRepost,
      repostedByHandle: tweet.repostedByHandle,
      inReplyToHandle: tweet.inReplyToHandle,
      quotedText: tweet.quoted ? snippet(tweet.quoted.text) : null,
      replyCount: tweet.replyCount,
      repostCount: tweet.repostCount,
      likeCount: tweet.likeCount,
      mediaPreviewUrl: tweet.media[0]?.previewUrl ?? tweet.media[0]?.url ?? null,
      mediaCount: tweet.media.length,
      contentStatus: tweet.contentStatus,
      readyForAnalysis: tweet.contentStatus === "complete" && tweet.text.trim().length > 0,
      fetchedAt: record.fetchedAt,
      categoryIds: (assignments.get(record.creatorId) ?? []).map((category) => category.id),
    };
  });

  // Newest first across both kinds, undated items ahead (the established
  // cached-read ordering).
  const items = [...videoItems, ...tweetItems].sort((a, b) => {
    if (a.publishedAt === null && b.publishedAt === null) {
      return 0;
    }
    if (a.publishedAt === null) {
      return -1;
    }
    if (b.publishedAt === null) {
      return 1;
    }
    return b.publishedAt.localeCompare(a.publishedAt);
  });

  return (
    <FeedView
      items={items}
      creators={creators.map((creator) => ({ id: creator.id, displayName: creator.displayName }))}
      categories={categories}
      uncategorizedCreatorCount={uncategorizedCreatorCount}
    />
  );
}
