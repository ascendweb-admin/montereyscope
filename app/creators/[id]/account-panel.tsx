import { Clock3, ExternalLink, Info } from "lucide-react";

import { AccountActions } from "./account-actions";
import { FetchTweetsButton } from "@/components/channel/fetch-tweets-button";
import { RefreshFeedButton } from "@/components/channel/refresh-feed-button";
import { SelectableFeed } from "@/components/channel/selectable-feed";
import { TweetTimeline, type TweetTimelineState } from "@/components/channel/tweet-timeline";
import type { VideoCardModel } from "@/components/channel/video-card";
import { PlatformLogo } from "@/components/creators/profile-ui";
import { localAvatarSrc } from "@/lib/creators/avatar";
import { PLATFORM_LABELS, formatHandle } from "@/lib/creators/labels";
import type { CreatorAccountSummary } from "@/lib/creators/profile-service";
import {
  formatAbsoluteTimestamp,
  formatDate,
  formatDuration,
  formatRelativeTime,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { VideoRecord } from "@/lib/videos/repository";
import type { CreatorCachedFeed } from "@/lib/videos/service";
import type { TweetViewModel } from "@/lib/x/view-model";

/** X accounts render the tweet timeline instead of the video tabs. */
export interface AccountTimelineData {
  tweets: TweetViewModel[];
  totalCount: number;
  hasMoreCached: boolean;
  state: TweetTimelineState | null;
}

interface AccountPanelProps {
  profileId: number;
  profileName: string;
  account: CreatorAccountSummary;
  accountCount: number;
  isAvatar: boolean;
  researchListNames: string[];
  /** Video platforms only. */
  feed?: CreatorCachedFeed;
  /** X accounts only. */
  timeline?: AccountTimelineData;
}

const PLATFORM_TILE: Record<CreatorAccountSummary["platform"], string> = {
  youtube: "bg-[#FF0000]/10",
  rumble: "bg-[#85C742]/10",
  x: "bg-foreground/10",
};

function toCardModel(creatorId: number, video: VideoRecord): VideoCardModel {
  return {
    videoId: video.id,
    title: video.title,
    detailHref: `/channels/${creatorId}/videos/${video.id}`,
    thumbnailUrl: video.thumbnailUrl,
    publishedLabel: formatDate(video.publishedAt),
    durationLabel: video.durationSeconds === null ? null : formatDuration(video.durationSeconds),
    liveStatus: video.liveStatus,
    publishedAt: video.publishedAt,
    durationSeconds: video.durationSeconds,
  };
}

/**
 * One platform account on a creator page: its identity strip (handle, last
 * refresh, a link out, and its own refresh), then its cached feed — the
 * Videos/Livestreams tabs for YouTube and Rumble, the post timeline for X.
 * Everything shown comes from the local cache; rendering never touches the
 * platforms.
 */
export function AccountPanel({
  profileId,
  profileName,
  account,
  accountCount,
  isAvatar,
  researchListNames,
  feed,
  timeline,
}: AccountPanelProps) {
  const isX = account.platform === "x";
  const isRumble = account.platform === "rumble";
  const platformName = PLATFORM_LABELS[account.platform];
  const refreshedAt = isX ? (timeline?.state?.lastRefreshedAt ?? null) : account.lastRefreshedAt;
  const relativeRefreshed = formatRelativeTime(refreshedAt);
  const absoluteRefreshed = formatAbsoluteTimestamp(refreshedAt);
  const accountKind = isX ? "X account" : `${platformName} channel`;
  // The platform's own name is worth showing when it differs from the person's.
  const showAccountName = account.displayName.trim() !== profileName.trim();

  const videoFeed: CreatorCachedFeed = feed ?? {
    videos: [],
    livestreams: [],
    totalCachedCount: 0,
  };

  return (
    <section aria-labelledby={`account-${account.id}-heading`}>
      <div className="flex flex-col gap-4 rounded-xl border bg-muted/20 p-4 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            aria-hidden="true"
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-lg",
              PLATFORM_TILE[account.platform],
            )}
          >
            <PlatformLogo
              platform={account.platform}
              className={account.platform === "youtube" ? "size-6" : "size-5"}
            />
          </span>
          <div className="min-w-0">
            <h2
              id={`account-${account.id}-heading`}
              className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm font-semibold"
            >
              <span className="truncate">
                {formatHandle(account.handle) ?? account.displayName}
              </span>
              <span className="text-xs font-normal text-muted-foreground">
                {showAccountName && account.handle ? `${account.displayName} · ` : ""}
                {accountKind}
              </span>
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Clock3 aria-hidden="true" className="size-3.5" />
                {refreshedAt && relativeRefreshed ? (
                  <time
                    dateTime={refreshedAt}
                    title={absoluteRefreshed ? `Exact: ${absoluteRefreshed}` : undefined}
                    suppressHydrationWarning
                  >
                    Refreshed {relativeRefreshed}
                  </time>
                ) : (
                  "Never refreshed"
                )}
              </span>
              <a
                href={account.channelUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                Open on {platformName}
                <ExternalLink aria-hidden="true" className="size-3" />
              </a>
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-start gap-2 sm:justify-end">
          {isX ? (
            <FetchTweetsButton
              creatorId={account.id}
              creatorName={profileName}
              hasCachedTweets={(timeline?.totalCount ?? 0) > 0}
            />
          ) : (
            <RefreshFeedButton
              creatorId={account.id}
              creatorName={profileName}
              hasCachedVideos={videoFeed.totalCachedCount > 0}
            />
          )}
          <AccountActions
            profileId={profileId}
            profileName={profileName}
            account={account}
            accountCount={accountCount}
            isAvatar={isAvatar}
            researchListNames={researchListNames}
          />
        </div>
      </div>

      {isRumble ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Full library sync is not available for Rumble channels. Refreshing shows the most recent
            uploads, and transcripts are fetched per video on demand.
          </span>
        </p>
      ) : null}
      {isX ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Posts are cached locally and reads are always explicit. Fetching pulls the newest posts;
            selected posts without full text can be hydrated individually.
          </span>
        </p>
      ) : null}

      <div className="mt-6">
        {isX && timeline ? (
          <TweetTimeline
            creatorId={account.id}
            creatorName={profileName}
            tweets={timeline.tweets}
            totalCount={timeline.totalCount}
            hasMoreCached={timeline.hasMoreCached}
            state={timeline.state}
          />
        ) : (
          <SelectableFeed
            videos={videoFeed.videos.map((video) => toCardModel(account.id, video))}
            livestreams={videoFeed.livestreams.map((video) => toCardModel(account.id, video))}
            hasEverRefreshed={account.lastRefreshedAt !== null}
            creatorName={profileName}
            platform={account.platform === "rumble" ? "rumble" : "youtube"}
            creatorAvatarUrl={localAvatarSrc(account.avatarUrl, account.id)}
          />
        )}
      </div>
    </section>
  );
}
