import Link from "next/link";
import { Layers3, ListVideo } from "lucide-react";

import { PlatformLogo } from "@/components/creators/profile-ui";
import { PLATFORM_LABELS, accountChipLabel, formatHandle } from "@/lib/creators/labels";
import type { CreatorAccountSummary } from "@/lib/creators/profile-service";
import type { AccountContentCounts } from "@/lib/creators/profiles";
import { cn } from "@/lib/utils";

function totalOf(counts: AccountContentCounts | undefined): number {
  return counts ? counts.videos + counts.livestreams + counts.posts : 0;
}

/**
 * The creator page's view switcher: an Overview of everything the person
 * published, one tab per linked account, and — once they have hand-picked
 * videos from other channels — an "Other videos" tab. Tabs are links
 * (`?account=<id>`, `?view=other`), so every view is shareable and survives a
 * reload.
 */
export function CreatorTabs({
  profileId,
  profileName,
  accounts,
  counts,
  activeAccountId,
  otherCount = 0,
  otherActive = false,
  extraOverviewCount = 0,
  overviewHref = `/creators/${profileId}`,
}: {
  profileId: number;
  profileName: string;
  accounts: readonly CreatorAccountSummary[];
  counts: ReadonlyMap<number, AccountContentCounts>;
  /** null selects the Overview (unless the Other videos tab is active). */
  activeAccountId: number | null;
  /** Videos attributed to the person; the tab only appears when above zero. */
  otherCount?: number;
  otherActive?: boolean;
  /** Attributed videos the Overview adds to the accounts' own content. */
  extraOverviewCount?: number;
  /**
   * Where the Overview tab points. A person with one account lands on it, so
   * their Overview needs an explicit address.
   */
  overviewHref?: string;
}) {
  const overviewCount =
    accounts.reduce((sum, account) => sum + totalOf(counts.get(account.id)), 0) +
    extraOverviewCount;
  const tabs = [
    {
      key: "overview",
      href: overviewHref,
      active: activeAccountId === null && !otherActive,
      icon: <Layers3 aria-hidden="true" className="size-4 text-muted-foreground" />,
      label: "Overview",
      title: `Everything ${profileName} published, newest first`,
      count: overviewCount,
    },
    ...accounts.map((account) => ({
      key: String(account.id),
      href: `/creators/${profileId}?account=${account.id}`,
      active: activeAccountId === account.id,
      icon: (
        <PlatformLogo
          platform={account.platform}
          className={account.platform === "youtube" ? "size-[18px]" : "size-4"}
        />
      ),
      label: accountChipLabel(account, accounts),
      title: `${formatHandle(account.handle) ?? account.displayName} on ${PLATFORM_LABELS[account.platform]}`,
      count: totalOf(counts.get(account.id)),
    })),
    ...(otherCount > 0
      ? [
          {
            key: "other",
            href: `/creators/${profileId}?view=other`,
            active: otherActive,
            icon: <ListVideo aria-hidden="true" className="size-4 text-muted-foreground" />,
            label: "Other videos",
            title: `Videos from other channels ${profileName} appears in`,
            count: otherCount,
          },
        ]
      : []),
  ];

  return (
    <nav aria-label={`${profileName}'s views`} className="mt-8 border-b">
      <ul className="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => (
          <li key={tab.key} className="shrink-0">
            <Link
              href={tab.href}
              scroll={false}
              title={tab.title}
              aria-current={tab.active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 border-b-2 px-3 pt-1.5 pb-2.5 text-sm font-medium outline-none transition-colors focus-visible:rounded-t-md focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                tab.active
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              {tab.icon}
              {tab.label}
              <span
                className={cn(
                  "rounded-full px-1.5 text-xs tabular-nums",
                  tab.active ? "bg-muted text-foreground" : "bg-muted/70 text-muted-foreground",
                )}
              >
                {tab.count}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
