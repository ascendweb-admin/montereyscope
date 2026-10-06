// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RefreshContentOutcome } from "@/app/actions/feeds";
import { refreshCreatorContentAction } from "@/components/background/operations";
import { dismissTask, getTasks } from "@/components/background/task-store";
import { RefreshAllButton } from "@/components/library/refresh-all-button";

vi.mock("@/components/background/operations", () => ({ refreshCreatorContentAction: vi.fn() }));

const refreshAction = vi.mocked(refreshCreatorContentAction);

const creators = [
  { id: 1, displayName: "Alpha" },
  { id: 2, displayName: "Beta" },
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
