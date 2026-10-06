// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReportsView, type ReportSummary } from "@/app/reports/reports-view";

/**
 * The reports list page: the proper empty state, and one card per report —
 * its extracted headline and standfirst, the source videos linking back to
 * their local pages, the "Open report" link to the file route, and the
 * manage actions (rename, delete with confirmation). Pure rendering plus the
 * list-level flows; status polling only starts while a job is active, which
 * these all-idle fixtures never trigger, so fetch is only mocked where a
 * test drives an action.
 */

function report(overrides: Partial<ReportSummary> & { id: number }): ReportSummary {
  return {
    status: "done",
    title: "GTA, Jackson Hole, and the Attention Economy",
    dek: "A streamer's Friday read on a market waiting for the Fed.",
    videoIds: ["vidA000001", "vidA000002"],
    videoCount: 2,
    sourceCount: 2,
    sources: [],
    videos: [
      {
        id: "vidA000001",
        title: "First source video",
        creatorId: 1,
        creatorName: "Creator One",
        thumbnailUrl: "https://example.invalid/a.jpg",
        publishedAt: null,
        durationSeconds: 421,
      },
      {
        id: "vidA000002",
        title: "Second source video",
        creatorId: 2,
        creatorName: "Creator Two",
        thumbnailUrl: null,
        publishedAt: null,
        durationSeconds: null,
      },
    ],
    profile: "balanced",
    style: "editorial",
    filePath: "/home/me/localtube/data/ai-jobs/20260828T120000Z-ab12cd34ef56/report.html",
    fileUrl: `/api/ai/reports/${overrides.id}/file`,
    error: null,
    createdAt: "2026-08-28T12:00:00.000Z",
    completedAt: "2026-08-28T12:04:00.000Z",
    ...overrides,
  };
}

