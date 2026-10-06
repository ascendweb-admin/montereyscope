/**
 * Client-safe view model for cached X posts. Converts repository records
 * into the shape timeline cards, feed rows, citation chips, and selection
 * state use — without importing any server-only module.
 */
import type { CreatorTweetRecord } from "./repository";

export interface TweetViewModel {
  id: string;
  authorName: string;
  authorHandle: string;
  authorAvatarUrl: string | null;
  /** Local creator id, used by the avatar proxy. */
  creatorId: number;
  text: string;
  url: string;
  publishedAt: string | null;
  fetchedAt: string;
  textFetchedAt?: string | null;
  availability?: "unknown" | "observed" | "not_retrievable";
  availabilityCheckedAt?: string | null;
  timelineKind: "post" | "repost" | "reply";
  isRepost: boolean;
  repostedByHandle: string | null;
  inReplyToHandle: string | null;
  quoted: {
    handle: string | null;
    name: string | null;
    text: string;
    url: string;
  } | null;
  media: Array<{
    kind: string;
    url: string;
    previewUrl: string | null;
    altText: string | null;
  }>;
  replyCount: number | null;
  repostCount: number | null;
  likeCount: number | null;
  contentStatus: "summary" | "complete" | "unavailable";
  /** True when the complete post body is cached and can ground analysis. */
  readyForAnalysis: boolean;
}

export function toTweetViewModel(record: CreatorTweetRecord, creatorId: number): TweetViewModel {
  const tweet = record.tweet;
  return {
    id: tweet.id,
    authorName: tweet.author.displayName,
    authorHandle: tweet.author.handle,
    authorAvatarUrl: tweet.author.avatarUrl,
    creatorId,
    text: tweet.text,
    url: tweet.url,
    publishedAt: tweet.publishedAt,
    fetchedAt: record.fetchedAt,
    textFetchedAt: record.textFetchedAt ?? null,
    availability: record.availability ?? "unknown",
    availabilityCheckedAt: record.availabilityCheckedAt ?? null,
    timelineKind: record.timelineKind,
    isRepost: tweet.isRepost,
    repostedByHandle: tweet.repostedByHandle,
    inReplyToHandle: tweet.inReplyToHandle,
    quoted: tweet.quoted
      ? {
          handle: tweet.quoted.handle,
          name: tweet.quoted.name,
          text: tweet.quoted.text,
          url: tweet.quoted.url,
        }
      : null,
    media: tweet.media.map((item) => ({
      kind: item.kind,
      url: item.url,
      previewUrl: item.previewUrl,
      altText: item.altText,
    })),
    replyCount: tweet.replyCount,
    repostCount: tweet.repostCount,
    likeCount: tweet.likeCount,
    contentStatus: tweet.contentStatus,
    readyForAnalysis: tweet.contentStatus === "complete" && tweet.text.trim().length > 0,
  };
}
