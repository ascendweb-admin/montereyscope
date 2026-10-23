"use client";

import { SearchAvatar } from "@/components/library/creator-search-results";
import { RumbleLogo, XLogo, YouTubeLogo } from "@/components/ui/platform-logos";
import { localAvatarSrc } from "@/lib/creators/avatar";
import { joinPlatformNames } from "@/lib/creators/labels";
import type { CreatorPlatform } from "@/lib/creators/repository";
import { cn } from "@/lib/utils";

export {
  PLATFORM_LABELS,
  PLATFORM_SEQUENCE,
  accountChipLabel,
  formatHandle,
  handleSummary,
  joinPlatformNames,
  platformsOf,
  type AccountLabelInput,
} from "@/lib/creators/labels";

/**
 * Shared building blocks for showing a person (creator profile) and the
 * platform accounts linked to them, so the library, the creator page, and
 * the AI pickers all draw a person the same way.
 */

export function PlatformLogo({
  platform,
  className,
}: {
  platform: CreatorPlatform;
  className?: string;
}) {
  if (platform === "x") {
    return <XLogo aria-hidden="true" className={cn("text-foreground", className)} />;
  }
  if (platform === "rumble") {
    return <RumbleLogo aria-hidden="true" className={className} />;
  }
  return <YouTubeLogo aria-hidden="true" className={className} />;
}

/** A person's avatar, streamed through the representing account's local proxy. */
export function ProfileAvatar({
  name,
  avatarUrl,
  avatarCreatorId,
  className,
}: {
  name: string;
  avatarUrl: string | null;
  avatarCreatorId: number | null;
  className?: string;
}) {
  const src = localAvatarSrc(avatarUrl, avatarCreatorId);
  return <SearchAvatar key={src} name={name} src={src} className={className} />;
}

/** A small row of platform marks, e.g. beside a name in a dense list. */
export function PlatformMarks({
  platforms,
  className,
  iconClassName = "size-3",
}: {
  platforms: readonly CreatorPlatform[];
  className?: string;
  iconClassName?: string;
}) {
  if (platforms.length === 0) {
    return null;
  }
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1", className)}
      title={joinPlatformNames(platforms)}
    >
      {platforms.map((platform) => (
        <PlatformLogo key={platform} platform={platform} className={iconClassName} />
      ))}
      <span className="sr-only">{joinPlatformNames(platforms)}</span>
    </span>
  );
}
