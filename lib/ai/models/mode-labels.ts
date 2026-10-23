/**
 * The model and effort each chat mode runs on, as short display labels for
 * the mode switchers in AI Chat and the X Dashboard. Server-only: reads the
 * saved Settings → AI matrix and the active provider's model catalog.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import { CHAT_MODE_IDS, type ChatModeId, type ChatModeModels } from "../chat-modes";
import { getAiBackend, getAiChatModeSelection } from "@/lib/settings/settings";
import { bundledCatalogModels } from "./bundled";
import { getModelCatalog } from "./catalog";
import { catalogReasoningOption } from "./labels";
import { findCatalogModel, type CatalogModel } from "./types";

const PROVIDER_NAMES = { codex: "Codex", claude: "Claude", opencode: "OpenCode" } as const;

/**
 * "Sonnet 5.5 · Medium" per mode for the active provider. Before discovery has
 * run the bundled catalog names the model; failing that, the raw id does.
 */
export async function getChatModeModels(db: ScopeDatabase): Promise<ChatModeModels> {
  const backend = getAiBackend(db);
  let models: CatalogModel[] = [];
  try {
    const catalog = getModelCatalog();
    // The snapshot stays empty until the provider's connection is known.
    await catalog.checkConnection(backend);
    models = catalog.getSnapshot(backend, db).models;
  } catch {
    // Fall back to the bundled labels below.
  }
  const bundled = bundledCatalogModels(backend);
  const modes = Object.fromEntries(
    CHAT_MODE_IDS.map((mode) => {
      const { model, reasoningEffort } = getAiChatModeSelection(db, backend, mode);
      const found = findCatalogModel(models, model) ?? findCatalogModel(bundled, model);
      const effort = reasoningEffort
        ? (found?.reasoningOptions.find((option) => option.id === reasoningEffort)?.label ??
          catalogReasoningOption(reasoningEffort).label)
        : null;
      return [mode, [found?.label ?? model, effort].filter(Boolean).join(" · ")];
    }),
  ) as Record<ChatModeId, string>;
  return { provider: PROVIDER_NAMES[backend], modes };
}
