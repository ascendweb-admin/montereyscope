"use client";

import { useRouter } from "next/navigation";
import { ListVideo } from "lucide-react";

import { removeVideosAction } from "@/app/actions/videos";
import { SelectableFeed } from "@/components/channel/selectable-feed";
import type { VideoCardModel } from "@/components/channel/video-card";
import { useToast } from "@/components/ui/toast";

interface OtherVideosPanelProps {
  profileId: number;
  profileName: string;
  /** The person's avatar for citation previews (already proxied). */
  avatarUrl: string | null;
  videos: VideoCardModel[];
}

/**
 * A person's "Other videos": the videos they appear in on other channels,
 * pasted in with Add videos. Selection works like any feed — pick several and
 * ask the AI — and also offers Remove, which only drops them from this list
 * (a transcript is deleted with its video once nothing else uses it).
 */
export function OtherVideosPanel({
  profileId,
  profileName,
  avatarUrl,
  videos,
}: OtherVideosPanelProps) {
  const router = useRouter();
  const { showToast, toastElement } = useToast();

  const remove = async (videoIds: string[]): Promise<void> => {
    const outcome = await removeVideosAction(profileId, videoIds);
    if (!outcome.ok) {
      throw new Error(outcome.message);
    }
    const message =
      outcome.removed === 0
        ? "Those videos were already removed."
        : `Removed ${outcome.removed} ${outcome.removed === 1 ? "video" : "videos"} from Other videos.`;
    if (outcome.removed > 0 && outcome.removed >= videos.length) {
      // The tab disappears with its last video; carry the confirmation over.
      router.replace(`/creators/${profileId}?notice=${encodeURIComponent(message)}`);
      return;
    }
    showToast(message, "success");
    router.refresh();
  };

  return (
    <section aria-labelledby="other-videos-heading">
      <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted"
        >
          <ListVideo className="size-5 text-muted-foreground" />
        </span>
        <div className="min-w-0">
          <h2 id="other-videos-heading" className="text-sm font-semibold">
            Other videos
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Videos from other channels {profileName} appears in — interviews, podcasts, and guest
            spots you added by link. They are not part of any channel&apos;s feed here, and you can
            select them to ask the AI like any other video.
          </p>
        </div>
      </div>

      <div className="mt-6">
        {videos.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
            <span
              aria-hidden="true"
              className="flex size-14 items-center justify-center rounded-full bg-muted"
            >
              <ListVideo className="size-7 text-muted-foreground" />
            </span>
            <h3 className="text-base font-semibold">No other videos yet</h3>
            <p className="max-w-md text-balance text-sm text-muted-foreground">
              Use <strong>Add videos</strong> above to paste links to {profileName}&apos;s
              appearances on other channels.
            </p>
          </div>
        ) : (
          <SelectableFeed
            videos={videos}
            livestreams={[]}
            hasEverRefreshed
            creatorName={profileName}
            creatorAvatarUrl={avatarUrl}
            singleList
            showPlatformFilter
            onRemove={remove}
          />
        )}
      </div>
      {toastElement}
    </section>
  );
}
