import { readXMutation } from "@/lib/x/http";
import { researchThread, saveResearchReport } from "@/lib/x/research/experience";
import { researchError } from "@/lib/x/research/http";
/**
 * POST /api/ai/reports — queue an HTML report job; GET — list all reports.
 *
 * POST accepts {videoIds, profile?, style?} or {threadId, profile?, style?}:
 * with a thread id the report uses that thread's scope, so the chat panel's
 * "Generate report" action passes the current thread's scope unchanged. The
 * depth profile (brief/balanced/deep) and visual style are optional and
 * validated against the known ids; omitted values use the defaults. The
 * scope is validated against the cached feed (at least one cached transcript
 * required) before a queued row is inserted, and the job itself runs in the
 * background through the process-wide sequential queue — the response is 202
 * with the queued row.
 *
 * GET returns every report newest-first for the reports list page, each with
 * its extracted headline and standfirst and its scope resolved against the
 * cached feed (titles, creators, thumbnails) so the cards can show what the
 * report covers and link to its sources.
 */
import { getThread } from "@/lib/ai/threads";
import {
  getReportQueue,
  isReportProfileId,
  isReportStyleId,
  listReports,
  MAX_SCOPE_VIDEOS,
  publicReportFor,
  resolveSourceScope,
} from "@/lib/ai";
import { normalizeSourceRefs, videoIdsToSourceRefs, type SourceRef } from "@/lib/content/model";
import { getDb } from "@/lib/db/connection";

// Queue submission touches SQLite; the list must always be current.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ReportsRequestBody {
  researchJobId?: unknown;
  /** Mixed source selection: [{kind: "video"|"tweet", id}]. */
  sources?: unknown;
  /** Legacy video-only selection; normalized into sources once. */
  videoIds?: unknown;
  threadId?: unknown;
  /** Depth profile; omitted reads as the default (balanced). */
  profile?: unknown;
  /** Visual style; omitted reads as the default (editorial). */
  style?: unknown;
}

interface JsonError {
  error: { code: string; message: string };
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  const body: JsonError & Record<string, unknown> = { error: { code, message } };
  return Response.json({ ...body, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

function validateVideoIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    return null;
  }
  const ids = (value as string[]).map((id) => id.trim()).filter((id) => id.length > 0);
  return ids.length > 0 ? ids : null;
}

function validateThreadId(value: unknown): number | null {
  const id = typeof value === "string" ? Number(value) : value;
  return typeof id === "number" && Number.isInteger(id) && id >= 1 ? id : null;
}

/** The stage-7 scope guard, mirroring the chat route's refusal. */
function scopeTooLarge(sources: readonly SourceRef[]): Response | null {
  const unique = new Set(sources.map((source) => `${source.kind}:${source.id}`));
  if (unique.size <= MAX_SCOPE_VIDEOS) {
    return null;
  }
  return jsonError(
    422,
    "scope_too_large",
    `Analyses are capped at ${MAX_SCOPE_VIDEOS} sources at once — this selection covers ${unique.size}. Deselect a few and try again.`,
  );
}

/**
 * Normalizes the request's scope: new `sources` payload wins; legacy
 * `videoIds` normalize once; sending both is ambiguous and rejected.
 */
function normalizeRequestedSources(body: ReportsRequestBody): SourceRef[] | Response {
  if (body.sources !== undefined && body.videoIds !== undefined) {
    return jsonError(400, "ambiguous_scope", "Send either sources or videoIds, not both.");
  }
  if (body.sources !== undefined) {
    const refs = normalizeSourceRefs(body.sources);
    if (refs === null || refs.length === 0) {
      return jsonError(
        400,
        "invalid_sources",
        "sources must be a non-empty array of {kind, id} entries.",
      );
    }
    return refs;
  }
  const requested = validateVideoIds(body.videoIds);
  if (requested === null) {
    return jsonError(
      400,
      "invalid_video_ids",
      "Provide a non-empty sources array, or videoIds for a video-only report.",
    );
  }
  return videoIdsToSourceRefs(requested);
}

export async function POST(request: Request) {
  const guardedRequest = request.clone();
  let body: ReportsRequestBody;
  try {
    body = (await request.json()) as ReportsRequestBody;
  } catch {
    return jsonError(400, "invalid_body", "Request body must be JSON.");
  }

  const db = getDb();

  // Omitted reads as the default so pre-options clients keep working;
  // anything present must be a known id.
  const profile = body.profile === undefined ? undefined : body.profile;
  if (profile !== undefined && !isReportProfileId(profile)) {
    return jsonError(400, "invalid_profile", "profile must be one of: brief, balanced, deep.");
  }
  const style = body.style === undefined ? undefined : body.style;
  if (style !== undefined && !isReportStyleId(style)) {
    return jsonError(400, "invalid_style", "style must be one of: editorial, terminal, swiss.");
  }

  const research =
    body.threadId === undefined ? null : researchThread(db, validateThreadId(body.threadId) ?? -1);
  if (body.researchJobId !== undefined || research) {
    const guarded = await readXMutation(guardedRequest);
    if (!guarded.ok) return guarded.response;
    if (
      body.sources !== undefined ||
      body.videoIds !== undefined ||
      (body.researchJobId !== undefined && body.threadId !== undefined)
    )
      return jsonError(
        400,
        "ambiguous_scope",
        "Send a research job or conversation without another source selection.",
      );
    try {
      const id = body.researchJobId ?? research?.jobId;
      if (typeof id !== "string")
        return jsonError(400, "invalid_job", "Choose a saved research turn.");
      return Response.json(
        { report: publicReportFor(db, saveResearchReport(db, id)) },
        { status: 202, headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return researchError(error);
    }
  }

  let sources: SourceRef[];
  if (body.threadId !== undefined) {
    const threadId = validateThreadId(body.threadId);
    if (threadId === null) {
      return jsonError(400, "invalid_thread", "threadId must be a positive integer.");
    }
    const thread = getThread(db, threadId);
    if (thread === null) {
      return jsonError(404, "thread_not_found", "That chat thread does not exist.");
    }
    sources = thread.selectedSources;
  } else {
    const normalized = normalizeRequestedSources(body);
    if (normalized instanceof Response) {
      return normalized;
    }
    sources = normalized;
  }

  // The stage-7 scope guard, checked before any database work: fresh
  // selections and threads created before the cap existed get the same
  // readable refusal.
  const tooLarge = scopeTooLarge(sources);
  if (tooLarge !== null) {
    return tooLarge;
  }

  const scope = resolveSourceScope(db, sources);
  if (!scope.sources.some((source) => source.readyForAnalysis)) {
    return jsonError(
      422,
      "no_ready_sources",
      "None of the selected sources has cached content yet. Fetch at least one first.",
      {
        unknownSources: scope.unknown,
        notReadySources: scope.notReady,
      },
    );
  }

  const report = getReportQueue().submit(sources, {
    profile: isReportProfileId(profile) ? profile : undefined,
    style: isReportStyleId(style) ? style : undefined,
  });
  return Response.json(
    { report: publicReportFor(db, report) },
    {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function GET() {
  const db = getDb();
  const reports = listReports(db).map((report) => publicReportFor(db, report));
  return Response.json({ reports }, { headers: { "Cache-Control": "no-store" } });
}
