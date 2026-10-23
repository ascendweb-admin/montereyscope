// @vitest-environment happy-dom
/**
 * A guest appearance in the feed reads as the featured person "on" the
 * channel that hosts it. Every link must work: the byline goes to the
 * person's Other videos (the host may be hidden), the video and its
 * transcript go to the real host.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BackgroundChatProvider } from "@/components/ai/background-chat";
import { FeedStream, type FeedVideoItemModel } from "@/components/feed/feed-stream";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(cleanup);

const APPEARANCE: FeedVideoItemModel = {
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
  featured: true,
};

const OWN: FeedVideoItemModel = {
  ...APPEARANCE,
  id: "ownVideo0001",
  creatorId: 1,
  profileId: 1,
  creatorName: "Dana Writer",
  accountLabel: "YouTube",
  title: "Dana's upload",
  featured: undefined,
};

function renderFeed(byline: "creator" | "account") {
  return render(<FeedStream items={[APPEARANCE, OWN]} byline={byline} />, {
    wrapper: BackgroundChatProvider,
  });
}

function hrefs(name: string | RegExp): string[] {
  return screen.getAllByRole("link", { name }).map((link) => link.getAttribute("href") ?? "");
}

describe("FeedStream appearances", () => {
  it("labels the shared feed with the person, 'on' the host, linking to their Other videos", () => {
    renderFeed("creator");

    expect(hrefs("Luke Belmar")).toEqual(["/creators/5?view=other"]);
    expect(screen.getByText("on PBD Podcast")).toBeTruthy();
    // A channel's own video still links to the account tab.
    expect(hrefs("Dana Writer")).toEqual(["/creators/1?account=1"]);
  });

  it("labels a person's Overview with 'on {host}', linking to the same place", () => {
    renderFeed("account");

    // The platform mark is named too ("YouTube on PBD Podcast"), as it is for any account.
    expect(hrefs(/on PBD Podcast$/)).toEqual(["/creators/5?view=other"]);
    expect(hrefs(/^YouTube$/)).toEqual(["/creators/1?account=1"]);
  });

  it("opens the video on its real host, which may be hidden", () => {
    renderFeed("creator");

    expect(
      hrefs("Luke on the podcast").every((href) => href === "/channels/99/videos/guestVid0001"),
    ).toBe(true);
  });
});
