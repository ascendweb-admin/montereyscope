/**
 * Feed item view models, prebuilt on the server for the shared FeedStream:
 * the Feed page reads the whole library, a creator's page reads one person's
 * accounts. Every item is labelled per person (profile name and avatar) and
 * per account (platform and handle), so rows link to the right tab of the
 * right creator page. Pure reads.
 */
import type { FeedItemModel } from "@/components/feed/feed-stream";
import { listCreatorCategoryAssignments, listProfileCategoryAssignments } from "@/lib/categories";
import { accountChipLabel } from "@/lib/creators/labels";
import { listAccountProfileRefs, type AccountProfileRef } from "@/lib/creators/profile-service";
import type { CreatorRecord } from "@/lib/creators/repository";
import type { ScopeDatabase } from "@/lib/db/connection";
import {
  labelProfileOf,
  listAllFeaturedProfiles,
  type FeaturedProfile,
} from "@/lib/videos/attribution";
import { listFeedVideos } from "@/lib/videos/repository";
import { listCreatorTweets, listFeedTweets, type CreatorTweetRecord } from "@/lib/x/repository";

/** Descriptions render as a two-line snippet; keep the payload lean. */
const DESCRIPTION_SNIPPET_LENGTH = 240;

/** Posts per X account on a creator page's overview (the X tab pages further). */
const PROFILE_TWEET_LIMIT = 200;

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DESCRIPTION_SNIPPET_LENGTH
    ? `${flat.slice(0, DESCRIPTION_SNIPPET_LENGTH).trimEnd()}…`
    : flat;
}

