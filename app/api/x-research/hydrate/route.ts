import { getDb } from "@/lib/db/connection";
import { readXMutation, xErrorStatus } from "@/lib/x/http";
import { fetchTweetsForCreator } from "@/lib/x/service";
import { getTweetForCreator } from "@/lib/x/repository";
import { toTweetViewModel } from "@/lib/x/view-model";
import { researchError } from "@/lib/x/research/http";
import { parseId, ResearchInputError } from "@/lib/x/research/repository";
export async function POST(request: Request) {
  const body = await readXMutation(request);
  if (!body.ok) return body.response;
  try {
    const db = getDb();
    const creatorId = parseId(body.value.creatorId);
    const tweetId = body.value.tweetId;
    if (
      typeof tweetId !== "string" ||
      !/^\d{1,20}$/.test(tweetId) ||
      !getTweetForCreator(db, creatorId, tweetId)
    )
      throw new ResearchInputError("Choose a cached post belonging to this creator.");
    const result = await fetchTweetsForCreator(db, creatorId, [tweetId]);
    if (!result.ok)
      return Response.json(
        { error: result.error.message },
        { status: xErrorStatus(result.error.code) },
      );
    if (result.failedCount || result.unavailableCount)
      throw new ResearchInputError(
        "Full text could not be retrieved. The archived text is preserved.",
        422,
      );
    const record = getTweetForCreator(db, creatorId, tweetId)!;
    return Response.json({ tweet: toTweetViewModel(record, creatorId) });
  } catch (error) {
    return researchError(error);
  }
}
