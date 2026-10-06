// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { BackgroundChatProvider } from "@/components/ai/background-chat";
import type { ReactElement } from "react";

const render = (element: ReactElement) => rtlRender(element, { wrapper: BackgroundChatProvider });

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ResearchView,
  type ResearchCreator,
  type ResearchVideo,
} from "@/app/research/research-view";

/**
 * The AI Research two-step flow (stage 5): creator picking, cross-creator
 * video list with search + transcripts filter, and the validation gate on
 * the chat action. Rows are labeled video vs livestream and offer inline
 * transcript extraction, so the server action and router are mocked at
 * their boundaries. fetch is mocked because opening the panel refreshes
 * thread history.
 */

const { refreshMock, getTranscriptActionMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  getTranscriptActionMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

vi.mock("@/components/background/operations", () => ({
  getTranscriptAction: getTranscriptActionMock,
}));

const CREATORS: ResearchCreator[] = [
  {
    id: 1,
    displayName: "Alpha Channel",
    handle: "alpha",
    avatarUrl: null,
    categories: [{ id: 1, name: "Technology", color: "sky" }],
  },
  { id: 2, displayName: "Beta Channel", handle: "beta", avatarUrl: null, categories: [] },
];

const CATEGORIES = [{ id: 1, name: "Technology", color: "sky" as const, creatorCount: 1 }];

function video(
  overrides: Partial<ResearchVideo> & { id: string; creatorId: number; title: string },
): ResearchVideo {
  return {
    creatorName: overrides.creatorId === 1 ? "Alpha Channel" : "Beta Channel",
    thumbnailUrl: null,
    publishedAt: "2026-08-01T00:00:00Z",
    durationSeconds: 600,
    liveStatus: "not_live",
    hasTranscript: true,
    ...overrides,
  };
}

const VIDEOS: ResearchVideo[] = [
  video({ id: "vidA000001", creatorId: 1, title: "Alpha deep dive" }),
  video({ id: "vidA000002", creatorId: 1, title: "Alpha quick update", hasTranscript: false }),
  video({ id: "vidB000001", creatorId: 2, title: "Beta interview" }),
  video({ id: "vidB000002", creatorId: 2, title: "Beta stream", hasTranscript: false }),
  video({
    id: "vidB000003",
    creatorId: 2,
    title: "Beta live show",
    liveStatus: "was_live",
    hasTranscript: false,
  }),
];

function renderView() {
  return render(<ResearchView creators={CREATORS} videos={VIDEOS} categories={CATEGORIES} />);
}

function pickCreator(name: string): void {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
}

function selectVideo(title: string): HTMLInputElement {
  const checkbox = screen.getByRole("checkbox", { name: `Select ${title}` });
  fireEvent.click(checkbox);
  return checkbox as HTMLInputElement;
}

function chatPanel(): HTMLElement {
  return screen.getByRole("complementary", { name: "Ask AI" });
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  refreshMock.mockClear();
  getTranscriptActionMock.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/ai/chat/threads") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ threads: [] }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ResearchView", () => {
  it("filters creators by one or several categories and can return to All", () => {
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "Technology 1" }));
    expect(screen.getByRole("button", { name: /Alpha Channel/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Beta Channel/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Uncategorized 1" }));
    expect(screen.getByRole("button", { name: /Alpha Channel/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Beta Channel/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("holds step two in its disabled state until a creator is picked", () => {
    renderView();
    expect(screen.getByText("Pick at least one creator above to choose sources.")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Chat about selection" })).toBeNull();

    // Picking a creator reveals the action bar in its empty, disabled state.
    pickCreator("Alpha Channel");
    expect(screen.getByText("Nothing selected")).toBeTruthy();
    const chatButton = screen.getByRole("button", { name: "Chat about selection" });
    expect((chatButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Select at least one source to chat about it.")).toBeTruthy();
  });

  it("pools videos from every picked creator", () => {
    renderView();
    pickCreator("Alpha Channel");
    expect(screen.getByText("2 of 2 sources shown")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select Alpha deep dive" })).toBeTruthy();

    pickCreator("Beta Channel");
    expect(screen.getByText("5 of 5 sources shown")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select Beta interview" })).toBeTruthy();
  });

  it("filters the list by search without discarding earlier selections", () => {
    renderView();
    pickCreator("Alpha Channel");
    pickCreator("Beta Channel");

    selectVideo("Alpha deep dive");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search sources" }), {
      target: { value: "interview" },
    });

    expect(screen.getByText("1 of 5 sources shown")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Select Alpha deep dive" })).toBeNull();
    expect(screen.getByText("1 source selected")).toBeTruthy();
  });

  it("filters to transcripted videos with the transcripts toggle", () => {
    renderView();
    pickCreator("Alpha Channel");

    fireEvent.click(screen.getByRole("button", { name: "Ready for analysis" }));

    expect(screen.getByText("1 of 2 sources shown")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Select Alpha quick update" })).toBeNull();
  });

  it("opens the chat with a cross-creator scope", () => {
    renderView();
    pickCreator("Alpha Channel");
    pickCreator("Beta Channel");

    selectVideo("Alpha deep dive");
    selectVideo("Beta interview");
    expect(screen.getByText("2 sources selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Chat about selection" }));

    const panel = chatPanel();
    expect(panel.hasAttribute("inert")).toBe(false);
    within(panel).getByText("2 sources across 2 creators");
  });

  it("keeps the chat action disabled while the selection has no transcripts", () => {
    renderView();
    pickCreator("Alpha Channel");
    selectVideo("Alpha quick update");

    expect(screen.getByText(/1 without cached content will be skipped/)).toBeTruthy();
    const chatButton = screen.getByRole("button", {
      name: "Chat about selection",
    }) as HTMLButtonElement;
    expect(chatButton.disabled).toBe(true);
    expect(screen.getByText(/None of the selected sources has cached content yet/)).toBeTruthy();
  });

  it("drops a creator's picks when that creator is deselected", () => {
    renderView();
    pickCreator("Alpha Channel");
    pickCreator("Beta Channel");

    selectVideo("Alpha deep dive");
    selectVideo("Beta interview");
    expect(screen.getByText("2 sources selected")).toBeTruthy();

    const alphaChip = screen.getByRole("button", { name: /Alpha Channel/ });
    fireEvent.click(alphaChip);

    expect(screen.getByText("1 source selected")).toBeTruthy();
  });

  it("labels each row as a video or a livestream", () => {
    renderView();
    pickCreator("Beta Channel");

    // Ordinary uploads read as videos; stored live states keep their badge.
    expect(screen.getAllByText("Video")).toHaveLength(2);
    expect(screen.getByText("Past live")).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  });

  it("offers inline transcript extraction on rows without one", async () => {
    getTranscriptActionMock.mockResolvedValue({
      ok: true,
      transcript: {
        text: "transcript body",
        language: "en",
        captionSource: "automatic",
        fetchedAt: "2026-08-28T00:00:00.000Z",
        fromCache: false,
      },
    });
    renderView();
    pickCreator("Alpha Channel");

    // Transcripted rows show a badge; untranscripted rows offer the action.
    expect(screen.getByText("Transcript")).toBeTruthy();
    const getButtons = screen.getAllByRole("button", { name: "Get transcript" });
    expect(getButtons).toHaveLength(1);

    fireEvent.click(getButtons[0]);

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalled();
    });
    expect(getTranscriptActionMock).toHaveBeenCalledWith(1, "vidA000002", "get");
    expect(screen.getByRole("status").textContent).toContain(
      "Transcript extracted for this video.",
    );
  });

  it("surfaces extraction failures without refreshing", async () => {
    getTranscriptActionMock.mockResolvedValue({
      ok: false,
      errorCode: "no_captions",
      message: "This video has no captions at all — YouTube lists no subtitle tracks for it.",
    });
    renderView();
    pickCreator("Alpha Channel");

    fireEvent.click(screen.getByRole("button", { name: "Get transcript" }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "This video has no captions at all — YouTube lists no subtitle tracks for it.",
      );
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("runs one extraction at a time across rows", async () => {
    let release: (() => void) | undefined;
    getTranscriptActionMock.mockReturnValue(
      new Promise((resolve) => {
        release = () =>
          resolve({
            ok: true,
            transcript: {
              text: "t",
              language: "en",
              captionSource: "automatic",
              fetchedAt: "2026-08-28T00:00:00.000Z",
              fromCache: false,
            },
          });
      }),
    );
    renderView();
    pickCreator("Beta Channel");

    const buttons = screen.getAllByRole("button", { name: "Get transcript" });
    expect(buttons).toHaveLength(2);

    fireEvent.click(buttons[0]);
    // The clicked row shows progress; every other extraction stays locked.
    expect(screen.getByRole("button", { name: /Extracting/ })).toBeTruthy();
    for (const button of screen.getAllByRole("button", { name: "Get transcript" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }

    release?.();
    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalled();
    });
    expect(screen.getAllByRole("button", { name: "Get transcript" })).toHaveLength(2);
  });
});
