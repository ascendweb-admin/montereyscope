import type { VideoCardModel } from "@/components/channel/video-card";
import { formatDate, formatDuration } from "@/lib/format";
import type { ProfileVideo } from "@/lib/videos/attribution";

/**
 * A card for one of a person's Other videos. Built on the server so the
 * labels never drift; `creatorId` in the link is the channel hosting the
 * video, which may be a source-only host with no page of its own.
 */
export function toOtherVideoCard(video: ProfileVideo): VideoCardModel {
  return {
    videoId: video.id,
    title: video.title,
    detailHref: `/channels/${video.creatorId}/videos/${video.id}`,
    thumbnailUrl: video.thumbnailUrl,
    publishedLabel: formatDate(video.publishedAt),
    durationLabel: video.durationSeconds === null ? null : formatDuration(video.durationSeconds),
    liveStatus: video.liveStatus,
    publishedAt: video.publishedAt,
    durationSeconds: video.durationSeconds,
    subtitle: `on ${video.hostName}`,
    hostName: video.hostName,
    platform: video.hostPlatform,
  };
}
