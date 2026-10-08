import { searchCreators } from "@/lib/creators/search/service";
import type { CreatorSearchErrorCode } from "@/lib/creators/search/model";
import type { CreatorPlatform } from "@/lib/creators/repository";
import { getDb } from "@/lib/db/connection";

// Searches run live against the platforms and read the local library.
export const dynamic = "force-dynamic";

const PLATFORMS = new Set<CreatorPlatform>(["youtube", "rumble", "x"]);

const STATUS_BY_CODE: Partial<Record<CreatorSearchErrorCode, number>> = {
  invalid_query: 400,
  ytdlp_missing: 503,
  desktop_required: 503,
  not_connected: 503,
  unsupported_runtime: 503,
  session_expired: 401,
  verification_required: 403,
  throttled: 429,
  rate_limited: 429,
  timeout: 504,
  cancelled: 499,
};

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/creators/search?platform=youtube|rumble|x&q=<name>
 *
 * A read, not a mutation, so it is a Route Handler rather than a Server
 * Action: searches can be aborted when the user types a new query, and they
 * never queue behind long-running actions from the same page.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const platform = params.get("platform") as CreatorPlatform | null;
  if (platform === null || !PLATFORMS.has(platform)) {
    return Response.json(
      { error: { code: "invalid_query", message: "Choose YouTube, Rumble, or X to search." } },
      { status: 400, headers: NO_STORE },
    );
  }
  try {
    const outcome = await searchCreators(getDb(), platform, params.get("q"), {
      signal: request.signal,
    });
    if (!outcome.ok) {
      return Response.json(
        { error: outcome.error },
        { status: STATUS_BY_CODE[outcome.error.code] ?? 502, headers: NO_STORE },
      );
    }
    return Response.json({ results: outcome.results }, { headers: NO_STORE });
  } catch {
    return Response.json(
      {
        error: {
          code: "unexpected_response",
          message: "Something went wrong on this machine while searching. Please try again.",
        },
      },
      { status: 500, headers: NO_STORE },
    );
  }
}
