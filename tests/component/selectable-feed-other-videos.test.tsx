// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatSource } from "@/components/ai/citation";
import { SelectableFeed } from "@/components/channel/selectable-feed";
import type { VideoCardModel } from "@/components/channel/video-card";

/**
 * A person's Other videos reuse the selectable feed: one list of appearances
 * on other channels, each card naming its host, sources that keep every
 * card's own platform, and a Remove action behind a confirmation.
 */

const chatPanel = vi.hoisted(() => ({
  props: [] as Array<{ scope: string[]; sources: ChatSource[]; open: boolean }>,
}));

vi.mock("@/components/ai/chat-panel", () => ({
  ChatPanel: (props: { scope: string[]; sources: ChatSource[]; open: boolean }) => {
    chatPanel.props.push(props);
    return null;
  },
}));

function card(
  overrides: Partial<VideoCardModel> & { videoId: string; title: string },
): VideoCardModel {
  return {
    detailHref: `/channels/9/videos/${overrides.videoId}`,
    thumbnailUrl: null,
    publishedLabel: "Aug 1, 2026",
    durationLabel: "10:00",
    liveStatus: "not_live",
    ...overrides,
  };
}

const YOUTUBE_GUEST = card({
  videoId: "ytGuest0001",
  title: "Luke on the podcast",
  subtitle: "on PBD Podcast",
  hostName: "PBD Podcast",
  platform: "youtube",
});
const RUMBLE_GUEST = card({
  videoId: "rbGuest0001",
  title: "Luke on Rumble",
  subtitle: "on Tim Pool",
  hostName: "Tim Pool",
  platform: "rumble",
});
const PLAIN = card({ videoId: "plain000001", title: "No platform on this card" });

function renderFeed(props: Partial<React.ComponentProps<typeof SelectableFeed>> = {}) {
  return render(
    <SelectableFeed
      videos={[YOUTUBE_GUEST, RUMBLE_GUEST, PLAIN]}
      livestreams={[]}
      hasEverRefreshed
      creatorName="Luke Belmar"
      platform="youtube"
      singleList
      {...props}
    />,
  );
}

