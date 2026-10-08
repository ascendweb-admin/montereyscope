import { SettingsForm } from "./settings-form";
import { getAiAuthStatus } from "@/lib/ai/auth";
import { getAiBackend, getAiChatModeSettings, getRecentItemsPerTab } from "@/lib/settings/settings";
import { getCacheCounts, getCacheSizes } from "@/lib/maintenance/service";
import { getXConnectionStatus } from "@/lib/x";
import { getDb } from "@/lib/db/connection";

// Settings and cache counts live in SQLite; always reflect the latest values.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Settings",
};

/**
 * Application settings: AI backend (stage 9), feed refresh window (stage 3),
 * transcript caption preferences (stage 4), local-cache controls and
 * appearance (stage 5).
 */
export default async function SettingsPage() {
  const db = getDb();
  const recentItemsPerTab = getRecentItemsPerTab(db);
  const counts = getCacheCounts(db);
  const sizes = getCacheSizes(db);
  const aiBackend = getAiBackend(db);
  const aiChatModeSettings = getAiChatModeSettings(db);
  // Rendered on the server so the AI section shows real login state with no
  // client round-trip; the client re-polls only while a sign-in is active.
  const aiAuthStatus = await getAiAuthStatus(aiBackend);
  // X connection state is verified by the provider (never assumed from cache).
  const xStatus = await getXConnectionStatus();

  return (
    <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 md:px-8 md:py-10">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick the AI backend and tune how scope refreshes feeds. Everything applies on this machine
          only.
        </p>
      </div>

      <SettingsForm
        currentValue={recentItemsPerTab}
        cachedTranscriptCount={counts.cachedTranscripts}
        cachedVideoCount={counts.cachedVideos}
        cachedTweetCount={counts.cachedTweets}
        cacheSizes={sizes}
        aiBackend={aiBackend}
        aiChatModeSettings={aiChatModeSettings}
        aiAuthStatus={aiAuthStatus}
        xStatus={xStatus}
        platform={process.platform}
      />
    </main>
  );
}
