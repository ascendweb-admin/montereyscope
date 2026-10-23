import { AddCreatorDialog } from "@/components/library/add-creator-dialog";
import { CreatorLibrary, type LibraryCreator } from "@/components/library/creator-library";
import { LibraryEmptyState } from "@/components/library/library-empty-state";
import { ManageCategoriesDialog } from "@/components/categories/manage-categories-dialog";
import { listCategories } from "@/lib/categories";
import { listProfileSummaries } from "@/lib/creators/profile-service";
import { listProfileLinkSuggestions } from "@/lib/creators/profile-suggestions";
import { listResearchLists } from "@/lib/x/research/repository";
import { getDb } from "@/lib/db/connection";

// The creator list lives in SQLite and must be read at request time.
export const dynamic = "force-dynamic";

export default function HomePage() {
  const db = getDb();
  const profiles = listProfileSummaries(db);
  const categories = listCategories(db);
  const researchLists = listResearchLists(db);
  const creatorModels: LibraryCreator[] = profiles.map((profile) => ({
    id: profile.id,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    avatarCreatorId: profile.avatarCreatorId,
    categories: profile.categories,
    accounts: profile.accounts.map((account) => ({
      id: account.id,
      platform: account.platform,
      displayName: account.displayName,
      handle: account.handle,
      lastRefreshedAt: account.lastRefreshedAt,
      researchListNames: researchLists
        .filter((list) => list.creatorIds.includes(account.id))
        .map((list) => list.name),
    })),
  }));

  return (
    <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-10">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Creator library</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The creators you follow, with every platform they publish on in one place.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ManageCategoriesDialog
            categories={categories}
            creators={creatorModels.map((creator) => ({
              id: creator.id,
              displayName: creator.displayName,
              handle: creator.accounts.find((account) => account.handle)?.handle ?? null,
              categories: creator.categories,
            }))}
          />
          <AddCreatorDialog categories={categories} />
        </div>
      </div>

      {profiles.length === 0 ? (
        <LibraryEmptyState categories={categories} />
      ) : (
        <CreatorLibrary
          creators={creatorModels}
          categories={categories}
          linkSuggestions={listProfileLinkSuggestions(db)}
        />
      )}
    </main>
  );
}
