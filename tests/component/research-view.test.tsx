// @vitest-environment happy-dom
import { cleanup, fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import { BackgroundChatProvider } from "@/components/ai/background-chat";
import type { ReactElement } from "react";

const render = (element: ReactElement) => rtlRender(element, { wrapper: BackgroundChatProvider });

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ResearchView,
  type ResearchCreator,
  type ResearchTweet,
  type ResearchVideo,
} from "@/app/research/research-view";

/**
 * The AI Research two-step flow (stage 5): creator picking, cross-creator
 * source list with search, and the gate on the chat action. Rows are labeled
 * video vs livestream; transcripts are never a user step — every video can
 * ground a chat. The router is mocked at its boundary, and fetch because
 * opening the panel refreshes thread history and starts the caption
 * prefetch.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
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
    ...overrides,
  };
}

const VIDEOS: ResearchVideo[] = [
  video({ id: "vidA000001", creatorId: 1, title: "Alpha deep dive" }),
  video({ id: "vidA000002", creatorId: 1, title: "Alpha quick update" }),
  video({ id: "vidB000001", creatorId: 2, title: "Beta interview" }),
  video({ id: "vidB000002", creatorId: 2, title: "Beta stream" }),
  video({
    id: "vidB000003",
    creatorId: 2,
    title: "Beta live show",
    liveStatus: "was_live",
  }),
];

const SUMMARY_TWEET: ResearchTweet = {
  id: "1234567890123456789",
  creatorId: 1,
  creatorName: "Alpha Channel",
  authorHandle: "alpha",
  authorName: "Alpha Channel",
  text: "A post whose full text is not cached yet",
  publishedAt: "2026-08-02T00:00:00Z",
  url: "https://x.com/alpha/status/1234567890123456789",
  mediaPreviewUrl: null,
  contentStatus: "summary",
  readyForAnalysis: false,
};

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
    if (url === "/api/ai/prepare") {
      return { ok: true, status: 202, json: async () => ({ pending: 0 }) } as unknown as Response;
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

  it("offers the readiness filter only when posts are missing their full text", () => {
    const { unmount } = renderView();
    pickCreator("Alpha Channel");
    // Every video can be analyzed, so there is nothing to filter out.
    expect(screen.queryByRole("button", { name: "Ready for analysis" })).toBeNull();
    unmount();

    render(
      <ResearchView
        creators={CREATORS}
        videos={VIDEOS}
        tweets={[SUMMARY_TWEET]}
        categories={CATEGORIES}
      />,
    );
    pickCreator("Alpha Channel");
    fireEvent.click(screen.getByRole("button", { name: "Ready for analysis" }));

    expect(screen.getByText("2 of 3 sources shown")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select Alpha quick update" })).toBeTruthy();
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

  it("lets any video ground a chat and starts reading it in the background", () => {
    renderView();
    pickCreator("Alpha Channel");
    selectVideo("Alpha quick update");

    expect(screen.queryByText(/will be skipped/)).toBeNull();
    const chatButton = screen.getByRole("button", {
      name: "Chat about selection",
    }) as HTMLButtonElement;
    expect(chatButton.disabled).toBe(false);

    fireEvent.click(chatButton);

    within(chatPanel()).getByText("1 source across 1 creator");
    const prepareCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/ai/prepare");
    expect(JSON.parse(String(prepareCall?.[1]?.body))).toEqual({ videoIds: ["vidA000002"] });
  });

  it("keeps the chat action disabled for posts without their full text", () => {
    render(
      <ResearchView
        creators={CREATORS}
        videos={VIDEOS}
        tweets={[SUMMARY_TWEET]}
        categories={CATEGORIES}
      />,
    );
    pickCreator("Alpha Channel");
    fireEvent.click(screen.getByRole("checkbox", { name: /Select A post whose full text/ }));

    expect(screen.getByText(/1 without cached content will be skipped/)).toBeTruthy();
    const chatButton = screen.getByRole("button", {
      name: "Chat about selection",
    }) as HTMLButtonElement;
    expect(chatButton.disabled).toBe(true);
    expect(
      screen.getByText(/None of the selected posts has its full text cached yet/),
    ).toBeTruthy();
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

  it("never offers a transcript step on video rows", () => {
    renderView();
    pickCreator("Alpha Channel");
    pickCreator("Beta Channel");

    expect(screen.queryByRole("button", { name: /Get transcript/ })).toBeNull();
    expect(screen.queryByText("Transcript")).toBeNull();
  });
});