/** Newest first across kinds, undated items ahead (the established cached-read order). */
export function sortFeedItems<T extends { publishedAt: string | null }>(items: T[]): T[] {
  return items.sort((a, b) => {
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
}

/** Account id → "YouTube", or "@handle" when the person has two accounts on that platform. */
function accountLabels(refs: ReadonlyMap<number, AccountProfileRef>): Map<number, string> {
  const byProfile = new Map<number, AccountProfileRef[]>();
  for (const ref of refs.values()) {
    byProfile.set(ref.profileId, [...(byProfile.get(ref.profileId) ?? []), ref]);
  }
  const labels = new Map<number, string>();
  for (const [creatorId, ref] of refs) {
    labels.set(creatorId, accountChipLabel(ref, byProfile.get(ref.profileId) ?? [ref]));
  }
  return labels;
}

function tweetItem(
  record: CreatorTweetRecord,
  creatorId: number,
  refs: ReadonlyMap<number, AccountProfileRef>,
  labels: ReadonlyMap<number, string>,
  categoryIds: number[],
): FeedItemModel {
  const tweet = record.tweet;
  const ref = refs.get(creatorId);
  return {
    kind: "tweet",
    id: tweet.id,
    creatorId,
    profileId: ref?.profileId ?? creatorId,
    creatorName: ref?.profileName ?? tweet.author.displayName,
    accountLabel: labels.get(creatorId) ?? "X",
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
    categoryIds,
  };
}

export interface BuildFeedItemsOptions {
  /**
   * With `accounts`: also include the videos attributed to this person (their
   * "Other videos"), so a person's Overview and its count agree.
   */
  featuredProfileId?: number;
}

/**
 * Feed items for the whole library, or — given `accounts` — for those
 * platform accounts only (one person's page).
 *
 * A video attributed to a person (an appearance on someone else's channel) is
 * labelled with that person — name, avatar, categories, and a link to their
 * Other videos — plus "on {host}". `creatorId` stays the hosting account's
 * id, which the detail and transcript URLs need. On a person's own page the
 * label is that person even when others are featured too.
 */
export function buildFeedItems(
  db: ScopeDatabase,
  accounts?: readonly Pick<CreatorRecord, "id" | "platform">[],
  options: BuildFeedItemsOptions = {},
): FeedItemModel[] {
  const refs = listAccountProfileRefs(db);
  const labels = accountLabels(refs);
  const assignments = listCreatorCategoryAssignments(db);
  const profileAssignments = listProfileCategoryAssignments(db);
  const categoryIdsOf = (creatorId: number): number[] =>
    (assignments.get(creatorId) ?? []).map((category) => category.id);
  const profileRefs = new Map<number, AccountProfileRef>();
  for (const ref of refs.values()) {
    if (!profileRefs.has(ref.profileId)) {
      profileRefs.set(ref.profileId, ref);
    }
  }
  const featuredByVideo = listAllFeaturedProfiles(db);
  const accountIds = accounts ? new Set(accounts.map((account) => account.id)) : null;
  const featuredId = options.featuredProfileId;

  /** The person an appearance is labelled with, or null for a channel's own video. */
  const labelOf = (videoId: string, hostProfileId: number | null): FeaturedProfile | null => {
    const featured = featuredByVideo.get(videoId);
    const pageOwner =
      featuredId !== undefined && featuredId !== hostProfileId
        ? featured?.find((profile) => profile.profileId === featuredId)
        : undefined;
    return pageOwner ?? labelProfileOf(featured, hostProfileId);
  };

  const videoItems: FeedItemModel[] = [];
  for (const video of listFeedVideos(db)) {
    const ref = refs.get(video.creatorId);
    const featured = labelOf(video.id, ref?.profileId ?? null);
    const included =
      accountIds === null ||
      accountIds.has(video.creatorId) ||
      (featuredId !== undefined &&
        featuredByVideo.get(video.id)?.some((profile) => profile.profileId === featuredId));
    if (!included) {
      continue;
    }
    const person = featured ? profileRefs.get(featured.profileId) : undefined;
    const hostName = ref?.profileName ?? video.creatorName;
    videoItems.push({
      kind: "video",
      id: video.id,
      creatorId: video.creatorId,
      profileId: featured?.profileId ?? ref?.profileId ?? video.creatorId,
      creatorName: featured?.displayName ?? ref?.profileName ?? video.creatorName,
      accountLabel: featured ? `on ${hostName}` : (labels.get(video.creatorId) ?? ""),
      creatorAvatarUrl: featured
        ? (person?.avatarUrl ?? null)
        : ref
          ? ref.avatarUrl
          : video.creatorAvatarUrl,
      creatorAvatarCreatorId: featured
        ? (person?.avatarCreatorId ?? null)
        : ref
          ? ref.avatarCreatorId
          : video.creatorId,
      creatorPlatform: video.creatorPlatform,
      title: video.title,
      url: video.url,
      thumbnailUrl: video.thumbnailUrl,
      publishedAt: video.publishedAt,
      durationSeconds: video.durationSeconds,
      liveStatus: video.liveStatus,
      description: video.description ? snippet(video.description) : null,
      hasTranscript: video.hasTranscript,
      categoryIds: featured
        ? (profileAssignments.get(featured.profileId) ?? []).map((category) => category.id)
        : categoryIdsOf(video.creatorId),
      ...(featured ? { featured: true, hostName } : {}),
    });
  }

  let tweetItems: FeedItemModel[];
  if (accountIds === null) {
    tweetItems = listFeedTweets(db).map((record) =>
      tweetItem(record, record.creatorId, refs, labels, categoryIdsOf(record.creatorId)),
    );
  } else {
    // A person's own timelines, read per account so a post shared with
    // someone else's timeline still shows here. Deduped across their accounts.
    const seen = new Set<string>();
    tweetItems = [];
    for (const account of accounts ?? []) {
      if (account.platform !== "x") {
        continue;
      }
      const records = listCreatorTweets(db, account.id, {
        includeReplies: true,
        includeReposts: true,
        limit: PROFILE_TWEET_LIMIT,
      });
      for (const record of records) {
        if (seen.has(record.tweet.id)) {
          continue;
        }
        seen.add(record.tweet.id);
        tweetItems.push(tweetItem(record, account.id, refs, labels, categoryIdsOf(account.id)));
      }
    }
  }

  return sortFeedItems([...videoItems, ...tweetItems]);
}
