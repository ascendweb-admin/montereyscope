// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FEED_PAGE_SIZE, FeedTabs } from "@/components/channel/feed-tabs";
import type { VideoCardModel } from "@/components/channel/video-card";

/**
 * Feed pagination: long feeds reveal in place via "Load more" (FEED_PAGE_SIZE
 * cards first), while short feeds render whole with no control at all.
 */

function card(videoId: string, title: string): VideoCardModel {
  return {
    videoId,
    title,
    detailHref: `/channels/1/videos/${videoId}`,
    thumbnailUrl: null,
    publishedLabel: "Aug 1, 2026",
    durationLabel: "10:00",
    liveStatus: "not_live",
    hasTranscript: false,
  };
}

function makeCards(count: number): VideoCardModel[] {
  return Array.from({ length: count }, (_, index) =>
    card(`vid${String(index).padStart(7, "0")}`, `Video ${index + 1}`),
  );
}

function feedCards(): ReturnType<typeof screen.getAllByRole> {
  return screen.getAllByRole("link", { name: /Video \d+/ });
}

afterEach(cleanup);

describe("FeedTabs pagination", () => {
  it("renders a whole short feed without any Load more control", () => {
    render(
      <FeedTabs videos={makeCards(FEED_PAGE_SIZE)} livestreams={[]} hasEverRefreshed={true} />,
    );

    expect(feedCards()).toHaveLength(FEED_PAGE_SIZE);
    expect(screen.queryByRole("button", { name: /Load more/i })).toBeNull();
  });

  it("reveals older items in place via Load more", () => {
    render(
      <FeedTabs videos={makeCards(FEED_PAGE_SIZE + 5)} livestreams={[]} hasEverRefreshed={true} />,
    );

    expect(feedCards()).toHaveLength(FEED_PAGE_SIZE);
    expect(screen.getByText(/Showing 60 of 65 videos/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Load more/i }));

    expect(feedCards()).toHaveLength(FEED_PAGE_SIZE + 5);
    expect(screen.queryByRole("button", { name: /Load more/i })).toBeNull();
  });

  it("resets to the first page after switching tabs", () => {
    render(
      <FeedTabs
        videos={makeCards(FEED_PAGE_SIZE + 1)}
        livestreams={makeCards(2)}
        hasEverRefreshed={true}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Load more/i }));
    expect(feedCards()).toHaveLength(FEED_PAGE_SIZE + 1);

    fireEvent.click(screen.getByRole("tab", { name: /Livestreams/i }));
    expect(feedCards()).toHaveLength(2);

    fireEvent.click(screen.getByRole("tab", { name: /Videos/i }));
    expect(feedCards()).toHaveLength(FEED_PAGE_SIZE);
    expect(screen.getByRole("button", { name: /Load more/i })).toBeTruthy();
  });
});
