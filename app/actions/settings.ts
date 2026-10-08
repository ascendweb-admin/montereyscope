"use server";

/**
 * Server Actions for app settings (stage 3 feed window; stage 4 caption
 * languages and transcript caching; stage 9 AI backend). YouTube cookies do
 * not exist yet.
 */
import { revalidatePath } from "next/cache";

import {
  getAiChatModeSettings,
  setAiBackend,
  setAiChatModeSettings,
  setPreferredCaptionLanguages,
  setRecentItemsPerTab,
  validateAiBackend,
  validateAiChatModeSettings,
  validatePreferredCaptionLanguages,
  validateRecentItemsPerTab,
} from "@/lib/settings/settings";
import type { AiBackendId } from "@/lib/ai/backend-id";
import type { AiChatModeSettings } from "@/lib/ai/model-catalog";
import { getModelCatalog } from "@/lib/ai/models/catalog";
import { getDb } from "@/lib/db/connection";

export interface SaveSettingOutcome {
  ok: boolean;
  savedValue?: number;
  message?: string;
}

/** Persists the per-tab recent-item limit after server-side validation. */
export async function saveRecentItemsPerTabAction(value: unknown): Promise<SaveSettingOutcome> {
  const validated = validateRecentItemsPerTab(value);
  if (!validated.ok) {
    return { ok: false, message: validated.message };
  }
  try {
    const saved = setRecentItemsPerTab(getDb(), validated.value);
    revalidatePath("/settings");
    return { ok: true, savedValue: saved };
  } catch {
    return { ok: false, message: "The setting could not be saved. Please try again." };
  }
}

export interface SaveCaptionLanguagesOutcome {
  ok: boolean;
  savedValue?: string[];
  adjusted?: boolean;
  message?: string;
}

/**
 * Compatibility action for older clients. Only English is supported now.
 */
export async function savePreferredCaptionLanguagesAction(
  value: unknown,
): Promise<SaveCaptionLanguagesOutcome> {
  const validated = validatePreferredCaptionLanguages(value);
  if (!validated.ok) {
    return { ok: false, message: validated.message };
  }
  try {
    const saved = setPreferredCaptionLanguages(getDb(), validated.value);
    revalidatePath("/settings");
    return { ok: true, savedValue: saved, adjusted: validated.adjusted };
  } catch {
    return { ok: false, message: "The setting could not be saved. Please try again." };
  }
}

export interface SaveAiBackendOutcome {
  ok: boolean;
  savedValue?: AiBackendId;
  message?: string;
}

/**
 * Persists which AI CLI (codex, opencode, or claude) runs every AI feature.
 * New chat turns and report jobs pick this up on their next run.
 */
export async function saveAiBackendAction(value: unknown): Promise<SaveAiBackendOutcome> {
  const validated = validateAiBackend(value);
  if (!validated.ok) {
    return { ok: false, message: validated.message };
  }
  try {
    const saved = setAiBackend(getDb(), validated.value);
    revalidatePath("/settings");
    return { ok: true, savedValue: saved };
  } catch {
    return { ok: false, message: "The setting could not be saved. Please try again." };
  }
}

export interface SaveAiChatModeSettingsOutcome {
  ok: boolean;
  savedValue?: AiChatModeSettings;
  adjusted?: boolean;
  message?: string;
}

/** Persists the provider-specific model and effort choices for chat modes. */
export async function saveAiChatModeSettingsAction(
  value: unknown,
): Promise<SaveAiChatModeSettingsOutcome> {
  const db = getDb();
  const catalog = getModelCatalog();
  const validated = validateAiChatModeSettings(value, {
    catalogs: await catalog.readSnapshot(),
    previous: getAiChatModeSettings(db),
  });
  if (!validated.ok) {
    // A rejected model may simply be newer than the snapshot; refresh the
    // affected providers once so a retry can succeed without a manual action.
    void catalog.refresh("codex", { force: true }).catch(() => {});
    void catalog.refresh("opencode", { force: true }).catch(() => {});
    void catalog.refresh("claude", { force: true }).catch(() => {});
    return { ok: false, message: validated.message };
  }
  try {
    const saved = setAiChatModeSettings(db, validated.value, {
      catalogs: catalog.getFullSnapshot(),
      previous: getAiChatModeSettings(db),
    });
    revalidatePath("/settings");
    return { ok: true, savedValue: saved, adjusted: validated.adjusted };
  } catch {
    return { ok: false, message: "The chat mode settings could not be saved. Please try again." };
  }
}
