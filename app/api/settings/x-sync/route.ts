import { getDb } from "@/lib/db/connection";
import { readXMutation } from "@/lib/x/http";
import { getXSyncSettings, setXSyncSettings } from "@/lib/settings/settings";
export const dynamic = "force-dynamic";

/** GET /api/settings/x-sync — background sync interval and first-import history. */
export function GET() {
  return Response.json(
    { value: getXSyncSettings(getDb()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(request: Request) {
  const body = await readXMutation(request);
  if (!body.ok) return body.response;
  try {
    return Response.json({ value: setXSyncSettings(getDb(), body.value) });
  } catch (error) {
    return Response.json(
      { error: { code: "invalid_value", message: (error as Error).message } },
      { status: 400 },
    );
  }
}
