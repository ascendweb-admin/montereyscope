import { collectReadinessReport } from "@/lib/health";

export const dynamic = "force-dynamic";

// The desktop host must be able to launch even when a bundled tool is slow
// or blocked. Full tool diagnostics remain available from /api/health.
export async function GET() {
  const report = collectReadinessReport();
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
