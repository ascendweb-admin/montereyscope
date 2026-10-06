import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * The ordinary web app remains loopback-only and needs no login. When the
 * Electron host starts it, however, it supplies a random per-launch token and
 * injects that token below Chromium's renderer layer. Requiring the header
 * prevents an unrelated browser page or local process from driving Scope's
 * privileged API merely by discovering its temporary port.
 */
export function proxy(request: NextRequest) {
  const expected = process.env.SCOPE_DESKTOP_TOKEN;
  if (!expected) {
    return NextResponse.next();
  }

  if (request.headers.get("x-scope-desktop-token") !== expected) {
    return new NextResponse("Not found", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  return NextResponse.next();
}
