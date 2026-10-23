"use client";

import { ChevronDown, Layers3 } from "lucide-react";

import {
  alreadyRefreshing,
  oldestUpdate,
  targetsInScope,
  type RefreshRun,
  type RefreshScope,
  type RefreshTarget,
} from "@/components/background/creator-refresh";
import { PlatformLogo } from "@/components/creators/profile-ui";
import { ActionMenu } from "@/components/ui/action-menu";
import { PLATFORM_LABELS, PLATFORM_SEQUENCE } from "@/lib/creators/labels";
import type { CreatorPlatform } from "@/lib/creators/repository";
import { formatShortAgo } from "@/lib/format";

/**
 * The menu half of a "Refresh all" split button: every platform the
 * accounts span, each with how many accounts it covers and how stale the
 * stalest one is, so a slow platform can be left out or refreshed alone.
 * The Library's "Refresh all" and the source pickers share it. A platform
 * already being refreshed is offered as "Updating…" rather than twice.
 */

/** The platforms these accounts are on, in display order. */
export function platformsIn(targets: readonly RefreshTarget[]): CreatorPlatform[] {
  const present = new Set(targets.map((target) => target.platform));
  return PLATFORM_SEQUENCE.filter((platform) => present.has(platform));
}

/** A platform the accounts aren't on falls back to everyone. */
export function effectiveScope(
  targets: readonly RefreshTarget[],
  scope: RefreshScope,
): RefreshScope {
  return scope !== "all" && platformsIn(targets).includes(scope) ? scope : "all";
}

/** "Refresh all", or "Refresh X" while only X is in view. */
export function refreshLabel(scope: RefreshScope): string {
  return scope === "all" ? "Refresh all" : `Refresh ${PLATFORM_LABELS[scope]}`;
}

export function RefreshScopeMenu({
  targets,
  run,
  peopleCount,
  onRefresh,
  variant = "ghost",
  triggerClassName,
  menuClassName,
}: {
  /** Every account "Refresh all" covers. */
  targets: readonly RefreshTarget[];
  /** The run those refreshes join, to tell what is already going. */
  run: RefreshRun | undefined;
  /** How many people the accounts belong to, for "13 creators"; accounts are counted without it. */
  peopleCount?: number;
  onRefresh: (scope: RefreshScope) => void;
  variant?: "ghost" | "outline";
  triggerClassName?: string;
  menuClassName?: string;
}) {
  const platforms = platformsIn(targets);
  if (platforms.length < 2) return null;
  const scopes: RefreshScope[] = ["all", ...platforms];

  return (
    <ActionMenu
      label="Choose what to refresh"
      variant={variant}
      size="sm"
      icon={<ChevronDown aria-hidden="true" className="size-3.5" />}
      menuClassName={menuClassName}
      triggerClassName={triggerClassName}
      items={scopes.map((scope) => {
        const covered = targetsInScope(targets, scope);
        const busy = alreadyRefreshing(run, covered);
        const amount =
          scope === "all" && peopleCount !== undefined
            ? `${peopleCount} ${peopleCount === 1 ? "creator" : "creators"}`
            : `${covered.length} ${covered.length === 1 ? "account" : "accounts"}`;
        const oldest = oldestUpdate(covered);
        return {
          id: scope,
          label: scope === "all" ? "All platforms" : PLATFORM_LABELS[scope],
          icon:
            scope === "all" ? <Layers3 /> : <PlatformLogo platform={scope} className="size-4" />,
          hint: busy
            ? "Updating…"
            : `${amount} · ${oldest ? `updated ${formatShortAgo(oldest)}` : "some never updated"}`,
          disabled: busy,
          separated: scope === platforms[0],
          onSelect: () => onRefresh(scope),
        };
      })}
    />
  );
}
