import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { crossOriginRejection, isSameOriginMutation } from "@/lib/ai/auth/http";

/**
 * The ordinary web app remains loopback-only and needs no login. When the
 * Electron host starts it, however, it supplies a random per-launch token and
 * injects that token below Chromium's renderer layer. Requiring the header
 * prevents an unrelated browser page or local process from driving Scope's
 * privileged API merely by discovering its temporary port.
 */
export function proxy(request: NextRequest) {
  const expected = process.env.SCOPE_DESKTOP_TOKEN;
  if (expected && request.headers.get("x-scope-desktop-token") !== expected) {
    return new NextResponse("Not found", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  // CORS does not prevent simple POST side effects. Apply the same origin
  // boundary to every mutation, including ordinary chat/report API routes
  // and Server Actions, before any provider or database work can begin.
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !isSameOriginMutation(request)) {
    return crossOriginRejection();
  }

  return NextResponse.next();
}
