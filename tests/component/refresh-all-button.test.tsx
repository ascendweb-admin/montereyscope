// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RefreshContentOutcome } from "@/app/actions/feeds";
import { refreshCreators, REFRESH_ALL_TASK } from "@/components/background/creator-refresh";
import { refreshCreatorContentAction } from "@/components/background/operations";
import { dismissTask, getTasks } from "@/components/background/task-store";
import { RefreshAllButton } from "@/components/library/refresh-all-button";

vi.mock("@/components/background/operations", () => ({ refreshCreatorContentAction: vi.fn() }));

const refreshAction = vi.mocked(refreshCreatorContentAction);

const creators = [
  { id: 1, displayName: "Alpha", platform: "youtube" as const },
  { id: 2, displayName: "Beta", platform: "youtube" as const },
];

function success(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    status: "refreshed" as const,
    refreshedAt: "2026-09-11T00:00:00.000Z",
    addedVideos: 3,
    addedLivestreams: 1,
    addedTweets: 0,
    ...overrides,
  };
}

// The mock is module-scoped, so its recorded calls must not leak across tests.
beforeEach(() => {
  for (const task of getTasks()) dismissTask(task.key);
  refreshAction.mockReset();
});

afterEach(cleanup);

describe("RefreshAllButton", () => {
  it("refreshes every creator, shows progress, and reports totals", async () => {
    let resolveFirst: ((value: RefreshContentOutcome) => void) | undefined;
    refreshAction
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(success({ addedVideos: 2, addedLivestreams: 0 }));

    render(<RefreshAllButton creators={creators} />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh all" }));

    // First creator is in flight: progress shows in the button and further
    // clicks are locked out.
    expect(screen.getByRole("button", { name: "Refreshing 1 of 2…" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Refreshing 1 of 2…" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    resolveFirst?.(success());
    await waitFor(() =>
      expect(screen.getByText("Updated 2 creators: 5 videos · 1 livestream.")).toBeTruthy(),
    );
    expect(refreshAction).toHaveBeenCalledTimes(2);
    expect(refreshAction).toHaveBeenNthCalledWith(1, 1);
    expect(refreshAction).toHaveBeenNthCalledWith(2, 2);
    expect(screen.getByRole("button", { name: "Refresh all" }).getAttribute("aria-busy")).toBe(
      "false",
    );
  });

  it("continues the remaining creators after the initiating page unmounts", async () => {
    let finishFirst!: (result: RefreshContentOutcome) => void;
    refreshAction
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(success());
    const view = render(<RefreshAllButton creators={creators} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh all" }));
    view.unmount();
    finishFirst(success());
    await waitFor(() => expect(refreshAction).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(getTasks().find((task) => task.key === "refresh-all")?.status).toBe("done"),
    );
  });

  it("collects per-creator failures into one note and retries only those", async () => {
    refreshAction
      .mockResolvedValueOnce({
        ok: false,
        errorCode: "network",
        message: "scope could not reach the network.",
      })
      .mockResolvedValueOnce(success())
      // Retry run: only the failed creator is retried and now succeeds.
      .mockResolvedValueOnce(success({ addedVideos: 1, addedLivestreams: 0 }));

    render(<RefreshAllButton creators={creators} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh all" }));

    const note = await screen.findByText(/Could not update Alpha/);
    expect(note.textContent).toContain("scope could not reach the network.");
    expect(screen.getByText("Refreshed 1 of 2 creators.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Updated 1 creator: 1 video.")).toBeTruthy());
    expect(refreshAction).toHaveBeenCalledTimes(3);
    expect(refreshAction).toHaveBeenLastCalledWith(1);
  });

  it("shows a run started elsewhere, such as a source picker, and joins it", async () => {
    let finishFirst!: (result: RefreshContentOutcome) => void;
    refreshAction
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(success());
    const run = refreshCreators(REFRESH_ALL_TASK, creators);

    render(<RefreshAllButton creators={creators} />);
    const button = screen.getByRole("button", { name: "Refreshing 1 of 2…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    finishFirst(success());
    await run;
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh all" })).toBeTruthy());
    expect(refreshAction).toHaveBeenCalledTimes(2);
  });

  it("points at setup guidance when every refresh fails from missing yt-dlp", async () => {
    refreshAction.mockResolvedValue({
      ok: false,
      errorCode: "ytdlp_missing",
      message: "yt-dlp is not installed.",
    });

    render(<RefreshAllButton creators={creators} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh all" }));

    await waitFor(() => expect(screen.getByText("Local tool missing.")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("RefreshAllButton — per platform", () => {
  const mixed = [
    { id: 1, displayName: "Alpha", platform: "youtube" as const, updatedAt: null },
    { id: 2, displayName: "Beta", platform: "youtube" as const, updatedAt: null },
    {
      id: 3,
      displayName: "Gamma",
      platform: "rumble" as const,
      updatedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    },
  ];

  it("refreshes one platform from the menu, saying how stale each one is", async () => {
    refreshAction.mockResolvedValue(success());
    render(<RefreshAllButton creators={mixed} platformMenu peopleCount={3} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose what to refresh" }));
    expect(screen.getByRole("menuitem", { name: /^All platforms/ }).textContent).toContain(
      "3 creators · some never updated",
    );
    const rumble = screen.getByRole("menuitem", { name: /^Rumble/ });
    expect(rumble.textContent).toContain("1 account · updated 5d ago");

    fireEvent.click(rumble);
    await waitFor(() => expect(screen.getByText(/^Updated 1 creator/)).toBeTruthy());
    expect(refreshAction).toHaveBeenCalledTimes(1);
    expect(refreshAction).toHaveBeenCalledWith(3);
  });

  it("follows the platform in view", async () => {
    refreshAction.mockResolvedValue(success());
    render(<RefreshAllButton creators={mixed} platformMenu scope="rumble" />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh Rumble" }));
    await waitFor(() => expect(refreshAction).toHaveBeenCalledWith(3));
    expect(refreshAction).toHaveBeenCalledTimes(1);
  });

  it("shows the progress of a platform picked from the menu, whatever it follows", async () => {
    let finish!: (outcome: RefreshContentOutcome) => void;
    refreshAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<RefreshAllButton creators={mixed} platformMenu scope="youtube" />);
    fireEvent.click(screen.getByRole("button", { name: "Choose what to refresh" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Rumble/ }));
    await waitFor(() => expect(refreshAction).toHaveBeenCalledWith(3));
    const button = screen.getByRole("button", { name: "Refreshing 1 of 1…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    finish(success());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh YouTube" })).toBeTruthy(),
    );
  });

  it("adds a platform to a run that is going, and reports the run once", async () => {
    const pending: Array<(outcome: RefreshContentOutcome) => void> = [];
    refreshAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    render(<RefreshAllButton creators={mixed} platformMenu scope="youtube" />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh YouTube" }));
    await waitFor(() => expect(refreshAction).toHaveBeenCalledTimes(2));
    // YouTube is going: its button is busy, but Rumble can still join.
    expect(
      (screen.getByRole("button", { name: /^Refreshing/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Choose what to refresh" }));
    expect((screen.getByRole("menuitem", { name: /^YouTube/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /^Rumble/ }));
    // Rumble shares the video lane's two slots: it starts as soon as one frees.
    expect(refreshAction).toHaveBeenCalledTimes(2);
    pending.shift()?.(success({ addedVideos: 1, addedLivestreams: 0 }));
    await waitFor(() => expect(refreshAction).toHaveBeenLastCalledWith(3));

    for (const resolve of pending.splice(0)) {
      resolve(success({ addedVideos: 1, addedLivestreams: 0 }));
    }
    // One run, one report, after both platforms.
    expect(await screen.findByText("Updated 3 creators: 3 videos.")).toBeTruthy();
  });
});
