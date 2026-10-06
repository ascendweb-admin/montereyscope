import { collectHealthReport } from "@/lib/health";

// Health depends on the local database and the yt-dlp executable,
// so it must always run at request time — never prerendered at build.
export const dynamic = "force-dynamic";

export async function GET() {
  const report = await collectHealthReport();
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
