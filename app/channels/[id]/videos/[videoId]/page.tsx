import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, Users } from "lucide-react";

import { AskAiButton } from "@/components/ai/ask-ai-button";
import { HostedVideoActions } from "@/components/video/hosted-video-actions";
import { TranscriptPanel } from "@/components/video/transcript-panel";
import { Badge } from "@/components/ui/badge";
import {
  formatAbsoluteTimestamp,
  formatDate,
  formatDuration,
  formatRelativeTime,
} from "@/lib/format";
import { localAvatarSrc } from "@/lib/creators/avatar";
import { PLATFORM_LABELS, formatHandle } from "@/lib/creators/labels";
import { getProfileSummary } from "@/lib/creators/profile-service";
import { getCreatorById, toCreatorSummary } from "@/lib/creators/service";
import { countProfileVideos, labelProfileOf, listFeaturedProfiles } from "@/lib/videos/attribution";
import { getCachedVideo } from "@/lib/videos/service";
import { getCachedTranscript } from "@/lib/transcripts/service";
import { getDb } from "@/lib/db/connection";

// Video metadata comes from SQLite and must reflect refreshes immediately.
export const dynamic = "force-dynamic";

interface VideoDetailPageProps {
  params: Promise<{ id: string; videoId: string }>;
}

function parseCreatorId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

const LIVE_BADGES: Record<string, { label: string; className: string }> = {
  is_live: { label: "Live", className: "bg-red-700 text-white" },
  upcoming: { label: "Upcoming", className: "bg-amber-400 text-amber-950" },
  was_live: { label: "Past live", className: "bg-secondary text-secondary-foreground" },
};

/**
 * Local detail page for one cached video: metadata, the read-only transcript
 * view, and the "Ask AI" chat entry point. The chat panel is scope-agnostic;
 * this page grounds it in this single video (its captions are read in the
 * background on the first question).
 */
