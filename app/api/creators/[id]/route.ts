import { getCreatorById, toCreatorSummary } from "@/lib/creators/service";
import { removeCreatorById } from "@/lib/creators/service";
import { getDb } from "@/lib/db/connection";
import { listCategoriesForCreator } from "@/lib/categories";

// Backed by the local SQLite file; must reflect the live library.
export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

/** GET /api/creators/[id] — one saved creator or 404. */
export async function GET(_request: Request, ctx: RouteContext<"/api/creators/[id]">) {
  const { id: rawId } = await ctx.params;
  const id = parseId(rawId);
  if (id === null) {
    return Response.json(
      { error: { code: "invalid_id", message: "Creator IDs are positive whole numbers." } },
      { status: 400 },
    );
  }

  const creator = getCreatorById(getDb(), id);
  if (!creator) {
    return Response.json(
      { error: { code: "not_found", message: "No creator with that ID is in your library." } },
      { status: 404 },
    );
  }
  return Response.json(
    {
      creator: {
        ...toCreatorSummary(creator),
        categories: listCategoriesForCreator(getDb(), creator.id),
      },
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}

/** DELETE /api/creators/[id] — remove a creator and cascade cached data. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/creators/[id]">) {
  const { id: rawId } = await ctx.params;
  const id = parseId(rawId);
  if (id === null) {
    return Response.json(
      { error: { code: "invalid_id", message: "Creator IDs are positive whole numbers." } },
      { status: 400 },
    );
  }

  try {
    const outcome = removeCreatorById(getDb(), id);
    if (!outcome.ok) {
      return Response.json({ error: outcome.error }, { status: 400 });
    }
    if (!outcome.removed) {
      return Response.json(
        {
          error: {
            code: "not_found",
            message: "That creator was already removed from your library.",
          },
        },
        { status: 404 },
      );
    }
    return new Response(null, { status: 204 });
  } catch {
    return Response.json(
      {
        error: { code: "unexpected_error", message: "The creator could not be removed right now." },
      },
      { status: 500 },
    );
  }
}
