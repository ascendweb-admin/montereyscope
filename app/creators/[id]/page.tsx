import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { AccountPanel } from "./account-panel";
import { CreatorHeader } from "./creator-header";
import { CreatorOverview } from "./creator-overview";
import { CreatorTabs } from "./creator-tabs";
import { toOtherVideoCard } from "./other-video-cards";
import { OtherVideosPanel } from "./other-videos-panel";
import { listCategories } from "@/lib/categories";
import {
  getProfileSummary,
  listProfileSummaries,
  type CreatorAccountSummary,
} from "@/lib/creators/profile-service";
import { resolveCreatorPageTarget } from "@/lib/creators/page-target";
import { listProfileLinkSuggestions } from "@/lib/creators/profile-suggestions";
import { localAvatarSrc } from "@/lib/creators/avatar";
import { countAccountContent } from "@/lib/creators/profiles";
import { getDb, type ScopeDatabase } from "@/lib/db/connection";
import { buildFeedItems } from "@/lib/feed/items";
import { listProfileVideos } from "@/lib/videos/attribution";
import { getCachedCreatorFeed } from "@/lib/videos/service";
import { getCachedCreatorTimeline } from "@/lib/x";
import { listResearchLists } from "@/lib/x/research/repository";
import { toTweetViewModel } from "@/lib/x/view-model";

// Cached feeds live in SQLite and must reflect refreshes immediately.
export const dynamic = "force-dynamic";

interface CreatorPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function parseId(raw: string | string[] | undefined): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

function renderAccount(
  db: ScopeDatabase,
  profile: { id: number; displayName: string; avatarCreatorId: number | null },
  account: CreatorAccountSummary,
  accountCount: number,
  researchListNames: string[],
) {
  const shared = {
    profileId: profile.id,
    profileName: profile.displayName,
    account,
    accountCount,
    isAvatar: profile.avatarCreatorId === account.id,
    researchListNames,
  };
  // X accounts render their cached post timeline; video platforms render the
  // cached videos/livestreams tabs. Both are pure local reads.
  if (account.platform === "x") {
    const timeline = getCachedCreatorTimeline(db, account.id, {
      limit: 100,
      offset: 0,
      includeReplies: true,
      includeReposts: true,
    });
    return (
      <AccountPanel
        {...shared}
        timeline={{
          tweets: timeline.items.map((item) => toTweetViewModel(item, account.id)),
          totalCount: timeline.totalCount,
          hasMoreCached: timeline.hasMore,
          state: timeline.state
            ? {
                lastRefreshedAt: timeline.state.lastRefreshedAt,
                lastError: timeline.state.lastError,
                exhausted: timeline.state.exhausted,
              }
            : null,
        }}
      />
    );
  }
  return <AccountPanel {...shared} feed={getCachedCreatorFeed(db, account.id)} />;
}

/**
 * A creator's page: one person with every platform account linked to them.
 * The Overview pools everything they published, newest first; each account
 * tab shows that platform's cached feed with its own refresh; once the person
 * has hand-picked videos from other channels an "Other videos" tab
 * (`?view=other`) lists them. Unknown or
 * removed ids — and the profile of a source-only host — fall through to the
 * designed not-found state, and an account link that now belongs to someone
 * else (after linking or unlinking) follows the account to its current
 * creator (see resolveCreatorPageTarget).
 */
export default async function CreatorPage({ params, searchParams }: CreatorPageProps) {
  const [{ id: rawId }, query] = await Promise.all([params, searchParams]);
  const profileId = parseId(rawId);
  if (profileId === null) {
    notFound();
  }

  const db = getDb();
  const requestedAccountId = parseId(query.account);
  const target = resolveCreatorPageTarget(db, profileId, requestedAccountId);
  if (target.kind === "redirect") {
    redirect(`/creators/${target.profileId}?account=${target.accountId}`);
  }
  const profile = target.kind === "show" ? getProfileSummary(db, profileId) : null;
  if (!profile) {
    notFound();
  }

  const otherVideos = listProfileVideos(db, profile.id);
  const hasOther = otherVideos.length > 0;
  const single = profile.accounts.length === 1;
  // A person with one channel has no tabs, until they have Other videos.
  const tabbed = !single || hasOther;
  const view = typeof query.view === "string" ? query.view : null;

  const requestedAccount =
    requestedAccountId === null
      ? null
      : (profile.accounts.find((account) => account.id === requestedAccountId) ?? null);
  // `?view=other` with nothing to show falls back to the default view.
  const showOther = hasOther && view === "other";
  // Several accounts default to the Overview; a single one to its own feed,
  // so its Overview needs `?view=overview`.
  const showOverview =
    !showOther && ((tabbed && view === "overview") || (!single && requestedAccount === null));
  const selected = showOther || showOverview ? null : (requestedAccount ?? profile.accounts[0]);

  const categories = listCategories(db);
  const researchLists = listResearchLists(db);
  const researchListNames: Record<number, string[]> = Object.fromEntries(
    profile.accounts.map((account) => [
      account.id,
      researchLists.filter((list) => list.creatorIds.includes(account.id)).map((list) => list.name),
    ]),
  );
  const otherProfiles = listProfileSummaries(db).filter((entry) => entry.id !== profile.id);
  const accountIds = new Set(profile.accounts.map((account) => account.id));
  const counts = countAccountContent(db, [...accountIds]);

  return (
    <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-10">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back to library
      </Link>

      <CreatorHeader
        profile={profile}
        categories={categories}
        otherProfiles={otherProfiles}
        suggestedIds={
          listProfileLinkSuggestions(db)
            .find((suggestion) => suggestion.profileIds.includes(profile.id))
            ?.profileIds.filter((id) => id !== profile.id) ?? []
        }
        researchListNames={researchListNames}
      />

      {tabbed ? (
        <>
          <CreatorTabs
            profileId={profile.id}
            profileName={profile.displayName}
            accounts={profile.accounts}
            counts={counts}
            activeAccountId={selected?.id ?? null}
            otherCount={otherVideos.length}
            otherActive={showOther}
            extraOverviewCount={
              otherVideos.filter((video) => !accountIds.has(video.creatorId)).length
            }
            overviewHref={single ? `/creators/${profile.id}?view=overview` : undefined}
          />
          <div className="mt-6">
            {showOther ? (
              <OtherVideosPanel
                profileId={profile.id}
                profileName={profile.displayName}
                avatarUrl={localAvatarSrc(profile.avatarUrl, profile.avatarCreatorId)}
                videos={otherVideos.map(toOtherVideoCard)}
              />
            ) : selected ? (
              renderAccount(
                db,
                profile,
                selected,
                profile.accounts.length,
                researchListNames[selected.id] ?? [],
              )
            ) : (
              <CreatorOverview
                profileId={profile.id}
                profileName={profile.displayName}
                accounts={profile.accounts}
                counts={counts}
                items={buildFeedItems(db, profile.accounts, { featuredProfileId: profile.id })}
              />
            )}
          </div>
        </>
      ) : (
        <div className="mt-8">
          {renderAccount(
            db,
            profile,
            profile.accounts[0],
            1,
            researchListNames[profile.accounts[0].id] ?? [],
          )}
        </div>
      )}
    </main>
  );
}
