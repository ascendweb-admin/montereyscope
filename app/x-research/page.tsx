import { getDb } from "@/lib/db/connection";
import { listCreators } from "@/lib/creators/repository";
import { listCategories, listCreatorCategoryAssignments } from "@/lib/categories";
import { listResearchLists } from "@/lib/x/research/repository";
import { XResearchView } from "./research-view";
export const dynamic = "force-dynamic";
export default async function XResearchPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const params = await searchParams;
  const db = getDb();
  const assignments = listCreatorCategoryAssignments(db);
  return (
    <XResearchView
      initialJobId={typeof params.job === "string" ? params.job : undefined}
      initialLists={listResearchLists(db)}
      creators={listCreators(db)
        .filter((c) => c.platform === "x")
        .map((c) => ({
          id: c.id,
          displayName: c.displayName,
          handle: c.handle,
          categoryIds: (assignments.get(c.id) ?? []).map((category) => category.id),
        }))}
      categories={listCategories(db).map((c) => ({ id: c.id, name: c.name }))}
    />
  );
}
