// @vitest-environment happy-dom
// @vitest-environment-options {"settings": {"navigation": {"disableChildFrameNavigation": true}}}
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { ReportsView, type ReportSummary } from "@/app/reports/reports-view";

/**
 * The Reports page: the proper empty state, the rail listing every report
 * (headline, profile, status), and the pane for the selected report — the
 * inline reader and "Open report" link for finished ones, progress for
 * queued and running ones, the error and a retry for failed ones — plus the
 * manage actions (PDF, rename, delete) and the list's search, filter, and
 * keyboard navigation, and "New report", which picks sources and options and
 * queues the job without a chat. Status polling only starts while a job is
 * active, which these fixtures never leave running long enough to trigger,
 * so fetch is only mocked where a test drives an action.
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
    origin: "report",
    scopeLabel: null,
    creators: [],
    categories: [],
    platforms: [],
    outline: [],
    wordCount: null,
    readingMinutes: null,
    ...overrides,
  };
}

const DONE_REPORT = report({ id: 3 });
const FAILED_REPORT = report({
  id: 2,
  status: "failed",
  title: null,
  dek: null,
  fileUrl: null,
  filePath: null,
  error: "Codex hit a usage or rate limit. Wait a bit and try again.",
});
const RUNNING_REPORT = report({
  id: 1,
  status: "running",
  title: null,
  dek: null,
  fileUrl: null,
  filePath: null,
  completedAt: null,
});

function rail(): HTMLElement {
  return screen.getByRole("navigation", { name: "Reports" });
}

function row(name: string | RegExp): HTMLElement {
  return within(rail()).getByRole("button", { name });
}

function openMenu(): void {
  fireEvent.click(screen.getByRole("button", { name: "More report actions" }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.scopeApp;
  window.history.replaceState(null, "", "/");
});

describe("ReportsView", () => {
  it("offers PDF downloads for finished desktop reports, including reports stored in the database", async () => {
    const exportReportPdf = vi.fn().mockResolvedValue({ ok: true, data: { canceled: false } });
    window.scopeApp = { info: vi.fn(), openLogs: vi.fn(), exportReportPdf };
    render(<ReportsView initialReports={[report({ id: 3, filePath: null }), FAILED_REPORT]} />);

    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(exportReportPdf).toHaveBeenCalledWith(3));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("PDF saved."));

    // A failed report has nothing to export.
    fireEvent.click(row(/First source video \+1 more/));
    expect(screen.queryByRole("button", { name: "Download PDF" })).toBeNull();
  });

  it("hides native PDF export when the host does not support it", () => {
    render(<ReportsView initialReports={[DONE_REPORT]} />);
    expect(screen.queryByRole("button", { name: "Download PDF" })).toBeNull();
  });

  it("blocks duplicate saves and conflicting actions, then restores them on cancellation", async () => {
    let finish!: (value: { ok: boolean; data: { canceled: boolean } }) => void;
    const exportReportPdf = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    window.scopeApp = { info: vi.fn(), openLogs: vi.fn(), exportReportPdf };
    render(
      <ReportsView initialReports={[DONE_REPORT, report({ id: 4, title: "Another report" })]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(screen.getByRole("button", { name: "Saving PDF…" }).hasAttribute("disabled")).toBe(true);
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Rename" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("menuitem", { name: "Delete" }).hasAttribute("disabled")).toBe(true);

    // Another report cannot start a second save meanwhile.
    fireEvent.click(row(/Another report/));
    expect(screen.getByRole("button", { name: "Download PDF" }).hasAttribute("disabled")).toBe(
      true,
    );

    finish({ ok: true, data: { canceled: true } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Download PDF" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(exportReportPdf).toHaveBeenCalledTimes(1);
  });

  it("shows native save failures and lets the user retry", async () => {
    const exportReportPdf = vi.fn().mockRejectedValue(new Error("IPC failed"));
    window.scopeApp = { info: vi.fn(), openLogs: vi.fn(), exportReportPdf };
    render(<ReportsView initialReports={[DONE_REPORT]} />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Could not save"));
    expect(screen.getByRole("button", { name: "Download PDF" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("shows a proper empty state that starts a new report", () => {
    render(<ReportsView initialReports={[]} />);

    expect(screen.getByRole("heading", { name: "Reports" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No reports yet" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Go to AI Research" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open AI Chat" })).toBeNull();
    expect(screen.getByRole("button", { name: "New report" })).toBeTruthy();
    // One sample cover per style shows what a report can look like.
    expect(screen.getByText("Editorial")).toBeTruthy();
    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByText("Swiss")).toBeTruthy();
  });

  it("names a finished report by its extracted headline, with its style and depth", () => {
    render(<ReportsView initialReports={[DONE_REPORT]} />);

    expect(screen.getByRole("heading", { name: "Reports", level: 1 })).toBeTruthy();
    const entry = row(/GTA, Jackson Hole, and the Attention Economy/);
    expect(entry.getAttribute("aria-current")).toBe("true");
    expect(entry.getAttribute("title")).toBe(
      "A streamer's Friday read on a market waiting for the Fed.",
    );
    // The standfirst previews the report right in the row.
    expect(
      within(entry).getByText("A streamer's Friday read on a market waiting for the Fed."),
    ).toBeTruthy();
    expect(within(entry).getByText(/Balanced ·/)).toBeTruthy();

    const header = screen.getByRole("heading", {
      name: "GTA, Jackson Hole, and the Attention Economy",
      level: 2,
    });
    expect(header).toBeTruthy();
    expect(screen.getByText(/Editorial · Balanced · 2 sources/)).toBeTruthy();
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
            sourceCount: 1,
            videos: [DONE_REPORT.videos[0]],
          }),
        ]}
      />,
    );

    expect(row(/First source video \+1 more/)).toBeTruthy();
    expect(row(/^First source video Balanced/)).toBeTruthy();
  });

  it("reads a finished report in place, links it out, and lists its sources on demand", () => {
    render(<ReportsView initialReports={[DONE_REPORT]} />);

    const open = screen.getByRole("link", { name: "Open report" });
    expect(open.getAttribute("href")).toBe("/api/ai/reports/3/file");
    expect(open.getAttribute("target")).toBe("_blank");

    const reader = screen.getByTitle(/report preview/);
    expect(reader.tagName).toBe("IFRAME");
    expect(reader.getAttribute("src")).toMatch(/^\/api\/ai\/reports\/3\/file\?embed=1&/);
    expect(reader.getAttribute("sandbox")).toBe("allow-popups allow-popups-to-escape-sandbox");
    expect(screen.queryByText(/\/home\/me\/localtube/)).toBeNull();

    expect(screen.queryByRole("complementary", { name: "Outline and sources" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Outline and sources" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    // With no outline indexed yet, the panel opens on the sources.
    const sources = screen.getByRole("complementary", { name: "Outline and sources" });
    expect(within(sources).queryByRole("tab", { name: "Outline" })).toBeNull();
    expect(
      within(sources).getByRole("tab", { name: "Sources 2" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      within(sources)
        .getByRole("link", { name: /First source video/ })
        .getAttribute("href"),
    ).toBe("/channels/1/videos/vidA000001");
    expect(
      within(sources)
        .getByRole("link", { name: /Second source video/ })
        .getAttribute("href"),
    ).toBe("/channels/2/videos/vidA000002");
    expect(within(sources).getByText("7:01")).toBeTruthy();

    fireEvent.click(within(sources).getByRole("button", { name: "Close panel" }));
    expect(screen.queryByRole("complementary", { name: "Outline and sources" })).toBeNull();
  });

  it("copies the report's file path from the actions menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ReportsView initialReports={[DONE_REPORT]} />);

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy file path/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(DONE_REPORT.filePath));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("copied"));
  });

  it("shows each report's requested style and depth", () => {
    render(
      <ReportsView
        initialReports={[
          report({ id: 3, profile: "deep", style: "terminal" }),
          report({ id: 2, profile: "brief", style: "swiss", title: "Second" }),
        ]}
      />,
    );

    expect(screen.getByText(/Terminal · Deep · 2 sources/)).toBeTruthy();
    fireEvent.click(row(/Second/));
    expect(screen.getByText(/Swiss · Brief · 2 sources/)).toBeTruthy();
  });

  it("renders a failed report with its client-safe error and a retry", () => {
    render(<ReportsView initialReports={[FAILED_REPORT]} />);

    expect(within(row(/First source video \+1 more/)).getByText("Failed")).toBeTruthy();
    expect(screen.getByText("This report didn't finish")).toBeTruthy();
    expect(screen.getByText("The report job failed.")).toBeTruthy();
    expect(
      screen.getByText("Codex hit a usage or rate limit. Wait a bit and try again."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open report" })).toBeNull();
    expect(screen.queryByTitle(/report preview/)).toBeNull();
  });

  it("retries a failed report and follows the new job", async () => {
    const queued = report({
      id: 7,
      status: "queued",
      title: null,
      dek: null,
      fileUrl: null,
      filePath: null,
      completedAt: null,
      sources: [
        {
          kind: "video",
          id: "vidA000001",
          title: "First source video",
          creatorId: 1,
          creatorName: "Creator One",
          thumbnailUrl: null,
          publishedAt: null,
          url: "/channels/1/videos/vidA000001",
          durationSeconds: null,
        },
      ],
    });
    const failed = { ...FAILED_REPORT, sources: queued.sources };
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ report: { id: 7, title: null, status: "queued" } }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ reports: [queued, failed] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    render(<ReportsView initialReports={[failed]} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Waiting its turn")).toBeTruthy());
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      sources: [{ kind: "video", id: "vidA000001" }],
      profile: "balanced",
      style: "editorial",
    });
    expect(window.location.search).toBe("?report=7");
    expect(screen.getByRole("status").textContent).toContain("Retry queued");
  });

  it("shows queued and running jobs with their progress instead of a reader", () => {
    render(
      <ReportsView
        initialReports={[
          report({
            id: 4,
            status: "queued",
            title: "Queued report",
            fileUrl: null,
            filePath: null,
            completedAt: null,
          }),
          RUNNING_REPORT,
        ]}
      />,
    );

    expect(within(row(/Queued report/)).getByText(/Queued · 1 ahead/)).toBeTruthy();
    expect(within(row(/First source video \+1 more/)).getByText("Writing")).toBeTruthy();

    // With nothing finished, the newest report opens first.
    expect(screen.getByText("Waiting its turn")).toBeTruthy();
    expect(
      screen.getByText("Reports run one at a time — 1 job is ahead of this one."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove from queue" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open report" })).toBeNull();

    fireEvent.click(row(/First source video \+1 more/));
    expect(screen.getByText("Generating the report…")).toBeTruthy();
    // A running job cannot be deleted (the API refuses it mid-run).
    expect(screen.queryByRole("button", { name: "Remove from queue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More report actions" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open report" })).toBeNull();
  });

  it("lists reports newest first and opens the newest finished one", () => {
    render(
      <ReportsView
        initialReports={[
          RUNNING_REPORT,
          { ...DONE_REPORT, title: "Finished" },
          { ...FAILED_REPORT, title: "Broken" },
        ]}
      />,
    );

    const titles = within(rail())
      .getAllByRole("button")
      .filter((element) => element.closest("li"))
      .map((element) => element.textContent);
    expect(titles[0]).toContain("First source video +1 more");
    expect(titles[1]).toContain("Finished");
    expect(titles[2]).toContain("Broken");
    expect(row(/Finished/).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("heading", { name: "Finished", level: 2 })).toBeTruthy();
  });

  it("opens the report named in the URL", () => {
    render(
      <ReportsView
        initialReports={[DONE_REPORT, { ...FAILED_REPORT, title: "Broken" }]}
        initialSelectedId={2}
      />,
    );
    expect(screen.getByRole("heading", { name: "Broken", level: 2 })).toBeTruthy();
  });

  it("moves through the list with the arrow keys and mirrors the selection in the URL", () => {
    render(
      <ReportsView
        initialReports={[
          { ...DONE_REPORT, title: "One" },
          report({ id: 2, title: "Two" }),
          report({ id: 1, title: "Three" }),
        ]}
      />,
    );

    fireEvent.keyDown(row(/One/), { key: "ArrowDown" });
    expect(screen.getByRole("heading", { name: "Two", level: 2 })).toBeTruthy();
    expect(document.activeElement).toBe(row(/Two/));
    expect(window.location.search).toBe("?report=2");
    fireEvent.keyDown(row(/Two/), { key: "End" });
    expect(screen.getByRole("heading", { name: "Three", level: 2 })).toBeTruthy();
    fireEvent.keyDown(row(/Three/), { key: "k" });
    expect(screen.getByRole("heading", { name: "Two", level: 2 })).toBeTruthy();
  });

  it("searches titles and sources, filters by status, and recovers from no matches", () => {
    render(
      <ReportsView
        initialReports={[
          { ...DONE_REPORT, title: "Fed watch" },
          { ...FAILED_REPORT, title: "Broken" },
          RUNNING_REPORT,
        ]}
      />,
    );

    const search = screen.getByRole("searchbox", { name: "Search reports" });
    fireEvent.change(search, { target: { value: "fed" } });
    expect(row(/Fed watch/)).toBeTruthy();
    expect(within(rail()).queryByRole("button", { name: /Broken/ })).toBeNull();

    // Source titles match too.
    fireEvent.change(search, { target: { value: "second source" } });
    expect(within(rail()).getAllByRole("listitem")).toHaveLength(3);

    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /^Failed/ }));
    expect(within(rail()).getAllByRole("listitem")).toHaveLength(1);
    expect(row(/Broken/)).toBeTruthy();

    fireEvent.change(search, { target: { value: "nothing like this" } });
    expect(screen.getByText("No matching reports")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all reports" }));
    expect(within(rail()).getAllByRole("listitem")).toHaveLength(3);
  });

  it("deletes a report after confirmation and moves on to the next one", async () => {
    const fetchMock = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    render(<ReportsView initialReports={[DONE_REPORT, report({ id: 2, title: "Next one" })]} />);

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByText("Delete this report?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete report" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/ai/reports/3", { method: "DELETE" });
    });
    await waitFor(() => {
      expect(screen.queryByText("GTA, Jackson Hole, and the Attention Economy")).toBeNull();
    });
    expect(screen.getByRole("heading", { name: "Next one", level: 2 })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Report deleted.");
  });

  it("renames a report from the actions menu", async () => {
    const renamed = report({ id: 3, title: "The Fed, GTA, and my attention" });
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ report: renamed }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ReportsView initialReports={[DONE_REPORT]} />);

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
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
      expect(
        screen.getByRole("heading", { name: "The Fed, GTA, and my attention", level: 2 }),
      ).toBeTruthy();
    });
  });

  it("collapses wide source lists behind a toggle while a report is unreadable", () => {
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
          {
            ...FAILED_REPORT,
            videoIds: many.map((video) => video.id),
            videoCount: many.length,
            sourceCount: many.length,
            videos: many,
          },
        ]}
      />,
    );

    const section = screen.getByLabelText("Report sources");
    expect(within(section).getByText("10 sources")).toBeTruthy();
    expect(within(section).getByText("Source 0")).toBeTruthy();
    expect(within(section).queryByText("Source 9")).toBeNull();

    fireEvent.click(within(section).getByRole("button", { name: "Show 4 more sources" }));
    expect(within(section).getByText("Source 9")).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "Show fewer sources" }));
    expect(within(section).queryByText("Source 9")).toBeNull();
  });
});

/**
 * Finding and reading reports: who each row is about and where it came
 * from, the Filter popover (source type, category, creator), search inside
 * the documents' text, and the reader's outline panel with reading time.
 */
