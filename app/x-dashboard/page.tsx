import { getDb } from "@/lib/db/connection";
import { listCreators } from "@/lib/creators/repository";
import { listCategories, listCreatorCategoryAssignments } from "@/lib/categories";
import { getModelCatalog } from "@/lib/ai/models/catalog";
import { getAiBackend, getAiChatModeSelection, getXSyncSettings } from "@/lib/settings/settings";
import { getXConnectionStatus } from "@/lib/x/service";
import { listResearchLists } from "@/lib/x/research/repository";
import { unreadCounts } from "@/lib/x/dashboard/feed";
import { XDashboard } from "@/components/x-dashboard/dashboard";

export const dynamic = "force-dynamic";
export const metadata = { title: "X Dashboard" };

const PROVIDER_NAMES = { codex: "Codex", claude: "Claude", opencode: "OpenCode" } as const;

/** The AI model insights will use, as Settings → AI configured it. */
function aiLabel(): string {
  const db = getDb();
  const backend = getAiBackend(db);
  const { model } = getAiChatModeSelection(db, backend, "balanced");
  try {
    const found = getModelCatalog()
      .getSnapshot(backend, db)
      .models.find((m) => m.id === model);
    return `${PROVIDER_NAMES[backend]} · ${found?.label ?? model}`;
  } catch {
    return `${PROVIDER_NAMES[backend]} · ${model}`;
  }
}

export default async function XDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ insight?: string; list?: string }>;
}) {
  const params = await searchParams;
  const db = getDb();
  const assignments = listCreatorCategoryAssignments(db);
  const creators = listCreators(db)
    .filter((c) => c.platform === "x")
    .map((c) => ({
      id: c.id,
      displayName: c.displayName,
      handle: c.handle,
      avatarUrl: c.avatarUrl,
      categoryIds: (assignments.get(c.id) ?? []).map((category) => category.id),
    }));
  const lists = listResearchLists(db).map(({ id, name, description, creatorIds }) => ({
    id,
    name,
    description,
    creatorIds,
  }));
  const status = await getXConnectionStatus().catch(() => null);
  return (
    <XDashboard
      initialLists={lists}
      initialCreators={creators}
      categories={listCategories(db).map((c) => ({ id: c.id, name: c.name }))}
      initialUnread={unreadCounts(
        db,
        lists,
        creators.map((c) => c.id),
      )}
      xConnected={status?.capability === "connected" || status?.capability === "session_only"}
      xHandle={status?.user?.handle ?? null}
      autoSyncMinutes={getXSyncSettings(db).autoSyncMinutes}
      aiLabel={aiLabel()}
      initialInsightId={typeof params.insight === "string" ? params.insight : null}
      initialListId={params.list && /^\d+$/.test(params.list) ? Number(params.list) : null}
    />
  );
}
