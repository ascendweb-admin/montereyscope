// @vitest-environment happy-dom
import { cleanup, fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import { BackgroundChatProvider } from "@/components/ai/background-chat";
import type { ReactElement } from "react";

const render = (element: ReactElement) => rtlRender(element, { wrapper: BackgroundChatProvider });

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SelectableFeed } from "@/components/channel/selectable-feed";
import type { VideoCardModel } from "@/components/channel/video-card";

/**
 * Channel feed selection (stage 5). Behavioral only: checkboxes across both
 * tabs, the floating action bar's count, and the chat panel opening over the
 * whole selection — transcripts are never a user step. fetch is mocked
 * because opening the panel refreshes thread history and starts the
 * background caption prefetch.
 */

// The chat panel navigates to /chat when expanded; the router is mocked at
// the boundary like every component test here.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

function card(
  overrides: Partial<VideoCardModel> & { videoId: string; title: string },
): VideoCardModel {
  return {
    detailHref: `/channels/1/videos/${overrides.videoId}`,
    thumbnailUrl: null,
    publishedLabel: "Aug 1, 2026",
    durationLabel: "10:00",
    liveStatus: "not_live",
    ...overrides,
  };
}

const VIDEO_A = card({ videoId: "vidA000001", title: "Video A" });
const VIDEO_B = card({ videoId: "vidB000001", title: "Video B" });
const VIDEO_C = card({ videoId: "vidC000001", title: "Video C" });
const STREAM_A = card({
  videoId: "strA000001",
  title: "Stream A",
  liveStatus: "was_live",
});

function renderFeed() {
  return render(
    <SelectableFeed
      videos={[VIDEO_A, VIDEO_B, VIDEO_C]}
      livestreams={[STREAM_A]}
      hasEverRefreshed={true}
      creatorName="Sample Creator"
    />,
  );
}

function selectCheckbox(title: string): HTMLInputElement {
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

describe("SelectableFeed", () => {
  it("shows no selection affordances until Select videos is pressed", () => {
    renderFeed();
    expect(screen.queryByRole("button", { name: "Chat about selection" })).toBeNull();
    expect(screen.getByRole("button", { name: "Select videos" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select videos" }));

    // Only the active tab's cards are mounted.
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    // Selectable cards are no longer links while selecting.
    expect(screen.queryByRole("link", { name: /Video A/ })).toBeNull();
  });

  it("keeps the action bar hidden while nothing is selected", () => {
    renderFeed();
    fireEvent.click(screen.getByRole("button", { name: "Select videos" }));
    expect(screen.queryByText(/selected/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Chat about selection" })).toBeNull();
  });

  it("counts selections across both tabs and preserves them when switching", () => {
    renderFeed();
    fireEvent.click(screen.getByRole("button", { name: "Select videos" }));

    selectCheckbox("Video A");
    fireEvent.click(screen.getByRole("tab", { name: /Livestreams/ }));
    expect(screen.queryByRole("checkbox", { name: "Select Video A" })).toBeNull();
    selectCheckbox("Stream A");

    expect(screen.getByText("2 videos selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Videos/ }));
    const videoACheckbox = screen.getByRole("checkbox", {
      name: "Select Video A",
    }) as HTMLInputElement;
    expect(videoACheckbox.checked).toBe(true);
    expect(screen.getByText("2 videos selected")).toBeTruthy();
  });

  it("never asks about transcripts while selecting", () => {
    renderFeed();
    fireEvent.click(screen.getByRole("button", { name: "Select videos" }));
    selectCheckbox("Video B");
    expect(screen.queryByText(/transcript/i)).toBeNull();
    expect(screen.queryByText(/will be skipped/)).toBeNull();
  });

  it("opens the chat over every selected video and starts reading them", () => {
    renderFeed();
    fireEvent.click(screen.getByRole("button", { name: "Select videos" }));
    selectCheckbox("Video A");
    selectCheckbox("Video B");
    fireEvent.click(screen.getByRole("tab", { name: /Livestreams/ }));
    selectCheckbox("Stream A");

    fireEvent.click(screen.getByRole("button", { name: "Chat about selection" }));

    const panel = chatPanel();
    expect(panel.hasAttribute("inert")).toBe(false);
    within(panel).getByText("3 videos from Sample Creator");
    // Captions for the selection start downloading in the background.
    const prepareCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/ai/prepare");
    expect(JSON.parse(String(prepareCall?.[1]?.body))).toEqual({
      videoIds: ["vidA000001", "vidB000001", "strA000001"],
    });
  });

  it("closes the chat when the selection empties out", () => {
    renderFeed();
    fireEvent.click(screen.getByRole("button", { name: "Select videos" }));
    const videoA = selectCheckbox("Video A");
    fireEvent.click(screen.getByRole("button", { name: "Chat about selection" }));
    expect(chatPanel().hasAttribute("inert")).toBe(false);

    fireEvent.click(videoA);

    expect(chatPanel().hasAttribute("inert")).toBe(true);
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("clear empties the selection and hides the bar", () => {
    renderFeed();
    fireEvent.click(screen.getByRole("button", { name: "Select videos" }));
    const videoA = selectCheckbox("Video A");
    const videoC = selectCheckbox("Video C");
    expect(screen.getByText("2 videos selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(videoA.checked).toBe(false);
    expect(videoC.checked).toBe(false);
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("exiting selection mode clears the selection", () => {
    renderFeed();
    fireEvent.click(screen.getByRole("button", { name: "Select videos" }));
    selectCheckbox("Video A");
    expect(screen.getByText("1 video selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("refuses selections beyond the analysis cap with a clear note (stage 7)", () => {
    const many = Array.from({ length: 26 }, (_, index) =>
      card({ videoId: `capvid${String(index).padStart(5, "0")}`, title: `Cap video ${index}` }),
    );
    render(<SelectableFeed videos={many} livestreams={[]} hasEverRefreshed={true} />);

    fireEvent.click(screen.getByRole("button", { name: "Select videos" }));
    for (const video of many.slice(0, 25)) {
      selectCheckbox(video.title);
    }
    expect(screen.getByText("25 videos selected")).toBeTruthy();

    // The 26th tick is refused with a readable note, and nothing breaks.
    selectCheckbox("Cap video 25");
    expect(screen.getByText(/Analyses are capped at 25 sources/)).toBeTruthy();
    expect(screen.getByText("25 videos selected")).toBeTruthy();

    // Deselecting still works and clears the note.
    selectCheckbox("Cap video 24");
    expect(screen.queryByText(/Analyses are capped at 25 sources/)).toBeNull();
    expect(screen.getByText("24 videos selected")).toBeTruthy();
  });
});
