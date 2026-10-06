import fs from "node:fs";
import { expect, it } from "vitest";
import { createWorkerXProvider } from "@/lib/x/providers/worker";
import { runXExclusive } from "@/lib/x/service";
import { validateXRetrieval } from "@/lib/x/research/validate-retrieval";

it.skipIf(process.env.SCOPE_X_VALIDATE_LIVE !== "1")(
  "records live retrieval evidence through the desktop broker",
  async () => {
    // No worker/fake fallback: live validation must use Electron's verified session.
    expect(process.env.SCOPE_X_BROKER_ORIGIN, "A running desktop backend is required").toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/,
    );
    expect(process.env.SCOPE_X_BROKER_TOKEN !== undefined).toBe(true);
    const until = process.env.SCOPE_X_PROBE_UNTIL ?? new Date().toISOString();
    const since =
      process.env.SCOPE_X_PROBE_SINCE ?? new Date(Date.parse(until) - 7 * 86400_000).toISOString();
    const report = await validateXRetrieval(
      createWorkerXProvider(),
      {
        handle: process.env.SCOPE_X_PROBE_HANDLE ?? "",
        evidence: "live",
        since,
        until,
        maxPages: Number(process.env.SCOPE_X_PROBE_PAGES ?? "5"),
        replyId: process.env.SCOPE_X_PROBE_REPLY_ID,
        longPostId: process.env.SCOPE_X_PROBE_LONG_ID,
      },
      runXExclusive,
    );
    const output = process.env.SCOPE_X_PROBE_OUTPUT ?? "/tmp/scope-x-retrieval-validation.json";
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(
      `Retrieval report: ${output}; stop: ${report.stopReason}; checks: ${JSON.stringify(report.checks)}`,
    );
    expect(
      report.errorCode,
      "See report for live blocker; fixtures cannot satisfy this check",
    ).toBeNull();
    expect(report.checks).toEqual({
      pagination: true,
      boundary: true,
      reply: true,
      longText: true,
    });
  },
  200_000,
);