function select(...titles: string[]) {
  fireEvent.click(screen.getByRole("button", { name: "Select videos" }));
  for (const title of titles) {
    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${title}` }));
  }
}

beforeEach(() => {
  chatPanel.props.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("SelectableFeed for Other videos", () => {
  it("shows one plain list with each card's host, and no Videos / Livestreams switcher", () => {
    renderFeed();

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab", { name: /Livestreams/ })).toBeNull();
    expect(screen.getByText("3 videos")).toBeTruthy();
    expect(screen.getByText("on PBD Podcast")).toBeTruthy();
    expect(screen.getByText("on Tim Pool")).toBeTruthy();
    // Cards still open their own video page, on the real host.
    expect(screen.getByRole("link", { name: /Luke on the podcast/ }).getAttribute("href")).toBe(
      "/channels/9/videos/ytGuest0001",
    );
  });

  it("keeps the Videos / Livestreams switcher for an ordinary channel feed", () => {
    renderFeed({ singleList: false });
    expect(screen.getByRole("tab", { name: /Livestreams/ })).toBeTruthy();
  });

  it("filters by the video's host platform and clears selections when switching", () => {
    renderFeed({ videos: [YOUTUBE_GUEST, RUMBLE_GUEST], showPlatformFilter: true });
    select("Luke on the podcast");

    fireEvent.click(screen.getByRole("button", { name: "Filter by platform: All platforms" }));
    expect(screen.queryByRole("menuitemradio", { name: /^X / })).toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Rumble/ }));

    expect(screen.getByText("1 video")).toBeTruthy();
    expect(screen.queryByText("Luke on the podcast")).toBeNull();
    expect(screen.getByRole("link", { name: /Luke on Rumble/ })).toBeTruthy();
    expect(screen.queryByText(/video selected/)).toBeNull();
    expect(screen.getByRole("button", { name: "Select videos" })).toBeTruthy();

    select("Luke on Rumble");
    fireEvent.click(screen.getByRole("button", { name: "Chat about selection" }));
    expect(chatPanel.props.at(-1)!.scope).toEqual(["rbGuest0001"]);
  });

  it("offers a way back when a platform has no videos", () => {
    renderFeed({ videos: [YOUTUBE_GUEST], showPlatformFilter: true });
    fireEvent.click(screen.getByRole("button", { name: "Filter by platform: All platforms" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Rumble/ }));

    expect(screen.getByText("0 videos")).toBeTruthy();
    expect(screen.getByText("No videos from Rumble")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select videos" })).toBeNull();
    expect(screen.queryByText(/last successful refresh/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show all platforms" }));
    expect(screen.getByRole("link", { name: /Luke on the podcast/ })).toBeTruthy();
    expect(screen.getByText("1 video")).toBeTruthy();
  });

  it("gives the chat each card's own platform, falling back to the feed's", () => {
    renderFeed();
    select("Luke on the podcast", "Luke on Rumble", "No platform on this card");
    fireEvent.click(screen.getByRole("button", { name: "Chat about selection" }));

    const latest = chatPanel.props.at(-1)!;
    expect(latest.open).toBe(true);
    expect(latest.scope).toEqual(["ytGuest0001", "rbGuest0001", "plain000001"]);
    expect(latest.sources.map((source) => [source.id, source.platform])).toEqual([
      ["ytGuest0001", "youtube"],
      ["rbGuest0001", "rumble"],
      ["plain000001", "youtube"],
    ]);
    expect(latest.sources.every((source) => source.creator === "Luke Belmar")).toBe(true);
  });

  it("cites each appearance 'on' the channel that hosts it", () => {
    renderFeed();
    select("Luke on the podcast", "Luke on Rumble", "No platform on this card");
    fireEvent.click(screen.getByRole("button", { name: "Chat about selection" }));

    const sources = chatPanel.props.at(-1)!.sources;
    expect(sources.map((source) => [source.id, source.channelName])).toEqual([
      ["ytGuest0001", "PBD Podcast"],
      ["rbGuest0001", "Tim Pool"],
      // A card without a host stays a plain creator citation.
      ["plain000001", undefined],
    ]);
    expect(sources[2]).not.toHaveProperty("channelName");
  });
});

describe("SelectableFeed remove", () => {
  it("offers Remove only when the feed can remove, and only with a selection", () => {
    const { unmount } = renderFeed();
    select("Luke on Rumble");
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    unmount();

    renderFeed({ onRemove: vi.fn() });
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    select("Luke on Rumble");
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("asks first, and cancelling removes nothing", () => {
    const onRemove = vi.fn(async () => undefined);
    renderFeed({ onRemove });
    select("Luke on the podcast", "Luke on Rumble");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Remove 2 videos from Other videos?")).toBeTruthy();
    expect(
      within(dialog).getByText("Their transcripts are deleted if nothing else uses them."),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByText("2 videos selected")).toBeTruthy();
  });

  it("removes the selection in feed order and clears it", async () => {
    const onRemove = vi.fn(async () => undefined);
    renderFeed({ onRemove });
    // Ticked out of order on purpose.
    select("Luke on Rumble", "Luke on the podcast");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1));
    expect(onRemove).toHaveBeenCalledWith(["ytGuest0001", "rbGuest0001"]);
    await waitFor(() => expect(screen.queryByText(/selected/)).toBeNull());
  });

  it("shows the failure in the dialog and keeps the selection", async () => {
    const onRemove = vi.fn(async () => {
      throw new Error("The videos could not be removed. Please try again.");
    });
    renderFeed({ onRemove });
    select("Luke on Rumble");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));

    await screen.findByText("The videos could not be removed. Please try again.");
    expect(screen.getByText("1 video selected")).toBeTruthy();
    expect(
      (
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Remove",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});
