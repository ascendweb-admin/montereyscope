import { ResearchView } from "./research-view";
import { listCreators } from "@/lib/creators/repository";
import { resolveScope } from "@/lib/ai";
import { listAllVideosWithCreator } from "@/lib/videos/service";
import { listFeedTweets } from "@/lib/x/repository";
import { getDb } from "@/lib/db/connection";
import { listCategories, listCreatorCategoryAssignments } from "@/lib/categories";

// The cached video list lives in SQLite and must reflect refreshes and
// transcript extractions immediately.
export const dynamic = "force-dynamic";

/**
 * Cross-channel AI research (stage 5): pick one or more saved creators,
 * choose a subset of their cached videos, and open the shared chat panel
 * grounded in that scope. Pure reads — nothing here touches YouTube, and
 * transcript availability comes from the stage-1 scope resolver so every
 * selection surface shares one source of truth.
 */
export default function ResearchPage() {
  const db = getDb();
  const categories = listCategories(db);
  const assignments = listCreatorCategoryAssignments(db);

  const creators = listCreators(db).map((creator) => ({
    id: creator.id,
    displayName: creator.displayName,
    handle: creator.handle,
    avatarUrl: creator.avatarUrl,
    categories: assignments.get(creator.id) ?? [],
  }));

  const videos = listAllVideosWithCreator(db);
  const scope = resolveScope(
    db,
    videos.map((video) => video.id),
  );
  const hasTranscriptByVideoId = new Map(
    scope.videos.map((video) => [video.id, video.hasTranscript]),
  );

  const tweets = listFeedTweets(db).map((record) => ({
    id: record.tweet.id,
    creatorId: record.creatorId,
    creatorName: record.tweet.author.displayName,
    authorHandle: record.tweet.author.handle,
    authorName: record.tweet.author.displayName,
    text: record.tweet.text,
    publishedAt: record.tweet.publishedAt,
    url: record.tweet.url,
    mediaPreviewUrl:
      record.tweet.media[0]?.previewUrl ?? record.tweet.media[0]?.url ?? null,
    contentStatus: record.tweet.contentStatus,
    readyForAnalysis:
      record.tweet.contentStatus === "complete" && record.tweet.text.trim().length > 0,
  }));

  return (
    <ResearchView
      creators={creators}
      categories={categories}
      videos={videos.map((video) => ({
        id: video.id,
        creatorId: video.creatorId,
        creatorName: video.creatorName,
        title: video.title,
        thumbnailUrl: video.thumbnailUrl,
        publishedAt: video.publishedAt,
        durationSeconds: video.durationSeconds,
        liveStatus: video.liveStatus,
        hasTranscript: hasTranscriptByVideoId.get(video.id) ?? false,
      }))}
      tweets={tweets}
    />
  );
}
