// @vitest-environment happy-dom
/**
 * Creators can be refreshed from the source picker — everyone, one platform,
 * one person, or one of their accounts. YouTube and Rumble refresh beside X
 * rather than behind it: X goes to the X Dashboard's sync engine, which can
 * wait minutes on X's rate limit, and says until when. Sources that arrive
 * while the picker is open are marked New, and a host that fetched the
 * library is asked to read it again.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RefreshContentOutcome } from "@/app/actions/feeds";
import {
  ChatSourcePicker,
  type ChatSourcePickerProps,
  type PickerCreator,
  type PickerVideo,
} from "@/components/ai/chat-source-picker";
import { resetRefreshRuns } from "@/components/background/creator-refresh";
import { creatorTaskKey, refreshCreatorContentAction } from "@/components/background/operations";
import { dismissTask, getTasks, runBackgroundTask } from "@/components/background/task-store";
import { resetXSync } from "@/components/background/x-sync";
import type { SyncCreatorState } from "@/lib/x/dashboard/model";

vi.mock("@/components/background/operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/background/operations")>()),
  refreshCreatorContentAction: vi.fn(),
}));

const refreshAction = vi.mocked(refreshCreatorContentAction);

/** Each video account's refresh, held open until the test settles it. */
const pending = new Map<number, (outcome: RefreshContentOutcome) => void>();

const ok: RefreshContentOutcome = { ok: true, status: "refreshed", addedVideos: 1 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function xState(creatorId: number, change: Partial<SyncCreatorState> = {}): SyncCreatorState {
  return {
    creatorId,
    state: "idle",
    lastSyncedAt: null,
    retryAt: null,
    message: null,
    errorCode: null,
    newPosts: 0,
    firstSync: false,
    olderPosts: null,
    coveredSince: null,
    ...change,
  };
}

/** The X Dashboard's sync engine, as GET/POST /api/x-dashboard/sync answer for it. */
function fakeXEngine() {
  const states = new Map<number, SyncCreatorState>();
  const engine = {
    /** Set to refuse every start, the way an unconnected X does. */
    problem: null as string | null,
    starts: [] as number[][],
    stops: [] as number[][],
    set(creatorId: number, change: Partial<SyncCreatorState>) {
      states.set(creatorId, xState(creatorId, change));
    },
  };
  const snapshot = (ids: number[]) => ({
    creators: ids.map((id) => states.get(id) ?? xState(id)),
  });
  vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith("/api/x-dashboard/sync")) return json({});
    if (init?.method !== "POST") {
      const ids = (new URL(url, "http://localhost").searchParams.get("creators") ?? "")
        .split(",")
        .map(Number);
      return json({ sync: snapshot(ids) });
    }
    const body = JSON.parse(String(init.body)) as { action?: string; creatorIds: number[] };
    if (body.action === "stop") {
      engine.stops.push(body.creatorIds);
      for (const id of body.creatorIds) engine.set(id, { state: "idle" });
      return json({ sync: snapshot(body.creatorIds) });
    }
    engine.starts.push(body.creatorIds);
    if (engine.problem) {
      return json({
        started: false,
        reason: "disconnected",
        message: engine.problem,
        sync: snapshot(body.creatorIds),
      });
    }
    for (const id of body.creatorIds) engine.set(id, { state: "syncing" });
    return json({ started: true, sync: snapshot(body.creatorIds) }, 202);
  });
  return engine;
}

let x: ReturnType<typeof fakeXEngine>;

