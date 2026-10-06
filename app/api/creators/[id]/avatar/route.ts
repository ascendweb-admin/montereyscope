import { isAllowedImageUrl } from "@/lib/creators/avatar";
import { getCreatorById } from "@/lib/creators/service";
import { getDb } from "@/lib/db/connection";
import { hasCreatorTweetAuthorAvatar } from "@/lib/x/repository";

// The avatar URL lives in the local SQLite file; read at request time.
export const dynamic = "force-dynamic";

/** Per-request upstream timeout; avatars are small and on a fast CDN. */
const AVATAR_FETCH_TIMEOUT_MS = 10_000;
/** Hard cap for the upstream image; channel avatars are far below this. */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

function notFound(): Response {
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

/**
 * GET /api/creators/[id]/avatar — streams an avatar stored for this
 * creator from the platform image CDNs through the local server, so the
 * dashboard's <img> tags stay same-origin. Browsers hardened by privacy
 * extensions or tracking protection can refuse direct third-party loads
 * from googleusercontent.com or pbs.twimg.com even when the URL is
 * perfectly healthy; the local origin is always allowed.
 *
 * Two stored URLs are served under the creator id: the creator's own
 * avatar (legacy ID-only requests carry no version), and the avatar of a
 * post's author cached in that creator's timeline — a repost card shows
 * the original author, whose avatar is not the creator row's.
 *
 * Nothing is stored: bytes stream through per request, and the browser
 * caches the response. Only https URLs on the allowlisted image CDNs are
 * fetched, so the route cannot be steered at other hosts.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/creators/[id]/avatar">) {
  const { id: rawId } = await ctx.params;
  if (!/^\d+$/.test(rawId)) {
    return notFound();
  }
  const id = Number.parseInt(rawId, 10);
  if (!Number.isInteger(id) || id < 1) {
    return notFound();
  }

  const db = getDb();
  const creator = getCreatorById(db, id);

  // Never serve a new image under an old image's cache key. The query is
  // only a version check; the fetch target always comes from the database.
  const version = new URL(request.url).searchParams.get("v");

  let avatarUrl: string | null = null;
  if (version === null) {
    avatarUrl = creator?.avatarUrl ?? null;
  } else if (creator?.avatarUrl === version) {
    avatarUrl = creator.avatarUrl;
  } else if (hasCreatorTweetAuthorAvatar(db, id, version)) {
    // The URL was stored by a timeline fetch, so it is as trustworthy as
    // the creator's own avatar; isAllowedImageUrl still gates the fetch.
    avatarUrl = version;
  }

  if (avatarUrl === null || !isAllowedImageUrl(avatarUrl)) {
    return notFound();
  }

  let upstream: Response;
  try {
    upstream = await fetch(avatarUrl, {
      headers: { accept: "image/*" },
      signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
    });
  } catch {
    return notFound();
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const contentLength = Number(upstream.headers.get("content-length") ?? "0");
  if (!upstream.ok || !contentType.startsWith("image/") || contentLength > MAX_AVATAR_BYTES) {
    return notFound();
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      // Only versioned URLs identify an image. Legacy ID-only requests
      // must not cache images across database switches or avatar updates.
      "Cache-Control": version === null ? "no-store" : "private, max-age=604800",
    },
  });
}
