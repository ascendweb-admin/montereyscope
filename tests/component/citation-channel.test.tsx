// @vitest-environment happy-dom
/**
 * A video someone appears in on another person's channel is cited as
 * "{person} on {channel}": the preview card names the channel, while a
 * channel's own video (or an older saved thread) reads exactly as before.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackgroundChatProvider } from "@/components/ai/background-chat";
import { SourceCitation, type ChatSource } from "@/components/ai/citation";
import { FeedStream, type FeedVideoItemModel } from "@/components/feed/feed-stream";

const chatPanel = vi.hoisted(() => ({
  props: [] as Array<{ scope: string[]; sources: ChatSource[]; open: boolean }>,
}));

vi.mock("@/components/ai/chat-panel", () => ({
  ChatPanel: (props: { scope: string[]; sources: ChatSource[]; open: boolean }) => {
    chatPanel.props.push(props);
    return null;
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

beforeEach(() => {
  chatPanel.props.length = 0;
});
afterEach(cleanup);

const APPEARANCE: ChatSource = {
  id: "guestVid0001",
  platform: "youtube",
  title: "The big interview",
  creator: "Luke Belmar",
  channelName: "PBD Podcast",
};

/** Focusing the pill opens its preview card straight away. */
function openCard(source: ChatSource) {
  render(<SourceCitation source={source} />);
  const pill = screen.getByLabelText(new RegExp(source.title));
  act(() => {
    fireEvent.focus(pill);
  });
  return pill;
}

describe("citation preview card", () => {
  it("names the channel that hosts an appearance", () => {
    const pill = openCard(APPEARANCE);
    expect(pill.getAttribute("aria-label")).toBe(
      "YouTube video transcript — The big interview by Luke Belmar on PBD Podcast",
    );
    // The pill itself stays short: the person, as always.
    expect(pill.textContent).toContain("Luke Belmar");
    // The card's byline reads "Luke Belmar on PBD Podcast".
    expect(screen.getByText("on PBD Podcast")).toBeTruthy();
    expect(screen.getByText("on PBD Podcast").parentElement?.textContent).toBe(
      "Luke Belmar on PBD Podcast",
    );
  });

  it("reads exactly as before for a channel's own video", () => {
    const pill = openCard({ ...APPEARANCE, channelName: undefined });
    expect(pill.getAttribute("aria-label")).toBe(
      "YouTube video transcript — The big interview by Luke Belmar",
    );
    expect(screen.queryByText(/ on /)).toBeNull();
  });

  it("does not say 'on' when the channel is the creator itself", () => {
    const pill = openCard({ ...APPEARANCE, channelName: "Luke Belmar" });
    expect(pill.getAttribute("aria-label")).not.toContain(" on ");
    expect(screen.queryByText(/^on /)).toBeNull();
  });

  it("ignores a channel when there is no creator to put it beside", () => {
    openCard({ id: "v", title: "Untitled", channelName: "PBD Podcast" });
    expect(screen.queryByText(/on PBD Podcast/)).toBeNull();
  });
});

describe("FeedStream chat sources", () => {
  const item = (overrides: Partial<FeedVideoItemModel>): FeedVideoItemModel => ({
    kind: "video",
    id: "guestVid0001",
    creatorId: 99,
    profileId: 5,
    creatorName: "Luke Belmar",
    accountLabel: "on PBD Podcast",
    creatorAvatarUrl: null,
    creatorAvatarCreatorId: null,
    creatorPlatform: "youtube",
    title: "Luke on the podcast",
    url: "https://www.youtube.com/watch?v=guestVid0001",
    thumbnailUrl: null,
    publishedAt: "2026-10-02T00:00:00.000Z",
    durationSeconds: 3600,
    liveStatus: "not_live",
    description: null,
    hasTranscript: false,
    categoryIds: [],
    ...overrides,
  });

  function askAbout(model: FeedVideoItemModel) {
    render(<FeedStream items={[model]} byline="creator" />, { wrapper: BackgroundChatProvider });
    fireEvent.click(screen.getAllByRole("button", { name: /Ask AI/ })[0]);
    return chatPanel.props.at(-1)!;
  }

  it("cites an appearance as the person on the host channel", () => {
    const panel = askAbout(item({ featured: true, hostName: "PBD Podcast" }));
    expect(panel.sources).toHaveLength(1);
    expect(panel.sources[0]).toMatchObject({
      id: "guestVid0001",
      creator: "Luke Belmar",
      channelName: "PBD Podcast",
    });
  });

  it("leaves a channel's own video without a channel name", () => {
    const panel = askAbout(item({ creatorName: "Dana Writer", accountLabel: "YouTube" }));
    expect(panel.sources[0].creator).toBe("Dana Writer");
    expect(panel.sources[0]).not.toHaveProperty("channelName");
  });
});