describe("ReportsView discovery", () => {
  const THREADGUY = {
    id: 1,
    name: "threadguy",
    avatarCreatorId: null,
    avatarUrl: null,
    sourceCount: 2,
  };
  const ANSEM = { ...THREADGUY, id: 2, name: "Ansem", sourceCount: 4 };
  const BIJAN = { ...THREADGUY, id: 3, name: "Bijan Bowen", sourceCount: 1 };
  const CRYPTO = { id: 10, name: "Crypto", color: "sky" as const };
  const AI = { id: 11, name: "AI", color: "violet" as const };

  const VIDEO_REPORT = report({
    id: 30,
    title: "Markets at a Fork",
    dek: "A single-source analysis of a livestream.",
    creators: [THREADGUY],
    categories: [CRYPTO],
    platforms: ["youtube"],
  });
  const X_BRIEF = report({
    id: 31,
    title: "Brief me · Crypto KOL's",
    dek: "TL;DR — BTC rebound conviction dominated.",
    origin: "x-dashboard",
    scopeLabel: "Crypto KOL's",
    sourceCount: 55,
    videos: [],
    videoIds: [],
    creators: [ANSEM, THREADGUY],
    categories: [CRYPTO],
    platforms: ["x"],
    readingMinutes: 3,
    wordCount: 610,
  });
  const AI_REPORT = report({
    id: 32,
    title: "Model choice in production vibe coding",
    dek: "Specialization beats a universal ranking.",
    creators: [BIJAN],
    categories: [AI],
    platforms: ["youtube"],
  });
  const ALL = [X_BRIEF, VIDEO_REPORT, AI_REPORT];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function openFilters(): HTMLElement {
    fireEvent.click(within(rail()).getByRole("button", { name: /^Filters/ }));
    return screen.getByRole("dialog", { name: "Filter reports" });
  }

  function visibleTitles(): string[] {
    return within(rail())
      .queryAllByRole("button", { name: /Markets at a Fork|Brief me|Model choice/ })
      .map((button) => button.querySelector(".line-clamp-2")?.textContent ?? "");
  }

  it("names who each report is about and where it came from", () => {
    render(<ReportsView initialReports={ALL} initialSelectedId={31} />);

    const brief = row(/Brief me · Crypto KOL's/);
    expect(within(brief).getByText("TL;DR — BTC rebound conviction dominated.")).toBeTruthy();
    expect(within(brief).getByText("Crypto KOL's")).toBeTruthy();
    expect(within(brief).getByText(/X brief/)).toBeTruthy();
    expect(within(row(/Markets at a Fork/)).getByText("threadguy")).toBeTruthy();
    expect(within(row(/Markets at a Fork/)).getByText(/Balanced/)).toBeTruthy();

    // A saved insight says what it is, not a style and depth it never ran with.
    expect(screen.getByText(/X Dashboard brief · 55 posts · 3 min read/)).toBeTruthy();
    expect(screen.queryByText(/Editorial · Brief/)).toBeNull();
  });

  it("filters by source type, category, and creator, with removable chips", () => {
    render(<ReportsView initialReports={ALL} />);
    expect(visibleTitles()).toHaveLength(3);

    let dialog = openFilters();
    fireEvent.click(within(dialog).getByRole("button", { name: /X posts/ }));
    expect(
      within(dialog)
        .getByRole("button", { name: /X posts/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(visibleTitles()).toEqual(["Brief me · Crypto KOL's"]);
    expect(within(dialog).getByText("1 of 3 reports")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Filter reports" })).toBeNull();
    expect(within(rail()).getByRole("button", { name: "Filters, 1 active" })).toBeTruthy();

    // The chip says why the rail is short, and removing it restores the rest.
    const chips = within(rail()).getByRole("group", { name: "Active filters" });
    fireEvent.click(within(chips).getByRole("button", { name: "Remove filter: X posts" }));
    expect(visibleTitles()).toHaveLength(3);

    dialog = openFilters();
    fireEvent.click(within(dialog).getByRole("button", { name: /^AI/ }));
    expect(visibleTitles()).toEqual(["Model choice in production vibe coding"]);
    // Picking a second category widens the match (a union within a facet).
    fireEvent.click(within(dialog).getByRole("button", { name: /^Crypto/ }));
    expect(visibleTitles()).toHaveLength(3);
    // A creator narrows across facets: Crypto or AI, and by threadguy.
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /threadguy/ }));
    expect(visibleTitles()).toEqual(["Brief me · Crypto KOL's", "Markets at a Fork"]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Clear all" }));
    expect(visibleTitles()).toHaveLength(3);
    expect(within(rail()).queryByRole("group", { name: "Active filters" })).toBeNull();
  });

  it("recovers from filters that match nothing", () => {
    render(<ReportsView initialReports={ALL} />);
    const dialog = openFilters();
    fireEvent.click(within(dialog).getByRole("button", { name: /X posts/ }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Bijan Bowen/ }));
    expect(within(rail()).getByText("No matching reports")).toBeTruthy();

    fireEvent.click(within(rail()).getByRole("button", { name: "Show all reports" }));
    expect(visibleTitles()).toHaveLength(3);
    expect(within(rail()).getByRole("button", { name: "Filters" })).toBeTruthy();
  });

  it("searches inside the reports' text and shows where it matched", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          matches: [
            { id: 30, snippet: "…a speech by \u0002Warsh\u0003 at Jackson Hole as the hinge…" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ReportsView initialReports={ALL} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search reports" }), {
      target: { value: "warsh" },
    });
    // Nothing in a title, standfirst, or source says "warsh"…
    expect(within(rail()).getByText("No matching reports")).toBeTruthy();
    // …but the document text does, and the row shows the passage.
    await waitFor(() => expect(visibleTitles()).toEqual(["Markets at a Fork"]));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ai/reports/search?q=warsh",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const hit = row(/Markets at a Fork/);
    expect(within(hit).getByText("Warsh").tagName).toBe("MARK");
    expect(within(hit).queryByText("A single-source analysis of a livestream.")).toBeNull();
  });

  it("outlines the report with its reading time and jumps the reader to a section", () => {
    const outlined = report({
      id: 40,
      outline: [
        { id: "overview", text: "Executive overview", level: 2 },
        { id: "themes", text: "Key themes", level: 2 },
        { id: "scope-section-1", text: "Selection replaces broad beta", level: 3 },
      ],
      wordCount: 1369,
      readingMinutes: 6,
    });
    render(<ReportsView initialReports={[outlined]} />);

    expect(screen.getByText(/Editorial · Balanced · 2 sources · 6 min read/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Outline and sources" }));
    const panel = screen.getByRole("complementary", { name: "Outline and sources" });
    expect(within(panel).getByRole("tab", { name: "Outline" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(within(panel).getByText("6 min read")).toBeTruthy();
    expect(within(panel).getByText("1,369 words")).toBeTruthy();
    expect(within(panel).getByText("2 sections")).toBeTruthy();

    // The sandboxed frame cannot be scripted, but a fragment navigation
    // scrolls it in place.
    const frame = screen.getByTitle(/report preview/) as HTMLIFrameElement;
    const replace = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { location: { replace } } });
    fireEvent.click(within(panel).getByRole("button", { name: "Selection replaces broad beta" }));
    expect(replace).toHaveBeenCalledWith(`${frame.getAttribute("src")}#scope-section-1`);
    // Over the report on a narrow screen, the panel gets out of the way.
    expect(screen.queryByRole("complementary", { name: "Outline and sources" })).toBeNull();

    // The source list is the panel's other tab.
    fireEvent.click(screen.getByRole("button", { name: "Outline and sources" }));
    fireEvent.click(screen.getByRole("tab", { name: "Sources 2" }));
    expect(screen.getByRole("link", { name: /First source video/ })).toBeTruthy();
  });

  it("opens the outline beside roomy readers and remembers the choice", () => {
    // Node's own (disabled) localStorage shadows the DOM one under vitest.
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    };
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
    onTestFinished(() => {
      if (original) Object.defineProperty(window, "localStorage", original);
      else delete (window as { localStorage?: unknown }).localStorage;
    });
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: true,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    const outlined = report({
      id: 41,
      outline: [{ id: "overview", text: "Executive overview", level: 2 }],
      wordCount: 400,
      readingMinutes: 2,
    });
    render(<ReportsView initialReports={[outlined]} />);

    const panel = screen.getByRole("complementary", { name: "Outline and sources" });
    expect(within(panel).getByRole("tab", { name: "Outline" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
    expect(screen.queryByRole("complementary", { name: "Outline and sources" })).toBeNull();
    expect(stored.get("scope:reports:panel")).toBe("closed");
  });
});

/** The picker's library, as GET /api/ai/sources answers it. */
const LIBRARY = {
  videos: [
    {
      id: "vidN000001",
      creatorId: 1,
      title: "Alpha deep dive",
      creatorName: "Alpha Channel",
      thumbnailUrl: null,
      publishedAt: null,
      durationSeconds: 600,
      liveStatus: "not_live",
      categoryIds: [],
    },
    {
      id: "vidN000002",
      creatorId: 2,
      title: "Beta interview",
      creatorName: "Beta Channel",
      thumbnailUrl: null,
      publishedAt: null,
      durationSeconds: 900,
      liveStatus: "not_live",
      categoryIds: [],
    },
  ],
  tweets: [],
  creators: [
    {
      id: 1,
      profileId: 10,
      displayName: "Alpha Channel",
      avatarUrl: null,
      avatarCreatorId: 1,
      platform: "youtube",
    },
    {
      id: 2,
      profileId: 20,
      displayName: "Beta Channel",
      avatarUrl: null,
      avatarCreatorId: 2,
      platform: "youtube",
    },
  ],
  categories: [],
};

const QUEUED_REPORT = report({
  id: 7,
  status: "queued",
  title: null,
  dek: null,
  fileUrl: null,
  filePath: null,
  completedAt: null,
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Routes the new-report flow's requests: the library, the queue request,
 * and the list refresh that follows it. Anything else (the options dialog's
 * provider lookup, the transcript prefetch) gets an empty answer.
 */
function mockNewReportApi(
  options: { library?: () => Response; post?: () => Response; reportsAfter?: ReportSummary[] } = {},
) {
  return vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/ai/sources") return options.library?.() ?? json(LIBRARY);
    if (url === "/api/ai/reports" && init?.method === "POST") {
      return options.post?.() ?? json({ report: { id: 7, title: null, status: "queued" } }, 202);
    }
    if (url === "/api/ai/reports") return json({ reports: options.reportsAfter ?? [] });
    return json({});
  });
}

function postedBodies(fetchMock: ReturnType<typeof mockNewReportApi>): unknown[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => String(input) === "/api/ai/reports" && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init?.body)));
}

/** Ticks one video in the open picker and moves on to the report's options. */
async function pickSource(title: string): Promise<HTMLElement> {
  const picker = await screen.findByRole("dialog", { name: "Choose sources" });
  fireEvent.click(await within(picker).findByRole("checkbox", { name: `Select ${title}` }));
  fireEvent.click(within(picker).getByRole("button", { name: "Continue with 1 source" }));
  return screen.findByRole("dialog", { name: "Generate report" });
}

describe("ReportsView — new report", () => {
  it("queues a report from freshly picked sources, without a chat, and follows it", async () => {
    const fetchMock = mockNewReportApi({ reportsAfter: [QUEUED_REPORT, DONE_REPORT] });
    render(<ReportsView initialReports={[DONE_REPORT]} />);

    fireEvent.click(within(rail()).getByRole("button", { name: "New report" }));
    const picker = await screen.findByRole("dialog", { name: "Choose sources" });
    expect(within(picker).getByText(/The report is written from what the videos/)).toBeTruthy();
    // Nothing is picked until the user picks it.
    expect(within(picker).getByRole("button", { name: "Continue" })).toHaveProperty(
      "disabled",
      true,
    );

    const options = await pickSource("Alpha deep dive");
    expect(
      within(options).getByText("One self-contained HTML document from 1 source by 1 creator."),
    ).toBeTruthy();
    // Captions start downloading while the style and depth are picked.
    const prepare = fetchMock.mock.calls.find(([input]) => String(input) === "/api/ai/prepare");
    expect(JSON.parse(String(prepare?.[1]?.body))).toEqual({ videoIds: ["vidN000001"] });

    fireEvent.click(within(options).getByRole("button", { name: "Generate report" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(postedBodies(fetchMock)).toEqual([
      { sources: [{ kind: "video", id: "vidN000001" }], profile: "balanced", style: "editorial" },
    ]);
    // The new job is selected, so its progress is what the pane shows.
    expect(window.location.search).toBe("?report=7");
    expect(screen.getByText("Waiting its turn")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Report queued");
  });

  it("keeps the picked sources on Back, and the options open when the server refuses", async () => {
    const fetchMock = mockNewReportApi({
      post: () =>
        json(
          {
            error: {
              code: "no_ready_sources",
              message: "None of the selected sources has cached content yet.",
            },
          },
          422,
        ),
    });
    render(<ReportsView initialReports={[DONE_REPORT]} />);

    fireEvent.click(within(rail()).getByRole("button", { name: "New report" }));
    let options = await pickSource("Beta interview");
    fireEvent.click(within(options).getByRole("button", { name: "Back to sources" }));
    const picker = await screen.findByRole("dialog", { name: "Choose sources" });
    expect(
      (within(picker).getByRole("checkbox", { name: "Select Beta interview" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    fireEvent.click(within(picker).getByRole("button", { name: "Continue with 1 source" }));

    options = await screen.findByRole("dialog", { name: "Generate report" });
    fireEvent.click(within(options).getByRole("button", { name: "Generate report" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("None of the selected sources"),
    );
    expect(postedBodies(fetchMock)).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Generate report" })).toBeTruthy();
    expect(window.location.search).toBe("");

    fireEvent.click(within(options).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("queues the first report from the empty state and opens the reading room", async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const fetchMock = mockNewReportApi({ reportsAfter: [QUEUED_REPORT] });
    render(<ReportsView initialReports={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "New report" }));
    const options = await pickSource("Alpha deep dive");
    fireEvent.click(within(options).getByRole("button", { name: "Generate report" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(postedBodies(fetchMock)).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "No reports yet" })).toBeNull();
    expect(screen.getByText("Waiting its turn")).toBeTruthy();
    // The picker and the options opened once each.
    expect(showModal).toHaveBeenCalledTimes(2);
  });

  it("opens the picker in its search box, and again on Back", async () => {
    // happy-dom skips the focusing a browser does on showModal: focus moves
    // to the dialog's first focusable element (its Close button), which is
    // what the search box has to win against.
    const showModal = HTMLDialogElement.prototype.showModal;
    vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      showModal.call(this);
      this.querySelector<HTMLElement>("button, input")?.focus();
    });
    mockNewReportApi();
    render(<ReportsView initialReports={[DONE_REPORT]} />);

    fireEvent.click(within(rail()).getByRole("button", { name: "New report" }));
    let picker = await screen.findByRole("dialog", { name: "Choose sources" });
    let search = await within(picker).findByRole("searchbox", { name: "Search sources" });
    await waitFor(() => expect(document.activeElement).toBe(search));

    const options = await pickSource("Alpha deep dive");
    fireEvent.click(within(options).getByRole("button", { name: "Back to sources" }));
    picker = await screen.findByRole("dialog", { name: "Choose sources" });
    search = within(picker).getByRole("searchbox", { name: "Search sources" });
    await waitFor(() => expect(document.activeElement).toBe(search));
  });

  it("reads the library again when a creator refresh lands, keeping the ticks", async () => {
    const followUp = { ...LIBRARY.videos[0], id: "vidN000003", title: "Alpha follow-up" };
    let reads = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/ai/sources") {
        reads += 1;
        return json(reads === 1 ? LIBRARY : { ...LIBRARY, videos: [followUp, ...LIBRARY.videos] });
      }
      if (url === "/api/background") return json({ ok: true, status: "refreshed", addedVideos: 1 });
      if (url === "/api/ai/reports") return json({ reports: [] });
      return json({});
    });
    render(<ReportsView initialReports={[DONE_REPORT]} />);

    fireEvent.click(within(rail()).getByRole("button", { name: "New report" }));
    const picker = await screen.findByRole("dialog", { name: "Choose sources" });
    fireEvent.click(
      await within(picker).findByRole("checkbox", { name: "Select Alpha deep dive" }),
    );
    fireEvent.click(
      within(within(picker).getByRole("region", { name: "Alpha Channel" })).getByRole("button", {
        name: "Refresh Alpha Channel (never updated)",
      }),
    );

    const arrived = await within(picker).findByRole("checkbox", { name: "Select Alpha follow-up" });
    expect(reads).toBe(2);
    expect((arrived as HTMLInputElement).checked).toBe(false);
    expect(within(picker).getByRole("button", { name: /^New/ })).toBeTruthy();
    expect(
      (within(picker).getByRole("checkbox", { name: "Select Alpha deep dive" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("says so when the library cannot be read", async () => {
    mockNewReportApi({ library: () => json({ error: { message: "boom" } }, 500) });
    render(<ReportsView initialReports={[DONE_REPORT]} />);

    fireEvent.click(within(rail()).getByRole("button", { name: "New report" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Could not load your library"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
