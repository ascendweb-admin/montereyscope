"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Check, Clock3, Link2, MessagesSquare, Pencil, Trash2, X } from "lucide-react";

import { renameProfileAction } from "@/app/actions/creators";
import { CategoryChip, UncategorizedChip } from "@/components/categories/category-chip";
import { CreatorCategoryEditorButton } from "@/components/categories/creator-category-editor-button";
import { AddVideosDialog } from "@/components/creators/add-videos-dialog";
import {
  LinkCreatorsDialog,
  type LinkableProfile,
} from "@/components/creators/link-creators-dialog";
import {
  PlatformMarks,
  ProfileAvatar,
  handleSummary,
  joinPlatformNames,
  platformsOf,
} from "@/components/creators/profile-ui";
import { AddCreatorDialog } from "@/components/library/add-creator-dialog";
import { RefreshAllButton } from "@/components/library/refresh-all-button";
import { RemoveProfileDialog } from "@/components/library/remove-creator-dialog";
import { ActionMenu } from "@/components/ui/action-menu";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { CategorySummary } from "@/lib/categories";
import { PLATFORM_LABELS, PLATFORM_SEQUENCE, PROFILE_NAME_MAX_LENGTH } from "@/lib/creators/labels";
import type { CreatorProfileSummary } from "@/lib/creators/profile-service";
import { formatAbsoluteTimestamp, formatRelativeTime } from "@/lib/format";

interface CreatorHeaderProps {
  profile: CreatorProfileSummary;
  categories: CategorySummary[];
  /** Everyone else in the library, for "Link existing creator". */
  otherProfiles: LinkableProfile[];
  /** Who the library suggests is the same person. */
  suggestedIds: number[];
  /** Account id → X Research lists it belongs to, for the removal copy. */
  researchListNames: Record<number, string[]>;
}

/**
 * The creator page's identity block: one person with every platform they
 * are followed on. The name is renamable in place (accounts keep their own
 * platform names); the actions add another platform, refresh every account,
 * open AI chat over all of them, or link and remove.
 */
