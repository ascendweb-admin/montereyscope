import Link from "next/link";
import { Rss } from "lucide-react";

import { CategoryChip, UncategorizedChip } from "@/components/categories/category-chip";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { XLogo } from "@/components/ui/platform-logos";
import { localAvatarSrc } from "@/lib/creators/avatar";
import { cn } from "@/lib/utils";
import type { CreatorPlatform } from "@/lib/creators/repository";
import type { CreatorCategory } from "@/lib/categories";

const AVATAR_STYLES = [
  "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
];

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

/** Minimal view model shared by saved creators and design-preview fixtures. */
export interface CreatorCardModel {
  platform?: CreatorPlatform;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  /** Saved-creator id; present means avatars stream through the local proxy. */
  id?: number | null;
  /** In-app link to the channel page; null renders a static card. */
  href?: string | null;
  categories?: CreatorCategory[];
}

export function creatorAvatarStyle(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % 997;
  }
  return AVATAR_STYLES[hash % AVATAR_STYLES.length];
}

interface CreatorCardProps {
  creator: CreatorCardModel;
  /** Optional trailing action area, e.g. the remove button. */
  actions?: React.ReactNode;
}

/**
 * A creator tile. Avatars stream through the local proxy route when the
 * creator is saved (same-origin, so browser privacy tooling never sees a
 * third-party request); nothing is downloaded to disk either way.
 */
export function CreatorCard({ creator, actions }: CreatorCardProps) {
  const body = (
    <CardContent className="flex h-full flex-col gap-4 p-5">
      <div className={cn("flex items-start gap-3", actions && "pr-16")}>
        {creator.avatarUrl ? (
          <img
            src={localAvatarSrc(creator.avatarUrl, creator.id) ?? undefined}
            alt=""
            loading="lazy"
            className="size-11 shrink-0 rounded-full border border-border object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
              creatorAvatarStyle(creator.displayName),
            )}
          >
            {initialsOf(creator.displayName)}
          </span>
        )}
      </div>
      <div className="min-w-0">
        <h3 className="truncate text-sm font-semibold">{creator.displayName}</h3>
        <p className="truncate text-sm text-muted-foreground">
          {creator.handle ? `@${creator.handle.replace(/^@/, "")}` : "Channel"}
        </p>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        {creator.platform ? (
          <Badge variant="outline" className="gap-1.5">
            {creator.platform === "x" ? (
              <XLogo aria-hidden="true" className="size-3 text-foreground" />
            ) : (
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full",
                  creator.platform === "rumble" ? "bg-lime-500" : "bg-red-500",
                )}
              />
            )}
            {creator.platform === "x"
              ? "X"
              : creator.platform === "rumble"
                ? "Rumble"
                : "YouTube"}
          </Badge>
        ) : null}
        <Badge variant="secondary" className="gap-1.5">
          <Rss aria-hidden="true" className="size-3" />
          Cached feed
        </Badge>
      </div>
      {creator.categories ? (
        <div className="flex min-h-5 flex-wrap gap-1.5">
          {creator.categories.length > 0 ? (
            <>
              {creator.categories.slice(0, 2).map((category) => (
                <CategoryChip key={category.id} category={category} className="max-w-32" />
              ))}
              {creator.categories.length > 2 ? (
                <Badge variant="outline" className="text-muted-foreground">
                  +{creator.categories.length - 2}
                </Badge>
              ) : null}
            </>
          ) : (
            <UncategorizedChip />
          )}
        </div>
      ) : null}
    </CardContent>
  );

  return (
    <Card className="relative h-full transition-colors motion-reduce:transition-none hover:border-ring/40">
      {creator.href ? (
        <Link
          href={creator.href}
          className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </Link>
      ) : (
        body
      )}
      {actions ? (
        <div className="absolute top-4 right-4 z-10 flex items-center gap-0.5">{actions}</div>
      ) : null}
    </Card>
  );
}