export default async function VideoDetailPage({ params }: VideoDetailPageProps) {
  const { id: rawId, videoId: rawVideoId } = await params;
  const creatorId = parseCreatorId(rawId);
  // Video IDs are platform slugs (YouTube 11-char ids, Rumble 7-char v-slugs).
  if (creatorId === null || !/^[A-Za-z0-9_-]{6,20}$/.test(decodeURIComponent(rawVideoId))) {
    notFound();
  }
  const videoId = decodeURIComponent(rawVideoId);

  const db = getDb();
  const creatorRecord = getCreatorById(db, creatorId);
  if (!creatorRecord) {
    notFound();
  }
  const video = getCachedVideo(db, creatorId, videoId);
  if (!video) {
    notFound();
  }

  const creator = toCreatorSummary(creatorRecord);
  // Videos belong to one platform account; the page reads as the person's.
  const profile = getProfileSummary(db, creatorRecord.profileId);
  const personName = profile?.displayName ?? creator.displayName;
  // A guest appearance: the people it features, whose Other videos hold it.
  // The channel's own owner is not "featured" on their own video.
  const featured = (listFeaturedProfiles(db, [video.id]).get(video.id) ?? []).filter(
    (person) => person.profileId !== creatorRecord.profileId,
  );
  const labelPerson = labelProfileOf(featured, creatorRecord.profileId);
  const labelProfile = labelPerson ? getProfileSummary(db, labelPerson.profileId) : null;
  // A source-only host has no page (404), so the way back is the featured
  // person's Other videos; a followed host keeps its own account tab.
  const hostIsSourceOnly = !creatorRecord.followed;
  const backHref =
    hostIsSourceOnly && labelPerson
      ? `/creators/${labelPerson.profileId}?view=other`
      : `/creators/${creatorRecord.profileId}?account=${creatorRecord.id}`;
  const backLabel =
    hostIsSourceOnly && labelPerson
      ? `Back to ${labelPerson.displayName}'s Other videos`
      : `Back to ${personName}`;
  const isRumble = creatorRecord.platform === "rumble";
  const externalLinkLabel = isRumble ? "Open on Rumble" : "Open on YouTube";
  const publishedLabel = formatDate(video.publishedAt);
  const cachedRelative = formatRelativeTime(video.fetchedAt);
  const cachedAbsolute = formatAbsoluteTimestamp(video.fetchedAt);
  const liveBadge = LIVE_BADGES[video.liveStatus];

  // Cache-only render: captions are fetched in the background by AI analysis.
  const cachedTranscriptRecord = getCachedTranscript(db, video.id);
  const transcript = cachedTranscriptRecord
    ? {
        text: cachedTranscriptRecord.plainText,
        language: cachedTranscriptRecord.language,
        captionSource: cachedTranscriptRecord.source,
        fetchedAt: cachedTranscriptRecord.fetchedAt,
      }
    : null;

  return (
    <main id="main" className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 md:px-8 md:py-10">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {backLabel}
      </Link>

      <div className="mt-6 overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="relative aspect-video w-full bg-muted">
          {video.thumbnailUrl ? (
            // Remote thumbnail URL only — never downloaded or stored locally.
            <img src={video.thumbnailUrl} alt="" className="size-full object-cover" />
          ) : (
            <span
              aria-hidden="true"
              className="flex size-full items-center justify-center text-sm text-muted-foreground"
            >
              No preview image
            </span>
          )}
          {liveBadge ? (
            <span className="absolute top-2 left-2">
              <Badge className={`${liveBadge.className} border-transparent shadow-sm`}>
                {liveBadge.label}
              </Badge>
            </span>
          ) : video.durationSeconds !== null ? (
            <span className="absolute right-2 bottom-2 rounded-md bg-black/80 px-1.5 py-0.5 font-mono text-xs font-medium text-white">
              {formatDuration(video.durationSeconds)}
            </span>
          ) : null}
        </div>

        <div className="flex flex-col gap-4 p-5 sm:p-6">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{video.title}</h1>
          {featured.length > 0 ? (
            <ul aria-label="Where this video appears" className="-mt-1 flex flex-wrap gap-2">
              <li>
                <Badge variant="secondary" className="gap-1.5">
                  <Users aria-hidden="true" className="size-3" />
                  Featuring {featured.map((person) => person.displayName).join(", ")}
                </Badge>
              </li>
              <li>
                <Badge variant="outline">on {personName}</Badge>
              </li>
            </ul>
          ) : null}
          <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Published</dt>
              <dd>
                {publishedLabel ? (
                  <time
                    dateTime={video.publishedAt ?? undefined}
                    title={video.publishedAt ?? undefined}
                  >
                    {publishedLabel}
                  </time>
                ) : (
                  "Unknown"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Duration</dt>
              <dd>
                {video.durationSeconds === null ? "Unknown" : formatDuration(video.durationSeconds)}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Channel</dt>
              <dd className="truncate">
                {hostIsSourceOnly ? (
                  // A source-only channel has no page of its own.
                  <span>{personName}</span>
                ) : (
                  <Link
                    href={`/creators/${creatorRecord.profileId}?account=${creatorRecord.id}`}
                    className="underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {personName}
                  </Link>
                )}
                <span className="text-muted-foreground">
                  {" "}
                  · {formatHandle(creator.handle) ?? PLATFORM_LABELS[creatorRecord.platform]}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Cached</dt>
              <dd>
                {cachedRelative ? (
                  <time dateTime={video.fetchedAt} title={cachedAbsolute ?? undefined}>
                    {cachedRelative}
                  </time>
                ) : (
                  (formatAbsoluteTimestamp(video.fetchedAt) ?? "Unknown")
                )}
              </dd>
            </div>
          </dl>

          {video.description ? (
            <p className="max-w-3xl text-sm leading-relaxed whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">
              {video.description}
            </p>
          ) : null}

          <div className="mt-1 flex flex-wrap gap-3">
            <AskAiButton
              scope={[video.id]}
              source={{
                id: video.id,
                platform: isRumble ? "rumble" : "youtube",
                title: video.title,
                creator: labelPerson?.displayName ?? personName,
                // An appearance is cited as "{person} on {channel}".
                ...(labelPerson ? { channelName: personName } : {}),
                creatorAvatarUrl: labelProfile
                  ? localAvatarSrc(labelProfile.avatarUrl, labelProfile.avatarCreatorId)
                  : profile
                    ? localAvatarSrc(profile.avatarUrl, profile.avatarCreatorId)
                    : localAvatarSrc(creatorRecord.avatarUrl, creatorRecord.id),
                publishedAt: video.publishedAt,
                durationSeconds: video.durationSeconds,
                thumbnailUrl: video.thumbnailUrl,
              }}
              description="Grounded in what is said in this video."
            />
            <HostedVideoActions
              videoId={video.id}
              host={{
                id: creatorRecord.id,
                displayName: creatorRecord.displayName,
                followed: creatorRecord.followed,
              }}
              person={
                labelPerson
                  ? {
                      id: labelPerson.profileId,
                      displayName: labelPerson.displayName,
                      otherVideoCount: countProfileVideos(db, labelPerson.profileId),
                    }
                  : null
              }
            />
            <a
              href={video.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-secondary px-4 text-sm font-medium text-secondary-foreground shadow-sm outline-none transition-colors hover:bg-secondary/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none"
            >
              {externalLinkLabel}
              <ExternalLink aria-hidden="true" className="size-4" />
            </a>
          </div>
        </div>
      </div>

      <TranscriptPanel
        videoUrl={video.url}
        transcript={transcript}
        platform={creatorRecord.platform}
      />
    </main>
  );
}
