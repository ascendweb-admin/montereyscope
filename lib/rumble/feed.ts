/**
 * Feed refresh for Rumble creators: fetches the channel's listing page,
 * parses its embedded recent-video items, and merges them into the cached
 * feed through the shared upsert. One listing page ≈ the 25 most recent
 * uploads — Rumble's full back-catalog is deliberately out of scope (see
 * the channel page disclaimer).
 *
 * Server-only. The caller (videos service) owns the in-flight guard and the
 * creator lookup; this module is fetch + parse + merge.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import type { VideoDraft } from "@/lib/videos/mapper";
import { mergeCreatorFeed } from "@/lib/videos/repository";
import { NETWORK_UNREACHABLE_MESSAGE } from "@/lib/ytdlp/user-messages";
import { fetchRumblePage, type RumbleFetchOptions } from "./http";
import { parseRumbleChannelPage, type RumbleChannelIdentity } from "./channel-page";
import { channelSlugFromUrl } from "./identity";

export interface RumbleFeedFailure {
  reason: "throttled" | "unavailable_channel" | "network" | "timeout" | "too_large" | "unusable_page";
  /** Plain-language, UI-safe message. */
  message: string;
}

export type RumbleFeedResult =
  | {
      ok: true;
      videos: VideoDraft[];
      identity: RumbleChannelIdentity | null;
    }
  | { ok: false; failure: RumbleFeedFailure };

/** Maps a typed fetch failure onto the refresh error vocabulary. */
export function classifyRumbleFetchFailure(
  reason:
    | "throttled"
    | "unavailable"
    | "unavailable_channel"
    | "network"
    | "timeout"
    | "too_large"
    | "unusable_page",
): string {
  switch (reason) {
    case "throttled":
      return "Rumble is throttling requests right now. Wait a minute and try again.";
    case "unavailable_channel":
      return "Rumble does not serve that channel (it may have been removed or renamed).";
    case "timeout":
      return "Fetching this channel's listing took too long and was stopped. Please try again.";
    case "too_large":
      return "The channel listing was too large to read safely, so the refresh was stopped.";
    case "unusable_page":
      return "Rumble returned a listing scope could not read. Please try again later.";
    default:
      return NETWORK_UNREACHABLE_MESSAGE;
  }
}

/**
 * Fetches and parses one listing page for a creator's channel URL. Returns
 * the parsed drafts plus whatever identity the page carried (so callers can
 * opportunistically refresh the avatar), or a typed failure.
 */
export async function fetchRumbleListingPage(
  channelUrl: string,
  fetchOptions: RumbleFetchOptions = {},
): Promise<RumbleFeedResult> {
  const result = await fetchRumblePage(channelUrl, fetchOptions);
  if (!result.ok) {
    const reason =
      result.reason === "unavailable" ? "unavailable_channel" : result.reason;
    return {
      ok: false,
      failure: { reason, message: classifyRumbleFetchFailure(reason) },
    };
  }
  const slug = channelSlugFromUrl(channelUrl) ?? undefined;
  const parsed = parseRumbleChannelPage(result.body, slug);
  if (!parsed.ok) {
    return {
      ok: false,
      failure: { reason: "unusable_page", message: classifyRumbleFetchFailure("unusable_page") },
    };
  }
  return { ok: true, videos: parsed.videos, identity: parsed.identity };
}

/**
 * Merges one listing page's videos into the creator's cache and stamps the
 * refresh time. Callers parse first; nothing writes before that succeeds.
 */
export function mergeRumbleListing(
  db: ScopeDatabase,
  creatorId: number,
  videos: readonly VideoDraft[],
  refreshedAt: string,
): { fetchedCount: number; livestreamCount: number } {
  return mergeCreatorFeed(db, { creatorId, videos: [...videos], refreshedAt });
}
