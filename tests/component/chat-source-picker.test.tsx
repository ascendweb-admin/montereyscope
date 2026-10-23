// @vitest-environment happy-dom
/**
 * The source picker measures a selection by what it holds — hours of video
 * and posts — says how an answer will read it, and refuses a tick past the
 * analysis limits with a note that names the limit.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatSourcePicker,
  type PickerCreator,
  type PickerTweet,
  type PickerVideo,
} from "@/components/ai/chat-source-picker";

afterEach(cleanup);

const CREATORS: PickerCreator[] = [
  { id: 1, profileId: 1, displayName: "Stream Host", avatarUrl: null, platform: "youtube" },
  { id: 2, profileId: 2, displayName: "Post Writer", avatarUrl: null, platform: "x" },
];

function stream(index: number, hours: number): PickerVideo {
  return {
    id: `stream${String(index).padStart(5, "0")}`,
    creatorId: 1,
    title: `Stream ${index}`,
    creatorName: "Stream Host",
    categoryIds: [],
    durationSeconds: hours * 3_600,
    publishedAt: `2026-10-${String(10 + index).padStart(2, "0")}T00:00:00.000Z`,
    liveStatus: "was_live",
  };
}

const POSTS: PickerTweet[] = [1, 2].map((index) => ({
  id: `9000000000000000${index}`,
  creatorId: 2,
  authorHandle: "writer",
  authorName: "Post Writer",
  text: `Post ${index} about markets`,
  categoryIds: [],
  readyForAnalysis: true,
  publishedAt: "2026-10-18T00:00:00.000Z",
}));

function renderPicker(videos: PickerVideo[]) {
  const onConfirm = vi.fn();
  render(
    <ChatSourcePicker
      open
      onClose={() => {}}
      videos={videos}
      tweets={POSTS}
      creators={CREATORS}
      categories={[]}
      selected={new Set()}
      onConfirm={onConfirm}
    />,
  );
  const picker = screen.getByRole("dialog", { name: "Choose sources" });
  const tick = (title: string) =>
    fireEvent.click(within(picker).getByRole("checkbox", { name: `Select ${title}` }));
  return { picker, tick, onConfirm };
}

describe("ChatSourcePicker — selection size", () => {
  it("shows what the selection holds and how an answer will read it", () => {
    const { picker, tick } = renderPicker([stream(1, 3), stream(2, 3), stream(3, 3)]);

    tick("Stream 1");
    tick("Post 1 about markets");
    const meter = within(picker).getByRole("meter", { name: "Selection size" });
    expect(meter.getAttribute("aria-valuetext")).toBe("1 video · 3 h · 1 post — Read in full");

    tick("Stream 2");
    expect(within(picker).getByText("Full transcripts in Deep")).toBeTruthy();
    expect(
      within(picker).getByText("Quick and Balanced use summaries for longer videos."),
    ).toBeTruthy();

    tick("Stream 3");
    expect(meter.getAttribute("aria-valuetext")).toBe(
      "3 videos · 9 h · 1 post — Full transcripts in Deep",
    );
  });

  it("names the long-video zone past what Deep reads in one go", () => {
    const { picker, tick } = renderPicker([stream(1, 6), stream(2, 6)]);
    tick("Stream 1");
    tick("Stream 2");
    expect(within(picker).getByText("Long videos summarized first")).toBeTruthy();
  });

  it("refuses a video past the hours limit and offers only what fits", () => {
    const { picker, tick } = renderPicker([stream(1, 20), stream(2, 20), stream(3, 20)]);
    // Selecting the whole creator would cross 50 hours: newest two fit.
    expect(
      within(picker).getByRole("button", { name: "Select newest 2 from Stream Host" }),
    ).toBeTruthy();

    tick("Stream 1");
    tick("Stream 2");
    tick("Stream 3");
    expect(within(picker).getByText(/Analyses take up to 50 hours of video at once/)).toBeTruthy();
    expect(within(picker).getByText(/2 sources selected/)).toBeTruthy();
    // Posts still fit next to the full video budget.
    tick("Post 1 about markets");
    expect(within(picker).getByText(/3 sources selected/)).toBeTruthy();
  });
});