beforeEach(async () => {
  for (const [, settleRefresh] of pending) settleRefresh(ok);
  pending.clear();
  resetXSync({ pollMs: 10 });
  // Whatever an earlier test left going finishes before its tasks are cleared.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  for (const task of getTasks()) dismissTask(task.key);
  resetRefreshRuns();
  refreshAction.mockReset();
  // Like the real action: a per-account background task the picker reads.
  refreshAction.mockImplementation((creatorId) =>
    runBackgroundTask(
      { key: creatorTaskKey(creatorId), label: "Updating creator", href: "/" },
      () =>
        new Promise<RefreshContentOutcome>((resolve) => {
          pending.set(creatorId, resolve);
        }),
    ),
  );
  x = fakeXEngine();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function settle(creatorId: number, outcome: RefreshContentOutcome = ok): Promise<void> {
  await waitFor(() => expect(pending.has(creatorId)).toBe(true));
  await act(async () => {
    pending.get(creatorId)?.(outcome);
    pending.delete(creatorId);
  });
}

const TWO_HOURS_AGO = new Date(Date.now() - 2 * 3_600_000).toISOString();

const CREATORS: PickerCreator[] = [
  {
    id: 1,
    profileId: 1,
    displayName: "Alpha Host",
    avatarUrl: null,
    platform: "youtube",
    lastRefreshedAt: TWO_HOURS_AGO,
  },
  // One person on two platforms.
  {
    id: 2,
    profileId: 2,
    displayName: "Beta Writer",
    avatarUrl: null,
    platform: "youtube",
    lastRefreshedAt: TWO_HOURS_AGO,
  },
  {
    id: 3,
    profileId: 2,
    displayName: "Beta Writer",
    avatarUrl: null,
    platform: "x",
    lastRefreshedAt: null,
  },
  {
    id: 4,
    profileId: 4,
    displayName: "Gamma Poster",
    avatarUrl: null,
    platform: "x",
    lastRefreshedAt: TWO_HOURS_AGO,
  },
];

function video(id: string, creatorId: number, title: string): PickerVideo {
  return {
    id,
    creatorId,
    title,
    creatorName: creatorId === 1 ? "Alpha Host" : "Beta Writer",
    categoryIds: [],
    durationSeconds: 600,
    publishedAt: "2026-10-01T00:00:00.000Z",
    liveStatus: "not_live",
  };
}

const VIDEOS = [video("alphavid01", 1, "Alpha one"), video("betavid001", 2, "Beta one")];

const TWEETS = [
  {
    id: "900000000000000001",
    creatorId: 4,
    authorHandle: "gamma",
    authorName: "Gamma Poster",
    text: "Gamma says hello",
    categoryIds: [],
    readyForAnalysis: true,
    publishedAt: "2026-10-01T00:00:00.000Z",
  },
];

function props(overrides: Partial<ChatSourcePickerProps> = {}): ChatSourcePickerProps {
  return {
    open: true,
    onClose: () => {},
    videos: VIDEOS,
    tweets: TWEETS,
    creators: CREATORS,
    categories: [],
    selected: new Set(),
    onConfirm: () => {},
    ...overrides,
  };
}

function picker() {
  return screen.getByRole("dialog", { name: "Choose sources" });
}

function rail() {
  return within(picker()).getByRole("complementary");
}

function group(name: string) {
  return within(picker()).getByRole("region", { name });
}

/** One lane of the run banner: "YouTube" or "X". */
function lane(name: string) {
  return within(picker()).getByRole("listitem", { name });
}

describe("ChatSourcePicker — refreshing one creator", () => {
  it("refreshes from the group header and says when it last updated", async () => {
    render(<ChatSourcePicker {...props()} />);
    const header = group("Alpha Host");

    fireEvent.click(
      within(header).getByRole("button", { name: "Refresh Alpha Host (updated 2h ago)" }),
    );
    expect(refreshAction).toHaveBeenCalledWith(1);
    expect(within(header).getByRole("button", { name: "Updating Alpha Host" })).toBeTruthy();
    // The rail row shows the same refresh in flight.
    expect(within(rail()).getByText("Updating Alpha Host")).toBeTruthy();

    await settle(1);
    expect(
      within(header).getByRole("button", { name: "Refresh Alpha Host (updated 2h ago)" }),
    ).toBeTruthy();
  });

  it("refreshes a person's platforms side by side, and names the one that failed", async () => {
    render(<ChatSourcePicker {...props()} />);
    const header = group("Beta Writer");

    // One account never updated: the person reads as never updated.
    fireEvent.click(
      within(header).getByRole("button", { name: "Refresh Beta Writer (never updated)" }),
    );
    // YouTube and X start together; neither waits for the other.
    expect(refreshAction).toHaveBeenCalledWith(2);
    await waitFor(() => expect(x.starts).toEqual([[3]]));

    await settle(2);
    act(() => x.set(3, { state: "error", errorCode: "network", message: "Couldn't reach X." }));
    const retry = await within(header).findByRole("button", {
      name: "Retry updating Beta Writer (x didn’t update)",
    });
    expect(retry.textContent).toContain("X didn’t update · Retry");
    expect(retry.getAttribute("title")).toContain("Couldn't reach X.");
  });

  it("refreshes one platform of a person from the menu beside their refresh", async () => {
    render(<ChatSourcePicker {...props()} />);
    const header = group("Beta Writer");
    fireEvent.click(
      within(header).getByRole("button", { name: "Refresh one of Beta Writer's platforms" }),
    );
    const youtube = within(header).getByRole("menuitem", { name: /^YouTube/ });
    expect(youtube.textContent).toContain("Updated 2h ago");
    expect(within(header).getByRole("menuitem", { name: /^X/ }).textContent).toContain(
      "Never updated",
    );

    fireEvent.click(within(header).getByRole("menuitem", { name: /^X/ }));
    await waitFor(() => expect(x.starts).toEqual([[3]]));
    expect(refreshAction).not.toHaveBeenCalled();
  });

  it("keeps the refresh of one creator on that creator when X can't be read", async () => {
    x.problem = "Connect your X account in Settings to get new posts.";
    render(<ChatSourcePicker {...props()} />);
    fireEvent.click(within(group("Gamma Poster")).getByRole("button", { name: /^Refresh Gamma/ }));
    const retry = await within(group("Gamma Poster")).findByRole("button", {
      name: "Retry updating Gamma Poster (couldn’t update)",
    });
    expect(retry.getAttribute("title")).toContain("Connect your X account in Settings");
  });

  it("says when a creator waiting on X's limit continues", async () => {
    render(<ChatSourcePicker {...props()} />);
    fireEvent.click(within(group("Gamma Poster")).getByRole("button", { name: /^Refresh Gamma/ }));
    await waitFor(() => expect(x.starts).toEqual([[4]]));

    const retryAt = new Date(Date.now() + 6 * 60_000 - 1_000).toISOString();
    act(() => x.set(4, { state: "waiting", retryAt }));
    expect(
      await within(group("Gamma Poster")).findByRole("button", {
        name: "Refresh Gamma Poster (waiting for x · in 6 min)",
      }),
    ).toBeTruthy();
  });
});

describe("ChatSourcePicker — refreshing everyone", () => {
  it("never holds YouTube up behind X, and reports each lane on its own", async () => {
    render(<ChatSourcePicker {...props()} />);
    fireEvent.click(within(rail()).getByRole("button", { name: "Refresh all" }));

    // Two videos at once, and every X account in one request.
    await waitFor(() => expect(refreshAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(x.starts).toEqual([[3, 4]]));
    const retryAt = new Date(Date.now() + 6 * 60_000 - 1_000).toISOString();
    act(() => {
      x.set(3, { state: "waiting", retryAt });
      x.set(4, { state: "waiting", retryAt });
    });
    await waitFor(() =>
      expect(lane("X").textContent).toContain("waiting for X’s limit, continues in 6 min"),
    );

    await settle(1);
    await settle(2);
    expect(lane("YouTube").textContent).toContain("All 2 updated");
    expect(lane("X").textContent).toContain("0 of 2");

    const now = new Date().toISOString();
    act(() => {
      x.set(3, { state: "idle", lastSyncedAt: now, newPosts: 2 });
      x.set(4, { state: "idle", lastSyncedAt: now });
    });
    expect(await within(picker()).findByText("All 3 creators updated")).toBeTruthy();
  });

  it("says once that X isn't connected, while the videos still update", async () => {
    x.problem = "Connect your X account in Settings to get new posts.";
    render(<ChatSourcePicker {...props()} />);
    fireEvent.click(within(rail()).getByRole("button", { name: "Refresh all" }));
    await settle(1);
    await settle(2);

    // One problem with X, said once — not a failure per X creator.
    expect(await within(picker()).findByText("YouTube updated")).toBeTruthy();
    expect(lane("X").textContent).toBe("XConnect your X account in Settings to get new posts.");
    expect(lane("YouTube").textContent).toContain("All 2 updated");
    expect(
      within(group("Gamma Poster")).getByRole("button", {
        name: "Refresh Gamma Poster (updated 2h ago)",
      }),
    ).toBeTruthy();
    expect(within(rail()).queryByRole("button", { name: /^Retry updating/ })).toBeNull();
  });

  it("stops one lane at once, leaves the other going, and resumes it", async () => {
    render(<ChatSourcePicker {...props()} />);
    fireEvent.click(within(rail()).getByRole("button", { name: "Refresh all" }));
    await waitFor(() => expect(x.starts).toEqual([[3, 4]]));

    fireEvent.click(within(lane("X")).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(lane("X").textContent).toContain("Stopped — 0 of 2 updated"));
    expect(x.stops).toEqual([[3, 4]]);
    expect(within(lane("YouTube")).getByRole("button", { name: "Stop" })).toBeTruthy();

    await settle(1);
    await settle(2);
    expect(await within(picker()).findByText(/Stopped — 1 of 3 updated/)).toBeTruthy();
    expect(getTasks().find((task) => task.key === "refresh-all")?.status).toBe("stopped");

    fireEvent.click(within(lane("X")).getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(x.starts).toEqual([
        [3, 4],
        [3, 4],
      ]),
    );
  });

  it("retries only what failed", async () => {
    render(<ChatSourcePicker {...props()} />);
    fireEvent.click(within(rail()).getByRole("button", { name: "Refresh all" }));
    await settle(1, { ok: false, errorCode: "network", message: "No connection." });
    await settle(2);
    const now = new Date().toISOString();
    act(() => {
      x.set(3, { state: "idle", lastSyncedAt: now });
      x.set(4, { state: "idle", lastSyncedAt: now });
    });

    expect(await within(picker()).findByText("Updated 2 of 3 creators")).toBeTruthy();
    expect(lane("YouTube").textContent).toContain("Couldn’t update Alpha Host: No connection.");

    refreshAction.mockClear();
    fireEvent.click(within(lane("YouTube")).getByRole("button", { name: "Try again" }));
    await settle(1);
    expect(refreshAction).toHaveBeenCalledTimes(1);
    expect(x.starts).toHaveLength(1);
    expect(await within(picker()).findByText("Updated 1 creator")).toBeTruthy();
  });

  it("refreshes one platform from the menu, or the one the filter shows", async () => {
    render(<ChatSourcePicker {...props()} />);
    fireEvent.click(within(rail()).getByRole("button", { name: "Choose what to refresh" }));
    fireEvent.click(within(rail()).getByRole("menuitem", { name: /^YouTube/ }));
    await waitFor(() => expect(refreshAction).toHaveBeenCalledTimes(2));
    expect(x.starts).toEqual([]);
    await settle(1);
    await settle(2);

    fireEvent.click(within(picker()).getByRole("button", { name: /^Filter by platform/ }));
    fireEvent.click(within(picker()).getByRole("menuitemradio", { name: /^X/ }));
    fireEvent.click(within(rail()).getByRole("button", { name: "Refresh X" }));
    await waitFor(() => expect(x.starts).toEqual([[3, 4]]));
    expect(refreshAction).toHaveBeenCalledTimes(2);
  });

  it("offers a refresh when nothing is cached yet", async () => {
    render(<ChatSourcePicker {...props({ videos: [], tweets: [] })} />);
    expect(within(picker()).getByText("Nothing cached yet")).toBeTruthy();
    fireEvent.click(within(picker()).getByRole("button", { name: "Fetch from all 3 creators" }));
    expect(refreshAction).toHaveBeenCalledWith(1);
  });
});

describe("ChatSourcePicker — sources that arrive while open", () => {
  it("marks them New, counts them per creator, and gathers them under their own tab", () => {
    const view = render(<ChatSourcePicker {...props()} />);
    expect(within(picker()).queryByRole("button", { name: /^New/ })).toBeNull();

    view.rerender(
      <ChatSourcePicker {...props({ videos: [video("alphavid02", 1, "Alpha two"), ...VIDEOS] })} />,
    );
    expect(within(group("Alpha Host")).getByText("· 1 new")).toBeTruthy();

    fireEvent.click(within(picker()).getByRole("button", { name: /^New/ }));
    expect(within(picker()).getByRole("checkbox", { name: "Select Alpha two" })).toBeTruthy();
    expect(within(picker()).queryByRole("checkbox", { name: "Select Alpha one" })).toBeNull();
    expect(within(picker()).queryByRole("region", { name: "Beta Writer" })).toBeNull();
  });

  it("asks the host to read the library again when an account finishes refreshing", async () => {
    const onSourcesUpdated = vi.fn();
    render(<ChatSourcePicker {...props({ onSourcesUpdated })} />);
    fireEvent.click(within(group("Alpha Host")).getByRole("button", { name: /^Refresh Alpha/ }));
    expect(onSourcesUpdated).not.toHaveBeenCalled();

    await settle(1);
    expect(onSourcesUpdated).toHaveBeenCalledTimes(1);

    // An X account counts too, once its sync settles.
    fireEvent.click(within(group("Gamma Poster")).getByRole("button", { name: /^Refresh Gamma/ }));
    await waitFor(() => expect(x.starts).toEqual([[4]]));
    act(() => x.set(4, { state: "idle", lastSyncedAt: new Date().toISOString(), newPosts: 1 }));
    await waitFor(() => expect(onSourcesUpdated).toHaveBeenCalledTimes(2));
  });
});