const DONE_REPORT = report({ id: 3 });
const FAILED_REPORT = report({
  id: 2,
  status: "failed",
  fileUrl: null,
  filePath: null,
  error: "Codex hit a usage or rate limit. Wait a bit and try again.",
});
const RUNNING_REPORT = report({ id: 1, status: "running", fileUrl: null, filePath: null });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ReportsView", () => {
  it("shows a proper empty state pointing at the chat action", () => {
    render(<ReportsView initialReports={[]} />);

    expect(screen.getByRole("heading", { name: "Reports" })).toBeTruthy();
    expect(screen.getByText("No reports yet")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Go to AI Research" });
    expect(link.getAttribute("href")).toBe("/research");
  });

  it("names a finished report by its extracted headline and standfirst", () => {
    render(<ReportsView initialReports={[DONE_REPORT]} />);

    expect(screen.getByText("Report #3 · Balanced · Editorial")).toBeTruthy();
    expect(screen.getByText("GTA, Jackson Hole, and the Attention Economy")).toBeTruthy();
    expect(
      screen.getByText("A streamer's Friday read on a market waiting for the Fed."),
    ).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("derives a readable title for a report the run never named", () => {
    render(
      <ReportsView
        initialReports={[
          report({ id: 5, title: null, dek: null }),
          report({
            id: 6,
            title: null,
            dek: null,
            videoIds: ["vidA000001"],
            videoCount: 1,
            videos: [DONE_REPORT.videos[0]],
          }),
        ]}
      />,
    );

    expect(screen.getByText("First source video +1 more")).toBeTruthy();
    expect(screen.getByText("First source video", { selector: "h3" })).toBeTruthy();
  });

  it("renders a finished report with its file link and sources, not its raw path", () => {
    render(<ReportsView initialReports={[DONE_REPORT]} />);

    const open = screen.getByRole("link", { name: "Open report" });
    expect(open.getAttribute("href")).toBe("/api/ai/reports/3/file");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(screen.queryByText("/home/me/localtube/data/ai-jobs")).toBeNull();

    const firstSource = screen.getByRole("link", { name: /First source video/ });
    expect(firstSource.getAttribute("href")).toBe("/channels/1/videos/vidA000001");
    const secondSource = screen.getByRole("link", { name: /Second source video/ });
    expect(secondSource.getAttribute("href")).toBe("/channels/2/videos/vidA000002");
    expect(screen.getByText("2 sources")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
  });

  it("shows each report's requested profile and style", () => {
    render(
      <ReportsView
        initialReports={[
          report({ id: 3, profile: "deep", style: "terminal" }),
          report({ id: 2, profile: "brief", style: "swiss" }),
        ]}
      />,
    );

    expect(screen.getByText("Report #3 · Deep · Terminal")).toBeTruthy();
    expect(screen.getByText("Report #2 · Brief · Swiss")).toBeTruthy();
  });

  it("renders a failed report with its client-safe error and a retry", () => {
    render(<ReportsView initialReports={[FAILED_REPORT]} />);

    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("The report job failed.")).toBeTruthy();
    expect(
      screen.getByText("Codex hit a usage or rate limit. Wait a bit and try again."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open report" })).toBeNull();
  });

  it("renders queued and running jobs without file links", () => {
    render(
      <ReportsView
        initialReports={[
          report({ id: 4, status: "queued", fileUrl: null, filePath: null }),
          RUNNING_REPORT,
        ]}
      />,
    );

    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Waiting its turn — reports run one at a time.")).toBeTruthy();
    expect(screen.getByText("Generating the report…")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open report" })).toBeNull();
    // The running card hides delete (the API refuses it mid-run); the queued
    // card keeps it.
    expect(screen.getAllByRole("button", { name: "Delete" }).length).toBe(1);
  });

  it("lists several reports newest first", () => {
    render(<ReportsView initialReports={[DONE_REPORT, FAILED_REPORT, RUNNING_REPORT]} />);

    const eyebrows = screen
      .getAllByText(/^Report #\d+ ·/)
      .map((element) => element.textContent);
    expect(eyebrows).toEqual([
      "Report #3 · Balanced · Editorial",
      "Report #2 · Balanced · Editorial",
      "Report #1 · Balanced · Editorial",
    ]);
  });

  it("deletes a report after confirmation and drops its card", async () => {
    const fetchMock = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    render(<ReportsView initialReports={[DONE_REPORT]} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete this report?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete report" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/ai/reports/3", { method: "DELETE" });
    });
    await waitFor(() => {
      expect(screen.queryByText("GTA, Jackson Hole, and the Attention Economy")).toBeNull();
    });
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("renames a report from the dialog", async () => {
    const renamed = report({ id: 3, title: "The Fed, GTA, and my attention" });
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ report: renamed }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ReportsView initialReports={[DONE_REPORT]} />);

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Report title" });
    expect((input as HTMLInputElement).value).toBe("GTA, Jackson Hole, and the Attention Economy");
    fireEvent.change(input, { target: { value: "The Fed, GTA, and my attention" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/ai/reports/3", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "The Fed, GTA, and my attention" }),
      });
    });
    await waitFor(() => {
      expect(screen.getByText("The Fed, GTA, and my attention")).toBeTruthy();
    });
  });

  it("collapses wide source lists behind a toggle", () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      id: `vidA0000${index}`,
      title: `Source ${index}`,
      creatorId: 1,
      creatorName: "Creator One",
      thumbnailUrl: null,
      publishedAt: null,
      durationSeconds: null,
    }));
    render(
      <ReportsView
        initialReports={[
          report({
            id: 9,
            videoIds: many.map((video) => video.id),
            videoCount: many.length,
            videos: many,
          }),
        ]}
      />,
    );

    const section = screen.getByLabelText("Report sources");
    expect(within(section).getByText("10 sources")).toBeTruthy();
    expect(within(section).getByText("Source 0")).toBeTruthy();
    expect(within(section).queryByText("Source 9")).toBeNull();

    fireEvent.click(within(section).getByRole("button", { name: "Show 2 more sources" }));
    expect(within(section).getByText("Source 9")).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "Show fewer sources" }));
    expect(within(section).queryByText("Source 9")).toBeNull();
  });
});
