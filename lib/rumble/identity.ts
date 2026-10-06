/**
 * Fetches a Rumble channel page and extracts the channel identity (display
 * name, canonical URL, avatar, follower count). Used by the add-creator
 * flow, the video-import flow (auto-provisioning), and feed refreshes.
 * Server-only.
 */
import {
  fetchRumblePage,
  type RumbleFetchFailureReason,
  type RumbleFetchOptions,
} from "./http";
import { parseRumbleChannelPage, type RumbleChannelIdentity } from "./channel-page";

export interface RumbleIdentityFailure {
  reason: RumbleFetchFailureReason | "unusable_page";
  /** Server-side diagnostics only. */
  detail?: string;
}

export type RumbleIdentityResult =
  | { ok: true; identity: RumbleChannelIdentity }
  | { ok: false; failure: RumbleIdentityFailure };

/**
 * Fetches one channel page (optionally a specific ?page=N) and parses the
 * identity out of it. Recent-video items are parsed too but only returned
 * here when the caller wants them — identity-only callers ignore them.
 */
export async function fetchRumbleChannelIdentity(
  channelUrl: string,
  expectedChannelSlug: string | undefined,
  fetchOptions: RumbleFetchOptions = {},
): Promise<RumbleIdentityResult> {
  const result = await fetchRumblePage(channelUrl, fetchOptions);
  if (!result.ok) {
    return { ok: false, failure: { reason: result.reason } };
  }
  const slug = expectedChannelSlug ?? channelSlugFromUrl(channelUrl) ?? undefined;
  const parsed = parseRumbleChannelPage(result.body, slug);
  if (!parsed.ok) {
    return {
      ok: false,
      failure: { reason: "network", detail: "channel page carried no listing data" },
    };
  }
  if (parsed.identity === null) {
    return {
      ok: false,
      failure: { reason: "network", detail: "channel page carried no identity" },
    };
  }
  return { ok: true, identity: parsed.identity };
}

/** Extracts the /c/<slug> or /user/<slug> name from a canonical channel URL. */
export function channelSlugFromUrl(channelUrl: string): string | null {
  try {
    const segments = new URL(channelUrl).pathname.split("/").filter(Boolean);
    if (segments.length !== 2 || (segments[0] !== "c" && segments[0] !== "user")) {
      return null;
    }
    return segments[1];
  } catch {
    return null;
  }
}
