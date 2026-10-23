import Link from "next/link";

import { CategoryChip, UncategorizedChip } from "@/components/categories/category-chip";
import { PlatformLogo, ProfileAvatar } from "@/components/creators/profile-ui";
import {
  PLATFORM_LABELS,
  accountChipLabel,
  formatHandle,
  handleSummary,
} from "@/lib/creators/labels";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { CreatorPlatform } from "@/lib/creators/repository";
import type { CreatorCategory } from "@/lib/categories";

export { creatorAvatarStyle } from "@/components/creators/avatar-style";

/** One platform account on a person's card. */
export interface CreatorCardAccount {
  platform: CreatorPlatform;
  handle: string | null;
  /** In-app link to this account's tab; null renders a static chip. */
  href?: string | null;
}

/** Minimal view model shared by saved creators and design-preview fixtures. */
export interface CreatorCardModel {
  displayName: string;
  avatarUrl: string | null;
  /** The account the avatar streams through; present means the local proxy is used. */
  avatarCreatorId?: number | null;
  /** In-app link to the creator page; null renders a static card. */
  href?: string | null;
  /** Every platform account linked to this person, in display order. */
  accounts: readonly CreatorCardAccount[];
  categories?: CreatorCategory[];
}

interface CreatorCardProps {
  creator: CreatorCardModel;
  /** Optional trailing action area, e.g. the link, categories, and remove buttons. */
  actions?: React.ReactNode;
}

/**
 * A creator tile: one person with a chip for every platform they are
 * followed on. The name is the card's link (stretched over the whole tile),
 * while each platform chip jumps straight to that account's tab. Avatars
 * stream through the local proxy route when the creator is saved
 * (same-origin, so browser privacy tooling never sees a third-party
 * request); nothing is downloaded to disk either way.
 */
export function CreatorCard({ creator, actions }: CreatorCardProps) {
  const subtitle = handleSummary(creator.accounts);
  const multiPlatform = creator.accounts.length > 1;

  return (
    <Card className="relative h-full transition-colors motion-reduce:transition-none hover:border-ring/40">
      <CardContent className="flex h-full flex-col gap-4 p-5">
        <div className={cn("flex items-start gap-3", actions && "pr-28")}>
          <ProfileAvatar
            name={creator.displayName}
            avatarUrl={creator.avatarUrl}
            avatarCreatorId={creator.avatarCreatorId ?? null}
            className="size-11 text-sm"
          />
        </div>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">
            {creator.href ? (
              <Link
                href={creator.href}
                className="rounded-sm outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
              >
                {creator.displayName}
              </Link>
            ) : (
              creator.displayName
            )}
          </h2>
          <p className="truncate text-sm text-muted-foreground" title={subtitle || undefined}>
            {subtitle || (multiPlatform ? `${creator.accounts.length} accounts` : "Channel")}
          </p>
        </div>
        <ul
          aria-label={`${creator.displayName}'s platforms`}
          className="mt-auto flex flex-wrap items-center gap-1.5 pt-1"
        >
          {creator.accounts.map((account, index) => {
            const label = accountChipLabel(account, creator.accounts);
            const handle = formatHandle(account.handle);
            const title = handle
              ? `${handle} on ${PLATFORM_LABELS[account.platform]}`
              : PLATFORM_LABELS[account.platform];
            const chipClass =
              "inline-flex h-6 max-w-40 items-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium";
            return (
              <li key={`${account.platform}-${account.handle ?? index}`}>
                {account.href ? (
                  // Sits above the card's stretched link so it stays clickable.
                  <Link
                    href={account.href}
                    title={title}
                    aria-label={`Open ${title}`}
                    className={cn(
                      chipClass,
                      "relative z-10 outline-none transition-colors hover:border-ring/50 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                    )}
                  >
                    <PlatformLogo platform={account.platform} className="size-3 shrink-0" />
                    <span className="truncate">{label}</span>
                  </Link>
                ) : (
                  <span title={title} className={chipClass}>
                    <PlatformLogo platform={account.platform} className="size-3 shrink-0" />
                    <span className="truncate">{label}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
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
      {actions ? (
        <div className="absolute top-4 right-4 z-20 flex items-center gap-0.5">{actions}</div>
      ) : null}
    </Card>
  );
}
