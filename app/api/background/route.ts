import { refreshCreatorContentAction, refreshCreatorFeedsAction } from "@/app/actions/feeds";
import { getTranscriptAction } from "@/app/actions/transcripts";
import { refreshCreatorTweetsAction, fetchTweetsAction } from "@/app/actions/x";

export const dynamic = "force-dynamic";

/** Plain requests avoid the client router's Server Action queue during navigation. */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, message: "Invalid task request." }, { status: 400 });
  }
  const id = body.creatorId;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
    return Response.json({ ok: false, message: "Invalid creator." }, { status: 400 });
  }
  let result;
  switch (body.operation) {
    case "content":
      result = await refreshCreatorContentAction(id);
      break;
    case "feeds":
      result = await refreshCreatorFeedsAction(id);
      break;
    case "transcript": {
      if (
        typeof body.videoId !== "string" ||
        !["get", "refresh", "select"].includes(String(body.intent))
      ) {
        return Response.json(
          { ok: false, message: "Invalid transcript request." },
          { status: 400 },
        );
      }
      result = await getTranscriptAction(
        id,
        body.videoId,
        body.intent as "get" | "refresh" | "select",
        body.selection,
      );
      break;
    }
    case "tweets": {
      if (body.mode !== "recent" && body.mode !== "older")
        return Response.json({ ok: false }, { status: 400 });
      if (
        body.limit !== undefined &&
        (typeof body.limit !== "number" ||
          !Number.isInteger(body.limit) ||
          body.limit < 1 ||
          body.limit > 100)
      )
        return Response.json({ ok: false }, { status: 400 });
      result = await refreshCreatorTweetsAction(id, body.mode, body.limit as number | undefined);
      break;
    }
    case "selected-tweets": {
      if (!Array.isArray(body.tweetIds) || !body.tweetIds.every((id) => typeof id === "string"))
        return Response.json({ ok: false }, { status: 400 });
      result = await fetchTweetsAction(id, body.tweetIds);
      break;
    }
    default:
      return Response.json({ ok: false, message: "Unknown task." }, { status: 400 });
  }
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
