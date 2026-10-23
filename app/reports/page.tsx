import { ReportsView, type ReportSummary } from "./reports-view";
import { listReports, publicReportFor, syncReportIndex } from "@/lib/ai";
import { getDb } from "@/lib/db/connection";

// Report rows change in the background while the queue drains.
export const dynamic = "force-dynamic";
export const metadata = { title: "Reports" };

/**
 * The AI reports page: every requested HTML report with its live job status,
 * extracted headline, resolved sources and creators, and — once the reading
 * index has seen the document — its outline and reading time. The initial rows render on the
 * server; the client view takes over with status polling while anything is
 * queued or running. `?report=<id>` opens that report first.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ report?: string }>;
}) {
  const params = await searchParams;
  const db = getDb();
  syncReportIndex(db);
  const reports: ReportSummary[] = listReports(db).map((report) => publicReportFor(db, report));
  const requested =
    typeof params.report === "string" && /^\d+$/.test(params.report) ? Number(params.report) : null;

  return <ReportsView initialReports={reports} initialSelectedId={requested} />;
}
