// @vitest-environment happy-dom
/**
 * A hand-picked video's page offers its source-only channel to follow and the
 * video to remove from the person who features it. A followed channel's page
 * shows neither.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { followCreatorAction } from "@/app/actions/creators";
import { removeVideosAction } from "@/app/actions/videos";
import { refreshCreatorContentAction } from "@/components/background/operations";
import { HostedVideoActions } from "@/components/video/hosted-video-actions";

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/actions/creators", () => ({ followCreatorAction: vi.fn() }));
vi.mock("@/app/actions/videos", () => ({ removeVideosAction: vi.fn() }));
vi.mock("@/components/background/operations", () => ({ refreshCreatorContentAction: vi.fn() }));

const follow = vi.mocked(followCreatorAction);
const remove = vi.mocked(removeVideosAction);
const refreshFeed = vi.mocked(refreshCreatorContentAction);

const HOST = { id: 90, displayName: "PBD Podcast", followed: false };
const PERSON = { id: 3, displayName: "Luke Belmar", otherVideoCount: 4 };

function renderActions(props: Partial<React.ComponentProps<typeof HostedVideoActions>> = {}) {
  return render(
    <HostedVideoActions videoId="guestVid0001" host={HOST} person={PERSON} {...props} />,
  );
}

function followed(profileId = 91) {
  return {
    ok: true as const,
    creator: {
      id: 90,
      displayName: "PBD Podcast",
      handle: "pbdpodcast",
      channelUrl: "https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A",
      avatarUrl: null,
      youtubeChannelId: "UC4QobU6STFB0P71PMvOGN5A",
      platformUserId: null,
      platform: "youtube" as const,
      profileId,
      categories: [],
    },
  };
}

beforeEach(() => {
  follow.mockReset();
  remove.mockReset();
  refreshFeed.mockReset();
  router.refresh.mockReset();
  router.replace.mockReset();
});
afterEach(cleanup);

describe("HostedVideoActions", () => {
  it("offers Follow and Remove for a source-only channel", () => {
    renderActions();
    expect(screen.getByRole("button", { name: "Follow PBD Podcast" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove from Luke Belmar" })).toBeTruthy();
  });

  it("shows neither for a followed channel", () => {
    renderActions({ host: { ...HOST, followed: true } });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("has nothing to remove from when no person features the video", () => {
    renderActions({ person: null });
    expect(screen.getByRole("button", { name: "Follow PBD Podcast" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Remove from/ })).toBeNull();
  });
});

describe("Follow", () => {
  it("follows the channel, starts its feed refresh, and links the toast to its page", async () => {
    follow.mockResolvedValue(followed(91));
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Follow PBD Podcast" }));

    await screen.findByText("Following PBD Podcast. Its feed is updating in the background.");
    expect(follow).toHaveBeenCalledWith(90);
    expect(refreshFeed).toHaveBeenCalledWith(90);
    expect(screen.getByRole("link", { name: "View" }).getAttribute("href")).toBe("/creators/91");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the toast when the page re-renders with the channel followed", async () => {
    follow.mockResolvedValue(followed());
    const { rerender } = renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Follow PBD Podcast" }));
    await screen.findByText(/Following PBD Podcast/);

    rerender(
      <HostedVideoActions
        videoId="guestVid0001"
        host={{ ...HOST, followed: true }}
        person={PERSON}
      />,
    );
    // The buttons are gone, the confirmation is not.
    expect(screen.queryByRole("button", { name: "Follow PBD Podcast" })).toBeNull();
    expect(screen.getByText(/Following PBD Podcast/)).toBeTruthy();
  });

  it("disables the button while it follows, so a second press does nothing", async () => {
    let finish: (value: ReturnType<typeof followed>) => void = () => undefined;
    follow.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Follow PBD Podcast" }));
    const pending = screen.getByRole("button", { name: "Following…" }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    fireEvent.click(pending);
    expect(follow).toHaveBeenCalledTimes(1);

    await act(async () => finish(followed()));
  });

  it("says why when it cannot follow, and starts no refresh", async () => {
    follow.mockResolvedValue({ ok: false, message: "PBD Podcast is already in your library." });
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Follow PBD Podcast" }));

    await screen.findByText("PBD Podcast is already in your library.");
    expect(refreshFeed).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Follow PBD Podcast" })).toBeTruthy();
  });
});

describe("Remove", () => {
  function openConfirm() {
    fireEvent.click(screen.getByRole("button", { name: "Remove from Luke Belmar" }));
    return screen.getByRole("dialog", {
      name: /Remove this video from Luke Belmar's Other videos/,
    });
  }

  it("asks first, and cancelling removes nothing", () => {
    renderActions();
    const dialog = openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(remove).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("removes the video and lands on the person's Other videos with a confirmation", async () => {
    remove.mockResolvedValue({ ok: true, removed: 1, deletedVideos: 1, deletedHosts: 1 });
    renderActions();
    fireEvent.click(within(openConfirm()).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    expect(remove).toHaveBeenCalledWith(3, ["guestVid0001"]);
    const target = new URL(router.replace.mock.calls[0][0], "http://scope.test");
    expect(target.pathname).toBe("/creators/3");
    expect(target.searchParams.get("view")).toBe("other");
    expect(target.searchParams.get("notice")).toBe(
      "Removed the video from Luke Belmar's Other videos.",
    );
  });

  it("goes to the person's page itself when it was their last Other video", async () => {
    remove.mockResolvedValue({ ok: true, removed: 1, deletedVideos: 1, deletedHosts: 1 });
    renderActions({ person: { ...PERSON, otherVideoCount: 1 } });
    fireEvent.click(within(openConfirm()).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    const target = new URL(router.replace.mock.calls[0][0], "http://scope.test");
    expect(target.pathname).toBe("/creators/3");
    // The tab disappears with its last video, so there is no view to ask for.
    expect(target.searchParams.has("view")).toBe(false);
    expect(target.searchParams.get("notice")).toContain("Removed the video");
  });

  it("says so when the video was already gone", async () => {
    remove.mockResolvedValue({ ok: true, removed: 0, deletedVideos: 0, deletedHosts: 0 });
    renderActions();
    fireEvent.click(within(openConfirm()).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    expect(
      new URL(router.replace.mock.calls[0][0], "http://scope.test").searchParams.get("notice"),
    ).toBe("That video was already removed.");
  });

  it("keeps the dialog open with the reason when removing fails", async () => {
    remove.mockResolvedValue({ ok: false, message: "That person is no longer in your library." });
    renderActions();
    const dialog = openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await within(dialog).findByText("That person is no longer in your library.");
    expect(router.replace).not.toHaveBeenCalled();
    expect(
      (within(dialog).getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
