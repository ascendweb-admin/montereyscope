import { AddCreatorDialog } from "@/components/library/add-creator-dialog";
import { CreatorLibrary } from "@/components/library/creator-library";
import { LibraryEmptyState } from "@/components/library/library-empty-state";
import { ManageCategoriesDialog } from "@/components/categories/manage-categories-dialog";
import { listCategories, listCreatorCategoryAssignments } from "@/lib/categories";
import { listCreators } from "@/lib/creators/repository";
import { listResearchLists } from "@/lib/x/research/repository";
import { getDb } from "@/lib/db/connection";

// The creator list lives in SQLite and must be read at request time.
export const dynamic = "force-dynamic";

export default function HomePage() {
  const creators = listCreators(getDb());
  const categories = listCategories(getDb());
  const assignments = listCreatorCategoryAssignments(getDb());
  const researchLists = listResearchLists(getDb());
  const creatorModels = creators.map((creator) => ({
    id: creator.id,
    platform: creator.platform,
    displayName: creator.displayName,
    handle: creator.handle,
    avatarUrl: creator.avatarUrl,
    categories: assignments.get(creator.id) ?? [],
    researchListNames: researchLists
      .filter((list) => list.creatorIds.includes(creator.id))
      .map((list) => list.name),
  }));

  return (
    <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-10">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Creator library</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Saved channels and their recent videos and livestreams.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ManageCategoriesDialog categories={categories} creators={creatorModels} />
          <AddCreatorDialog categories={categories} />
        </div>
      </div>

      {creators.length === 0 ? (
        <LibraryEmptyState categories={categories} />
      ) : (
        <CreatorLibrary creators={creatorModels} categories={categories} />
      )}
    </main>
  );
}
