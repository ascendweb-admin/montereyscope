import Link from "next/link";
import { ArrowLeft, ExternalLink, Clock3, Info } from "lucide-react";

import { SelectableFeed } from "@/components/channel/selectable-feed";
import { FetchTweetsButton } from "@/components/channel/fetch-tweets-button";
import { RefreshFeedButton } from "@/components/channel/refresh-feed-button";
import { TweetTimeline, type TweetTimelineState } from "@/components/channel/tweet-timeline";
import type { VideoCardModel } from "@/components/channel/video-card";
import { creatorAvatarStyle } from "@/components/library/creator-card";
import { Badge } from "@/components/ui/badge";
import { XLogo } from "@/components/ui/platform-logos";
import { localAvatarSrc } from "@/lib/creators/avatar";
import type { CreatorRecord } from "@/lib/creators/repository";
import {
  formatAbsoluteTimestamp,
  formatDate,
  formatDuration,
  formatRelativeTime,
} from "@/lib/format";
import type { VideoRecord } from "@/lib/videos/repository";
import type { CreatorCachedFeed } from "@/lib/videos/service";
import type { TweetViewModel } from "@/lib/x/view-model";
import { cn } from "@/lib/utils";
import { CategoryChip, UncategorizedChip } from "@/components/categories/category-chip";
import { CreatorCategoryEditorButton } from "@/components/categories/creator-category-editor-button";
import type { CategorySummary, CreatorCategory } from "@/lib/categories";

/** X creators render the tweet timeline instead of the video tabs. */
export interface CreatorTimelineData {
  tweets: TweetViewModel[];
  totalCount: number;
  hasMoreCached: boolean;
  state: TweetTimelineState | null;
}

interface ChannelViewProps {
  creator: CreatorRecord;
  /** Video platforms only; X creators pass the timeline instead. */
  feed?: CreatorCachedFeed;
  /** X creators only. */
  timeline?: CreatorTimelineData;
  categories: readonly CategorySummary[];
  creatorCategories: CreatorCategory[];
}

function toCardModel(creatorId: number, video: VideoRecord): VideoCardModel {
  return {
    videoId: video.id,
    title: video.title,
    detailHref: `/channels/${creatorId}/videos/${video.id}`,
    thumbnailUrl: video.thumbnailUrl,
    publishedLabel: formatDate(video.publishedAt),
    durationLabel: video.durationSeconds === null ? null : formatDuration(video.durationSeconds),
    liveStatus: video.liveStatus,
  };
}

/**
 * A saved creator's channel page: identity header with the last refresh
 * time, manual Refresh action, and the cached Videos/Livestreams tabs.
 * Everything shown comes from the local cache — rendering never touches
 * YouTube or scrapes HTML.
 */