export function CreatorHeader({
  profile,
  categories,
  otherProfiles,
  suggestedIds,
  researchListNames,
}: CreatorHeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { showToast, toastElement } = useToast();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(profile.displayName);
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Account actions that move this page elsewhere hand their confirmation over
  // as a one-time ?notice=, shown here and then dropped from the URL.
  const notice = searchParams.get("notice");
  useEffect(() => {
    if (!notice) {
      return;
    }
    showToast(notice, "success");
    const rest = new URLSearchParams(searchParams.toString());
    rest.delete("notice");
    router.replace(rest.size > 0 ? `${pathname}?${rest}` : pathname, { scroll: false });
    // Only a new notice should fire this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice]);

  const platforms = platformsOf(profile.accounts);
  const missingPlatform =
    PLATFORM_SEQUENCE.find((platform) => !platforms.includes(platform)) ?? "youtube";
  const handles = handleSummary(profile.accounts);
  const lastRefreshedAt = profile.accounts
    .map((account) => account.lastRefreshedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1);
  const multi = profile.accounts.length > 1;

  const saveName = async (): Promise<void> => {
    const next = draftName.trim().replace(/\s+/g, " ");
    if (next === profile.displayName) {
      setEditing(false);
      return;
    }
    setRenamePending(true);
    setRenameError(null);
    const outcome = await renameProfileAction(profile.id, next);
    setRenamePending(false);
    if (!outcome.ok) {
      setRenameError(outcome.message ?? "The name could not be saved.");
      return;
    }
    setEditing(false);
    showToast(`Renamed to ${outcome.displayName ?? next}.`, "success");
  };

  return (
    <header className="mt-6 flex flex-col gap-5 sm:flex-row sm:items-start">
      <ProfileAvatar
        name={profile.displayName}
        avatarUrl={profile.avatarUrl}
        avatarCreatorId={profile.avatarCreatorId}
        className="size-20 text-xl"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            {editing ? (
              <form
                className="flex flex-col gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveName();
                }}
              >
                <div className="flex items-center gap-1.5">
                  <label htmlFor="creator-name" className="sr-only">
                    Creator name
                  </label>
                  <input
                    id="creator-name"
                    value={draftName}
                    autoFocus
                    maxLength={PROFILE_NAME_MAX_LENGTH}
                    disabled={renamePending}
                    onChange={(event) => {
                      setDraftName(event.target.value);
                      setRenameError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setEditing(false);
                        setDraftName(profile.displayName);
                        setRenameError(null);
                      }
                    }}
                    aria-invalid={renameError ? true : undefined}
                    aria-describedby={renameError ? "creator-name-error" : undefined}
                    className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-xl font-semibold tracking-tight shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-80"
                  />
                  <Button
                    type="submit"
                    size="icon"
                    aria-label="Save name"
                    disabled={renamePending || draftName.trim().length === 0}
                  >
                    <Check aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Cancel renaming"
                    disabled={renamePending}
                    onClick={() => {
                      setEditing(false);
                      setDraftName(profile.displayName);
                      setRenameError(null);
                    }}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
                {renameError ? (
                  <p id="creator-name-error" role="alert" className="text-sm text-destructive">
                    {renameError}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Renames them in scope only; accounts keep their own names.
                  </p>
                )}
              </form>
            ) : (
              <div className="flex min-w-0 items-center gap-1">
                <h1 className="truncate text-2xl font-semibold tracking-tight">
                  {profile.displayName}
                </h1>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground"
                  aria-label={`Rename ${profile.displayName}`}
                  title="Rename"
                  onClick={() => {
                    setDraftName(profile.displayName);
                    setEditing(true);
                  }}
                >
                  <Pencil aria-hidden="true" className="size-3.5" />
                </Button>
              </div>
            )}
            {handles ? (
              <p className="mt-1 truncate text-sm text-muted-foreground">{handles}</p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {profile.categories.length > 0 ? (
                profile.categories.map((category) => (
                  <CategoryChip key={category.id} category={category} />
                ))
              ) : (
                <UncategorizedChip />
              )}
              <CreatorCategoryEditorButton
                creator={{
                  id: profile.id,
                  displayName: profile.displayName,
                  categories: profile.categories,
                }}
                categories={categories}
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <Badge variant="secondary">Saved locally</Badge>
              <Badge variant="outline" className="gap-1.5">
                <PlatformMarks platforms={platforms} />
                {multi
                  ? `${profile.accounts.length} ${platforms.length === profile.accounts.length ? "platforms" : "accounts"}`
                  : PLATFORM_LABELS[platforms[0] ?? "youtube"]}
              </Badge>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock3 aria-hidden="true" className="size-3.5" />
                {lastRefreshedAt ? (
                  <time
                    dateTime={lastRefreshedAt}
                    title={
                      formatAbsoluteTimestamp(lastRefreshedAt)
                        ? `Exact: ${formatAbsoluteTimestamp(lastRefreshedAt)}`
                        : undefined
                    }
                    suppressHydrationWarning
                  >
                    {multi ? "Last refreshed" : "Refreshed"} {formatRelativeTime(lastRefreshedAt)}
                  </time>
                ) : (
                  "Never refreshed"
                )}
              </span>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
            <Link
              href={`/chat?creators=${profile.id}`}
              className={buttonVariants({ variant: "outline" })}
              title={`Ask AI across ${joinPlatformNames(platforms)}`}
            >
              <MessagesSquare aria-hidden="true" />
              Ask AI
            </Link>
            <AddCreatorDialog
              variant="outline"
              categories={categories}
              initialPlatform={missingPlatform}
              targetProfile={{
                id: profile.id,
                displayName: profile.displayName,
                avatarUrl: profile.avatarUrl,
                avatarCreatorId: profile.avatarCreatorId,
              }}
              onSaved={() => router.refresh()}
            />
            <AddVideosDialog
              profile={{ id: profile.id, displayName: profile.displayName }}
              onImported={() => router.refresh()}
            />
            {multi ? (
              <RefreshAllButton
                creators={profile.accounts.map((account) => ({
                  id: account.id,
                  displayName: `${profile.displayName} (${PLATFORM_LABELS[account.platform]})`,
                  platform: account.platform,
                  updatedAt: account.lastRefreshedAt,
                }))}
                task={{
                  key: `refresh-profile-${profile.id}`,
                  label: `Updating ${profile.displayName}`,
                  progressLabel: `Updating ${profile.displayName}'s accounts`,
                  href: `/creators/${profile.id}`,
                }}
                noun="account"
                onRefreshed={() => router.refresh()}
              />
            ) : null}
            <ActionMenu
              label={`More actions for ${profile.displayName}`}
              items={[
                {
                  id: "link",
                  label: "Link existing creator…",
                  hint: "Merge a creator already in your library into this one.",
                  icon: <Link2 />,
                  onSelect: () => setLinking(true),
                  disabled: otherProfiles.length === 0,
                },
                {
                  id: "rename",
                  label: "Rename",
                  icon: <Pencil />,
                  onSelect: () => {
                    setDraftName(profile.displayName);
                    setEditing(true);
                  },
                },
                {
                  id: "remove",
                  label: "Remove creator",
                  hint: multi
                    ? `Deletes all ${profile.accounts.length} accounts and their cache.`
                    : "Deletes the account and its cache.",
                  icon: <Trash2 />,
                  destructive: true,
                  separated: true,
                  onSelect: () => setRemoving(true),
                },
              ]}
            />
          </div>
        </div>
      </div>

      <LinkCreatorsDialog
        open={linking}
        onClose={() => setLinking(false)}
        target={profile}
        profiles={otherProfiles}
        suggestedIds={suggestedIds}
        onLinked={(message) => {
          showToast(message, "success");
          router.refresh();
        }}
      />
      <RemoveProfileDialog
        open={removing}
        onClose={() => setRemoving(false)}
        profileId={profile.id}
        displayName={profile.displayName}
        accounts={profile.accounts.map((account) => ({
          ...account,
          researchListNames: researchListNames[account.id] ?? [],
        }))}
        onRemoved={() => router.replace(`/?removed=${encodeURIComponent(profile.displayName)}`)}
        onError={(message) => showToast(message, "error")}
      />
      {toastElement}
    </header>
  );
}
