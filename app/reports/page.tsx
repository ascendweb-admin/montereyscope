import { ReportsView, type ReportSummary } from "./reports-view";
import { listReports, publicReportFor } from "@/lib/ai";
import { getDb } from "@/lib/db/connection";

// Report rows change in the background while the queue drains.
export const dynamic = "force-dynamic";

/**
 * The AI reports list: every requested HTML report with its live job status,
 * extracted headline, and resolved source videos. The initial rows render on
 * the server; the client view takes over with status polling while anything
 * is queued or running.
 */
export default function ReportsPage() {
  const db = getDb();
  const reports: ReportSummary[] = listReports(db).map((report) => publicReportFor(db, report));

  return <ReportsView initialReports={reports} />;
}