export function ChannelView({
  creator,
  feed,
  timeline,
  categories,
  creatorCategories,
}: ChannelViewProps) {
  const isX = creator.platform === "x";
  const isRumble = creator.platform === "rumble";
  const handleLabel = creator.handle
    ? `@${creator.handle.replace(/^@/, "")}`
    : isX
      ? "X account"
      : isRumble
        ? "Rumble channel"
        : "YouTube channel";
  const externalLinkLabel = isX ? "Open on X" : isRumble ? "Open on Rumble" : "Open on YouTube";
  const relativeRefreshed = formatRelativeTime(creator.lastRefreshedAt);
  const absoluteRefreshed = formatAbsoluteTimestamp(creator.lastRefreshedAt);
  const hasEverRefreshed = creator.lastRefreshedAt !== null;

  const videoFeed: CreatorCachedFeed = feed ?? {
    videos: [],
    livestreams: [],
    totalCachedCount: 0,
  };
  const videoCards = videoFeed.videos.map((video) => toCardModel(creator.id, video));
  const livestreamCards = videoFeed.livestreams.map((video) => toCardModel(creator.id, video));

  return (
    <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-10">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back to library
      </Link>

      <header className="mt-6 flex flex-col gap-5 sm:flex-row sm:items-start">
        {creator.avatarUrl ? (
          // Streams through the local avatar proxy: same-origin, nothing stored.
          <img
            src={localAvatarSrc(creator.avatarUrl, creator.id) ?? undefined}
            alt=""
            className="size-20 shrink-0 rounded-full border border-border object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              "flex size-20 shrink-0 items-center justify-center rounded-full text-xl font-semibold",
              creatorAvatarStyle(creator.displayName),
            )}
          >
            {creator.displayName.slice(0, 2).toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold tracking-tight">
                {creator.displayName}
              </h1>
              <p className="mt-1 truncate text-sm text-muted-foreground">{handleLabel}</p>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {creatorCategories.length > 0 ? (
                  creatorCategories.map((category) => (
                    <CategoryChip key={category.id} category={category} />
                  ))
                ) : (
                  <UncategorizedChip />
                )}
                <CreatorCategoryEditorButton
                  creator={{
                    id: creator.id,
                    displayName: creator.displayName,
                    categories: creatorCategories,
                  }}
                  categories={categories}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <Badge variant="secondary">Saved locally</Badge>
                <Badge variant="outline" className="gap-1.5 font-mono text-xs">
                  {isX ? <XLogo aria-hidden="true" className="size-3 text-foreground" /> : null}
                  {isX ? "X" : isRumble ? "Rumble" : "YouTube"}
                </Badge>
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock3 aria-hidden="true" className="size-3.5" />
                  {isX ? (
                    timeline?.state?.lastRefreshedAt ? (
                      <time
                        dateTime={timeline.state.lastRefreshedAt}
                        title={
                          formatAbsoluteTimestamp(timeline.state.lastRefreshedAt)
                            ? `Exact: ${formatAbsoluteTimestamp(timeline.state.lastRefreshedAt)}`
                            : undefined
                        }
                      >
                        Refreshed {formatRelativeTime(timeline.state.lastRefreshedAt)}
                      </time>
                    ) : (
                      "Never refreshed"
                    )
                  ) : hasEverRefreshed && relativeRefreshed ? (
                    <time
                      dateTime={creator.lastRefreshedAt ?? undefined}
                      title={absoluteRefreshed ? `Exact: ${absoluteRefreshed}` : undefined}
                    >
                      Refreshed {relativeRefreshed}
                    </time>
                  ) : (
                    "Never refreshed"
                  )}
                </span>
                <a
                  href={creator.channelUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md text-xs text-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {externalLinkLabel}
                  <ExternalLink aria-hidden="true" className="size-3" />
                </a>
              </div>
              {isRumble ? (
                <p className="mt-3 flex items-start gap-1.5 rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    Full library sync is not available for Rumble channels. Refreshing shows the
                    most recent uploads, and transcripts are fetched per video on demand.
                  </span>
                </p>
              ) : null}
              {isX ? (
                <p className="mt-3 flex items-start gap-1.5 rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    Posts are cached locally and reads are always explicit. Fetching pulls the
                    newest posts; selected posts without full text can be hydrated individually.
                  </span>
                </p>
              ) : null}
            </div>
            {isX ? (
              <FetchTweetsButton
                creatorId={creator.id}
                creatorName={creator.displayName}
                hasCachedTweets={(timeline?.totalCount ?? 0) > 0}
              />
            ) : (
              <RefreshFeedButton
                creatorId={creator.id}
                creatorName={creator.displayName}
                hasCachedVideos={videoFeed.totalCachedCount > 0}
              />
            )}
          </div>
        </div>
      </header>

      <section aria-labelledby="cached-feed-heading" className="mt-8">
        <h2 id="cached-feed-heading" className="sr-only">
          Cached {isX ? "posts" : "feed"}
        </h2>
        {isX && timeline ? (
          <TweetTimeline
            creatorId={creator.id}
            creatorName={creator.displayName}
            tweets={timeline.tweets}
            totalCount={timeline.totalCount}
            hasMoreCached={timeline.hasMoreCached}
            state={timeline.state}
          />
        ) : (
          <SelectableFeed
            videos={videoCards}
            livestreams={livestreamCards}
            hasEverRefreshed={hasEverRefreshed}
            creatorName={creator.displayName}
          />
        )}
      </section>
    </main>
  );
}
