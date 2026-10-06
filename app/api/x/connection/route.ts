import { getXProvider } from "@/lib/x/providers";
import { readXMutation } from "@/lib/x/http";
import { connectX, disconnectX, getXConnectionStatus, toXServiceError } from "@/lib/x";

// Connection state is process/runtime state; never cache it.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/x/connection — the current X connection capability and account.
 * POST /api/x/connection — `{action: "connect" | "disconnect"}`.
 *
 * Credential-bearing connection work happens inside the provider (desktop
 * session or worker-owned session). This route never returns cookies or
 * tokens.
 */
export async function GET() {
  try {
    const status = await getXConnectionStatus();
    return Response.json({ status }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const serviceError = toXServiceError(error);
    return Response.json(
      { error: serviceError },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(request: Request) {
  const parsed = await readXMutation(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  try {
    if (body.action === "connect") {
      const status = await connectX(request.signal);
      return Response.json({ status }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "disconnect") await disconnectX();
    else if (body.action === "cancel") await getXProvider().cancel?.();
    else if (body.action === "focus") await getXProvider().focus?.();
    else if (body.action === "retry-storage") await getXProvider().retryStorage?.();
    else return Response.json({ error: { code: "invalid_action" } }, { status: 400 });
    return Response.json(
      { status: await getXConnectionStatus() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: toXServiceError(error) },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
