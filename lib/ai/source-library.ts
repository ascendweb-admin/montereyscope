/**
 * The library a source picker chooses from: every cached video and X post
 * with its creator and categories, the saved accounts grouped into people,
 * and the category list. The AI Chat page renders it with the page (its
 * picker and citation index need it straight away); the Reports page's "New
 * report" reads it from GET /api/ai/sources when the flow opens, since it
 * carries every post's full text and that page re-renders whenever a
 * background job finishes.
 */
import {
  listCategories,
  listCreatorCategoryAssignments,
  listProfileCategoryAssignments,
} from "@/lib/categories";
import { listAccountProfileRefs, listXRefreshTimes } from "@/lib/creators/profile-service";
import { listAllCreators, listCreators } from "@/lib/creators/repository";
import type { ScopeDatabase } from "@/lib/db/connection";
import { labelProfileOf, listAllFeaturedProfiles } from "@/lib/videos/attribution";
import { listAllVideosWithCreator } from "@/lib/videos/service";
import { listFeedTweets } from "@/lib/x/repository";

export function loadSourceLibrary(db: ScopeDatabase) {
  const categories = listCategories(db);
  const assignments = listCreatorCategoryAssignments(db);
  const people = listAccountProfileRefs(db);
  const xUpdatedAt = listXRefreshTimes(db);
  const categoryIdsOf = (creatorId: number): number[] =>
    (assignments.get(creatorId) ?? []).map((category) => category.id);
  const profileCategories = listProfileCategoryAssignments(db);
  const featuredProfiles = listAllFeaturedProfiles(db);
  // Source-only hosts are not in `people` or `creators` below; their videos
  // still need a platform for the picker's mark and platform filter.
  const platformOf = new Map(listAllCreators(db).map((creator) => [creator.id, creator.platform]));

  return {
    videos: listAllVideosWithCreator(db).map((video) => {
      const host = people.get(video.creatorId);
      const hostName = host?.profileName ?? video.creatorName;
      // A video on someone else's channel is labelled with the first person it
      // features and filed under their categories, not the (often hidden) host's.
      const featured = labelProfileOf(featuredProfiles.get(video.id), host?.profileId ?? null);
      return {
        id: video.id,
        creatorId: video.creatorId,
        title: video.title,
        creatorName: featured?.displayName ?? hostName,
        featuredProfileId: featured?.profileId ?? null,
        featuredName: featured?.displayName ?? null,
        hostName: featured ? hostName : null,
        platform: platformOf.get(video.creatorId) ?? null,
        thumbnailUrl: video.thumbnailUrl,
        publishedAt: video.publishedAt,
        durationSeconds: video.durationSeconds,
        liveStatus: video.liveStatus,
        categoryIds: featured
          ? (profileCategories.get(featured.profileId) ?? []).map((category) => category.id)
          : categoryIdsOf(video.creatorId),
      };
    }),
    tweets: listFeedTweets(db).map((record) => ({
      id: record.tweet.id,
      creatorId: record.creatorId,
      authorHandle: record.tweet.author.handle,
      authorName: record.tweet.author.displayName,
      url: record.tweet.url,
      publishedAt: record.tweet.publishedAt,
      text: record.tweet.text,
      mediaPreviewUrl: record.tweet.media[0]?.previewUrl ?? record.tweet.media[0]?.url ?? null,
      categoryIds: categoryIdsOf(record.creatorId),
      readyForAnalysis:
        record.tweet.contentStatus === "complete" && record.tweet.text.trim().length > 0,
    })),
    // Accounts of one person share a group, name, and avatar in the picker.
    creators: listCreators(db).map((creator) => {
      const person = people.get(creator.id);
      return {
        id: creator.id,
        profileId: person?.profileId ?? creator.profileId,
        displayName: person?.profileName ?? creator.displayName,
        avatarUrl: person ? person.avatarUrl : creator.avatarUrl,
        avatarCreatorId: person ? person.avatarCreatorId : creator.id,
        platform: creator.platform,
        // When the account was last brought up to date, for the picker's refresh controls.
        lastRefreshedAt:
          creator.platform === "x"
            ? (xUpdatedAt.get(creator.id) ?? creator.lastRefreshedAt)
            : creator.lastRefreshedAt,
      };
    }),
    categories,
  };
}

export type SourceLibrary = ReturnType<typeof loadSourceLibrary>;
