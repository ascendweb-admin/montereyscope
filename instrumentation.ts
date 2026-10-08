/**
 * Boot hook (stage 7). Runs once per server instance, before requests are
 * served, and does exactly two things: opens (and migrates) the SQLite
 * database, and boots the report subsystem — whose queue creation recovers
 * jobs the previous server process orphaned (a report stuck in "running" is
 * marked failed with a client-safe message; queued jobs re-enter the drain).
 * Without this, a crash mid-job would leave a "running" row that nothing
 * would ever resolve.
 *
 * Guarded to the Node.js runtime: the Edge runtime never serves this app's
 * routes (SQLite and child processes are Node-only), and the recovery imports
 * must not be bundled there.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { getDb } = await import("./lib/db/connection");
  const { getReportQueue } = await import("./lib/ai/reports");
  const { loadProviderPathOverrides } = await import("./lib/ai/provider-paths");
  const db = getDb();
  loadProviderPathOverrides(db);
  getReportQueue();
  const { getResearchAnalysisEngine } = await import("./lib/x/research/analysis");
  getResearchAnalysisEngine();
  // X Dashboard: resume syncs a restart interrupted and run the background
  // sync interval from Settings; mark interrupted AI insights as such.
  const { ensureXAutoSync } = await import("./lib/x/dashboard/sync");
  ensureXAutoSync();
  const { getInsightEngine } = await import("./lib/x/dashboard/insights");
  getInsightEngine();
}
