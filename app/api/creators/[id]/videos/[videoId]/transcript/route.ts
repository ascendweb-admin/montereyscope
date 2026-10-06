import {
  resolveTranscript,
  TRANSCRIPT_ERROR_CODE_TO_STATUS,
  type TranscriptIntent,
} from "@/lib/transcripts/service";
import { getCachedVideo } from "@/lib/videos/service";
import { getDb } from "@/lib/db/connection";
import { isEnglishCaptionLanguage } from "@/lib/ytdlp/subtitles";

// Extraction hits the network via yt-dlp and the cache lives in SQLite.
export const dynamic = "force-dynamic";

function parseCreatorId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

function parseVideoId(raw: string): string | null {
  const decoded = decodeURIComponent(raw);
  return /^[A-Za-z0-9_-]{6,20}$/.test(decoded) ? decoded : null;
}

interface SelectionRequestBody {
  intent?: unknown;
  selection?: unknown;
}

interface RouteParams {
  params: Promise<{ id: string; videoId: string }>;
}

/**
 * GET /api/creators/[creatorId]/videos/[videoId]/transcript
 * Optional query: ?refresh=1 forces a fresh extraction (cache bypass).
 * The JSON body variant POST {intent, selection} also exists below for the
 * language chooser flow.
 */
export async function GET(request: Request, ctx: RouteParams) {
  const { id: rawCreatorId, videoId: rawVideoId } = await ctx.params;
  const creatorId = parseCreatorId(rawCreatorId);
  const videoId = parseVideoId(rawVideoId);
  if (creatorId === null || videoId === null) {
    return Response.json(
      { error: { code: "invalid_video", message: "That video reference is not valid." } },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";
  const intent: TranscriptIntent = refresh ? "refresh" : "get";

  const db = getDb();
  const video = getCachedVideo(db, creatorId, videoId);
  if (!video) {
    return Response.json(
      { error: { code: "invalid_video", message: "That video is not in your cached feed." } },
      { status: 404 },
    );
  }

  try {
    const outcome = await resolveTranscript(db, video.id, video.url, { intent });
    if (!outcome.ok) {
      return Response.json(
        {
          error: {
            code: outcome.error.code,
            message: outcome.error.message,
            ...(outcome.error.availableManualLanguages
              ? { availableManualLanguages: outcome.error.availableManualLanguages }
              : {}),
            ...(outcome.error.availableAutomaticLanguages
              ? { availableAutomaticLanguages: outcome.error.availableAutomaticLanguages }
              : {}),
          },
        },
        { status: TRANSCRIPT_ERROR_CODE_TO_STATUS[outcome.error.code] },
      );
    }
    return Response.json(
      { transcript: outcome.transcript },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return Response.json(
      {
        error: {
          code: "unexpected_response",
          message: "scope could not extract this transcript right now.",
        },
      },
      { status: 502 },
    );
  }
}

/** POST body: {intent: "select", selection: {language, kind}}. */
export async function POST(request: Request, ctx: RouteParams) {
  const { id: rawCreatorId, videoId: rawVideoId } = await ctx.params;
  const creatorId = parseCreatorId(rawCreatorId);
  const videoId = parseVideoId(rawVideoId);
  if (creatorId === null || videoId === null) {
    return Response.json(
      { error: { code: "invalid_video", message: "That video reference is not valid." } },
      { status: 400 },
    );
  }

  let body: SelectionRequestBody;
  try {
    body = (await request.json()) as SelectionRequestBody;
  } catch {
    return Response.json(
      { error: { code: "invalid_body", message: "Request body must be JSON." } },
      { status: 400 },
    );
  }

  if (body.intent !== "select") {
    return Response.json(
      {
        error: {
          code: "invalid_intent",
          message: 'Use POST only with {"intent":"select","selection":{"language","kind"}}.',
        },
      },
      { status: 400 },
    );
  }
  if (
    body.selection === null ||
    typeof body.selection !== "object" ||
    !isEnglishCaptionLanguage(
      String((body.selection as Record<string, unknown>).language ?? "").trim(),
    ) ||
    ((body.selection as Record<string, unknown>).kind !== "manual" &&
      (body.selection as Record<string, unknown>).kind !== "automatic")
  ) {
    return Response.json(
      {
        error: {
          code: "invalid_selection",
          message: 'selection must be an English track with kind "manual" or "automatic".',
        },
      },
      { status: 400 },
    );
  }
  const selectionRecord = body.selection as Record<string, unknown>;

  const db = getDb();
  const video = getCachedVideo(db, creatorId, videoId);
  if (!video) {
    return Response.json(
      { error: { code: "invalid_video", message: "That video is not in your cached feed." } },
      { status: 404 },
    );
  }

  try {
    const outcome = await resolveTranscript(db, video.id, video.url, {
      intent: "select",
      selection: {
        language: String(selectionRecord.language).trim().toLowerCase(),
        kind: selectionRecord.kind as "manual" | "automatic",
      },
    });
    if (!outcome.ok) {
      return Response.json(
        {
          error: {
            code: outcome.error.code,
            message: outcome.error.message,
            ...(outcome.error.availableManualLanguages
              ? { availableManualLanguages: outcome.error.availableManualLanguages }
              : {}),
            ...(outcome.error.availableAutomaticLanguages
              ? { availableAutomaticLanguages: outcome.error.availableAutomaticLanguages }
              : {}),
          },
        },
        { status: TRANSCRIPT_ERROR_CODE_TO_STATUS[outcome.error.code] },
      );
    }
    return Response.json(
      { transcript: outcome.transcript },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return Response.json(
      {
        error: {
          code: "unexpected_response",
          message: "scope could not extract this transcript right now.",
        },
      },
      { status: 502 },
    );
  }
}
