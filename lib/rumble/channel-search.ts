/**
 * Rumble channel search: fetches rumble.com/search/channel and parses the
 * server-rendered result list. Server-only.
 *
 * Rumble's edge serves search pages behind a Cloudflare browser check that
 * plain Node fetches never pass (verified 2026-10-07: channel pages load,
 * search pages answer 403 "Just a moment…"). Chromium's network stack does
 * pass it, so in the desktop app the request goes through a narrow
 * main-process broker (desktop/lib/rumble-search.cjs) that can only fetch
 * this one search URL. Web mode falls back to the regular Rumble fetcher and
 * reports `desktop_required` when the edge refuses it.
 *
 * Each result is an `<article>` holding the channel link, name, verified
 * badge, follower count, description, and an avatar class whose image is
 * declared in an inline stylesheet (`i.user-image--img--id-N { … }`).
 */
import { isAllowedImageUrl } from "@/lib/creators/avatar";
import type { CreatorSearchOutcome, CreatorSearchResult } from "@/lib/creators/search/model";

import { fetchRumblePage, type RumbleFetchFailureReason } from "./http";
import { rumbleChannelUrlFromSlug } from "./urls";

export const RUMBLE_SEARCH_LIMIT = 20;

const SLUG_PATTERN = /^[0-9A-Za-z._-]{2,60}$/;
const HANDLE_PATTERN = /^[0-9a-z._-]{3,30}$/;

