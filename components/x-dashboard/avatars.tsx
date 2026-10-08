"use client";

import { SearchAvatar } from "@/components/library/creator-search-results";
import { localAvatarSrc } from "@/lib/creators/avatar";
import type { DashboardCreator } from "@/lib/x/dashboard/model";
import { cn } from "@/lib/utils";

/** A creator's avatar through the local proxy, with an initials fallback. */
export function CreatorAvatar({
  creator,
  className,
}: {
  creator: Pick<DashboardCreator, "id" | "displayName" | "avatarUrl">;
  className?: string;
}) {
  const src = localAvatarSrc(creator.avatarUrl, creator.id);
  return (
    <SearchAvatar
      key={src}
      name={creator.displayName}
      src={src}
      className={cn("size-8 text-[11px]", className)}
    />
  );
}

/** Overlapping avatars with a "+N" tail, e.g. for a list's members. */
export function AvatarStack({
  creators,
  max = 4,
  size = "sm",
  showRest = true,
  className,
}: {
  creators: Array<Pick<DashboardCreator, "id" | "displayName" | "avatarUrl">>;
  max?: number;
  size?: "xs" | "sm" | "md";
  /** Show a "+N" bubble for members beyond `max`. */
  showRest?: boolean;
  className?: string;
}) {
  const shown = creators.slice(0, max);
  const rest = creators.length - shown.length;
  const sizing =
    size === "xs"
      ? "size-5 text-[8px] -ml-1.5 first:ml-0"
      : size === "sm"
        ? "size-6 text-[9px] -ml-2 first:ml-0"
        : "size-8 text-[11px] -ml-2.5 first:ml-0";
  return (
    <span className={cn("flex items-center", className)} aria-hidden="true">
      {shown.map((creator) => (
        <CreatorAvatar
          key={creator.id}
          creator={creator}
          className={cn(sizing, "border-2 border-background ring-0")}
        />
      ))}
      {rest > 0 && showRest ? (
        <span
          className={cn(
            sizing,
            "flex shrink-0 items-center justify-center rounded-full border-2 border-background bg-muted font-semibold text-muted-foreground tabular-nums",
          )}
        >
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
