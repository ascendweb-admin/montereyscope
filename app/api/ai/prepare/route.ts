/**
 * POST /api/ai/prepare — start fetching transcripts for a selection.
 *
 * Body: {videoIds: string[]}. Called when a user picks sources for a chat,
 * so captions download in the background while they type their question.
 * Responds immediately (202) with how many videos still need a transcript;
 * the fetches themselves run in the shared extraction limiter, and a chat
 * turn that starts meanwhile joins the in-flight work instead of repeating
 * it. Nothing here is user-visible — failures surface later, in the chat.
 */
import { MAX_SCOPE_VIDEOS } from "@/lib/ai";
import { getDb } from "@/lib/db/connection";
import { prefetchTranscripts } from "@/lib/transcripts/prepare";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { videoIds?: unknown };
  try {
    body = (await request.json()) as { videoIds?: unknown };
  } catch {
    return Response.json(
      { error: { code: "invalid_body", message: "Request body must be JSON." } },
      { status: 400 },
    );
  }
  const raw = body.videoIds;
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
    return Response.json(
      { error: { code: "invalid_video_ids", message: "videoIds must be an array of strings." } },
      { status: 400 },
    );
  }
  const videoIds = [...new Set((raw as string[]).map((id) => id.trim()).filter(Boolean))];
  if (videoIds.length > MAX_SCOPE_VIDEOS) {
    return Response.json(
      {
        error: {
          code: "scope_too_large",
          message: `Analyses are capped at ${MAX_SCOPE_VIDEOS} sources at once.`,
        },
      },
      { status: 422 },
    );
  }
  const pending = prefetchTranscripts(getDb(), videoIds);
  return Response.json({ pending }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