export function rumbleChannelSearchUrl(query: string): string {
  const url = new URL("https://rumble.com/search/channel");
  url.searchParams.set("q", query);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Strips tags, decodes entities, and collapses whitespace. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Parses "3,670,763", "1.2K", or "4M" into a whole number. */
function parseCount(value: string): number | null {
  const match = /^([\d.,]+)\s*([KkMmBb])?$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const suffix = match[2]?.toUpperCase();
  const base = suffix
    ? Number.parseFloat(match[1].replace(/,/g, ""))
    : Number(match[1].replace(/[.,]/g, ""));
  if (!Number.isFinite(base) || base < 0) {
    return null;
  }
  const multiplier =
    suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
  return Math.round(base * multiplier);
}

/** Maps avatar class ids (`user-image--img--id-3`) to their image URLs. */
function collectAvatarImages(html: string): Map<string, string> {
  const images = new Map<string, string>();
  const rule =
    /user-image--img--id-([0-9a-z]+)\s*\{[^}]*?background-image:\s*url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;
  for (const match of html.matchAll(rule)) {
    if (!images.has(match[1])) {
      images.set(match[1], match[2]);
    }
  }
  return images;
}

export type RumbleSearchParseResult =
  { ok: true; results: CreatorSearchResult[] } | { ok: false; reason: "unrecognized_page" };

/**
 * Parses a Rumble channel-search page. A page with no result articles is a
 * valid empty search only when it still looks like a search page; anything
 * else (a challenge page, an error page) fails so callers do not report
 * "no channels found" for a request that was actually blocked.
 */
export function parseRumbleChannelSearch(html: string): RumbleSearchParseResult {
  const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map(
    (match) => match[1],
  );
  if (articles.length === 0) {
    const looksLikeSearchPage =
      /No channels found/i.test(html) || /href="\/search\/channel\?q=/i.test(html);
    return looksLikeSearchPage
      ? { ok: true, results: [] }
      : { ok: false, reason: "unrecognized_page" };
  }

  const avatars = collectAvatarImages(html);
  const results: CreatorSearchResult[] = [];
  const seen = new Set<string>();
  for (const article of articles) {
    const link = /href="\/(c|user)\/([^"?#/]+)/i.exec(article);
    if (!link) {
      continue;
    }
    const prefix = link[1].toLowerCase() === "user" ? "user" : "c";
    const slug = link[2];
    if (!SLUG_PATTERN.test(slug)) {
      continue;
    }
    const id = `${prefix}/${slug.toLowerCase()}`;
    if (seen.has(id)) {
      continue;
    }

    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(article)?.[1] ?? "";
    const nameMarkup = /<span\b[^>]*class="[^"]*\btruncate\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(
      heading,
    )?.[1];
    const displayName = textOf(nameMarkup ?? heading);
    if (displayName.length === 0) {
      continue;
    }
    seen.add(id);

    const followers = /([\d.,]+\s*[KkMmBb]?)(?:&nbsp;|\s)*Followers?\b/.exec(article);
    const descriptionMarkup = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(article)?.[1];
    const description = descriptionMarkup ? textOf(descriptionMarkup) : "";
    const avatarId = /user-image--img--id-([0-9a-z]+)/i.exec(article)?.[1];
    const avatarUrl = avatarId ? (avatars.get(avatarId) ?? null) : null;
    const handle = slug.toLowerCase();

    results.push({
      platform: "rumble",
      id,
      displayName: displayName.slice(0, 100),
      handle: HANDLE_PATTERN.test(handle) ? handle : null,
      channelUrl: rumbleChannelUrlFromSlug(slug, prefix),
      avatarUrl: isAllowedImageUrl(avatarUrl) ? avatarUrl : null,
      followerCount: followers ? parseCount(followers[1]) : null,
      verified: /verification-badge-icon/.test(heading),
      protectedAccount: false,
      description: description.length > 0 ? description.slice(0, 300) : null,
      youtubeChannelId: null,
      platformUserId: null,
      savedCreatorId: null,
    });
    if (results.length >= RUMBLE_SEARCH_LIMIT) {
      break;
    }
  }
  return { ok: true, results };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export type RumbleSearchFetchResult =
  { ok: true; html: string } | { ok: false; reason: RumbleFetchFailureReason | "desktop_required" };

export interface RumbleSearchDeps {
  /** Desktop broker origin/token; read from the environment by default. */
  brokerOrigin?: string | null;
  brokerToken?: string | null;
  fetchImpl?: typeof fetch;
  fetchPage?: typeof fetchRumblePage;
  signal?: AbortSignal;
}

const BROKER_TIMEOUT_MS = 30_000;
const BROKER_FAILURES = new Set(["throttled", "unavailable", "network", "timeout", "too_large"]);

async function fetchThroughBroker(
  origin: string,
  token: string,
  query: string,
  deps: RumbleSearchDeps,
): Promise<RumbleSearchFetchResult> {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
    return { ok: false, reason: "network" };
  }
  const timeout = AbortSignal.timeout(BROKER_TIMEOUT_MS);
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${origin}/`, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "x-scope-rumble-search": token },
      body: JSON.stringify({ query }),
      signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout,
    });
    if (!response.ok) {
      return { ok: false, reason: "network" };
    }
    const envelope = (await response.json()) as {
      ok?: unknown;
      html?: unknown;
      error?: { code?: unknown };
    };
    if (envelope.ok === true && typeof envelope.html === "string") {
      return { ok: true, html: envelope.html };
    }
    const code = envelope.error?.code;
    return {
      ok: false,
      reason:
        typeof code === "string" && BROKER_FAILURES.has(code)
          ? (code as RumbleFetchFailureReason)
          : "network",
    };
  } catch {
    return { ok: false, reason: timeout.aborted ? "timeout" : "network" };
  }
}

/** Fetches one channel-search page, preferring the desktop broker. */
export async function fetchRumbleChannelSearch(
  query: string,
  deps: RumbleSearchDeps = {},
): Promise<RumbleSearchFetchResult> {
  const origin =
    deps.brokerOrigin !== undefined ? deps.brokerOrigin : process.env.SCOPE_RUMBLE_SEARCH_ORIGIN;
  const token =
    deps.brokerToken !== undefined ? deps.brokerToken : process.env.SCOPE_RUMBLE_SEARCH_TOKEN;
  if (origin && token) {
    return fetchThroughBroker(origin, token, query, deps);
  }
  const page = await (deps.fetchPage ?? fetchRumblePage)(rumbleChannelSearchUrl(query), {
    attempts: 1,
    timeoutMs: 20_000,
    maxBodyBytes: 4 * 1024 * 1024,
  });
  if (!page.ok) {
    // Outside the desktop app Rumble's browser check refuses search outright.
    return { ok: false, reason: page.reason === "throttled" ? "desktop_required" : page.reason };
  }
  return { ok: true, html: page.body };
}

const FAILURE_MESSAGES: Record<
  RumbleFetchFailureReason | "desktop_required" | "unrecognized_page",
  string
> = {
  desktop_required:
    "Rumble only allows search from the scope desktop app. Paste the channel link instead.",
  throttled: "Rumble is limiting searches right now. Wait a minute and try again.",
  unavailable:
    "Rumble search is unavailable right now. Try again later, or paste the channel link.",
  network: "scope could not reach Rumble. Check your connection and try again.",
  timeout: "Rumble search took too long and was stopped. Please try again.",
  too_large: "Rumble returned more data than scope reads safely. Try a more specific name.",
  unrecognized_page:
    "scope could not read Rumble's search results right now. Try again, or paste the channel link.",
};

/** Searches Rumble for channels matching an already-normalized query. */
export async function searchRumbleChannels(
  query: string,
  deps: RumbleSearchDeps = {},
): Promise<CreatorSearchOutcome> {
  const fetched = await fetchRumbleChannelSearch(query, deps);
  if (!fetched.ok) {
    const code =
      fetched.reason === "desktop_required"
        ? "desktop_required"
        : fetched.reason === "too_large" || fetched.reason === "unavailable"
          ? "unexpected_response"
          : fetched.reason;
    return { ok: false, error: { code, message: FAILURE_MESSAGES[fetched.reason] } };
  }
  const parsed = parseRumbleChannelSearch(fetched.html);
  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: "unexpected_response", message: FAILURE_MESSAGES.unrecognized_page },
    };
  }
  return { ok: true, results: parsed.results };
}
