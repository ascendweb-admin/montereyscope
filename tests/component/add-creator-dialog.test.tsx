// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveCreatorAction, saveCreatorAction } from "@/app/actions/creators";
import { AddCreatorDialog } from "@/components/library/add-creator-dialog";
import type { CreatorSearchResult } from "@/lib/creators/search/model";

vi.mock("@/app/actions/creators", () => ({
  resolveCreatorAction: vi.fn(),
  saveCreatorAction: vi.fn(),
}));
vi.mock("@/app/actions/categories", () => ({ createCategoryAction: vi.fn() }));
vi.mock("@/components/background/operations", () => ({ refreshCreatorTweetsAction: vi.fn() }));
vi.mock("@/lib/x/connection-client", () => ({
  requestXConnection: vi.fn(async () => ({ capability: "disconnected", user: null })),
  xLoginPending: () => false,
}));

const resolveAction = vi.mocked(resolveCreatorAction);
const saveAction = vi.mocked(saveCreatorAction);

function result(overrides: Partial<CreatorSearchResult> = {}): CreatorSearchResult {
  return {
    platform: "youtube",
    id: "UC-lHJZR3Gqxm24_Vd_AJ5Yw",
    displayName: "PewDiePie",
    handle: "pewdiepie",
    channelUrl: "https://www.youtube.com/channel/UC-lHJZR3Gqxm24_Vd_AJ5Yw",
    avatarUrl: null,
    followerCount: 109_000_000,
    verified: true,
    protectedAccount: false,
    description: "I make videos.",
    youtubeChannelId: "UC-lHJZR3Gqxm24_Vd_AJ5Yw",
    platformUserId: null,
    savedCreatorId: null,
    ...overrides,
  };
}

function searchResponse(results: CreatorSearchResult[]) {
  return vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () =>
    Response.json({ results }),
  );
}

function openDialog(props: Partial<React.ComponentProps<typeof AddCreatorDialog>> = {}) {
  render(<AddCreatorDialog categories={[]} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Add creator" }));
  return screen.getByRole("textbox", { name: "Find a creator" });
}

beforeEach(() => {
  resolveAction.mockReset();
  saveAction.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AddCreatorDialog search", () => {
  it("searches by name, adds a result, and returns to the results marked Added", async () => {
    const fetchMock = searchResponse([
      result(),
      result({
        id: "UCQ4zIVlfhsmvds7WuKeL2Bw",
        displayName: "PewDiePie Highlights",
        handle: "pewdiepiehighlights",
        followerCount: 1_230_000,
        verified: false,
      }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    saveAction.mockResolvedValue({
      ok: true,
      status: "created",
      creator: {
        id: 7,
        displayName: "PewDiePie",
        handle: "pewdiepie",
        channelUrl: "https://www.youtube.com/channel/UC-lHJZR3Gqxm24_Vd_AJ5Yw",
        avatarUrl: null,
        youtubeChannelId: "UC-lHJZR3Gqxm24_Vd_AJ5Yw",
        platformUserId: null,
        platform: "youtube",
        categories: [],
      },
    });

    const input = openDialog();
    fireEvent.change(input, { target: { value: "  pewdiepie " } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    const list = await screen.findByRole("region", { name: "Search results for pewdiepie" });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "/api/creators/search?platform=youtube&q=pewdiepie",
    );
    expect(within(list).getByText("@pewdiepie · 109M subscribers")).toBeTruthy();
    expect(within(list).getAllByRole("img", { name: "Verified" })).toHaveLength(1);

    fireEvent.click(within(list).getByRole("button", { name: "Add PewDiePie" }));
    expect(resolveAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save to library" }));

    await screen.findByText("Added PewDiePie to your library.");
    expect(saveAction).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "youtube",
        youtubeChannelId: "UC-lHJZR3Gqxm24_Vd_AJ5Yw",
        channelUrl: "https://www.youtube.com/channel/UC-lHJZR3Gqxm24_Vd_AJ5Yw",
      }),
      [],
    );
    const updated = screen.getByRole("region", { name: "Search results for pewdiepie" });
    expect(within(updated).queryByRole("button", { name: "Add PewDiePie" })).toBeNull();
    expect(within(updated).getByText("Added")).toBeTruthy();
    expect(within(updated).getByRole("button", { name: "Add PewDiePie Highlights" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.getByText("1 creator added")).toBeTruthy();
  });

  it("re-runs the current search when the platform changes", async () => {
    const fetchMock = searchResponse([]);
    vi.stubGlobal("fetch", fetchMock);
    const input = openDialog();
    fireEvent.change(input, { target: { value: "bongino" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByText(/No channels match “bongino” on YouTube/);

    fireEvent.click(screen.getByRole("radio", { name: "Rumble" }));
    await screen.findByText(/No channels match “bongino” on Rumble/);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "/api/creators/search?platform=rumble&q=bongino",
    );
  });

  it("shows search failures with a retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "throttled", message: "Rumble is limiting searches right now." } },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ results: [result({ platform: "rumble" })] }));
    vi.stubGlobal("fetch", fetchMock);
    const input = openDialog({ initialPlatform: "rumble" });
    fireEvent.change(input, { target: { value: "bongino" } });
    fireEvent.submit(input.closest("form")!);

    expect((await screen.findByRole("alert")).textContent).toContain("Rumble is limiting searches");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: "Add PewDiePie" });
  });

  it("offers an inline X connection when X search needs a session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "not_connected", message: "X is not connected on this machine." } },
          { status: 503 },
        ),
      ),
    );
    const input = openDialog({ initialPlatform: "x" });
    fireEvent.change(input, { target: { value: "pewdiepie" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByText("X needs a connection first.");
    expect(await screen.findByText(/Your search runs as soon as X connects/)).toBeTruthy();
  });

  it("does not offer Add for protected X accounts", async () => {
    vi.stubGlobal(
      "fetch",
      searchResponse([
        result({
          platform: "x",
          id: "1",
          displayName: "Locked",
          handle: "locked",
          protectedAccount: true,
        }),
      ]),
    );
    const input = openDialog({ initialPlatform: "x" });
    fireEvent.change(input, { target: { value: "locked" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByText("Protected");
    expect(screen.queryByRole("button", { name: "Add Locked" })).toBeNull();
  });
});

describe("AddCreatorDialog links", () => {
  it("looks up links and handles directly instead of searching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    resolveAction.mockResolvedValue({
      ok: true,
      creator: {
        platform: "youtube",
        youtubeChannelId: "UCX6OQ3DkcsbYNE6H8uQQuVA",
        platformUserId: null,
        handle: "mrbeast",
        displayName: "MrBeast",
        channelUrl: "https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA",
        avatarUrl: null,
        followerCount: null,
        videoTitle: null,
        videoId: null,
        videoUrl: null,
        tweetId: null,
        tweetText: null,
        tweetUrl: null,
        tweetPublishedAt: null,
      },
    });
    const input = openDialog();
    fireEvent.change(input, { target: { value: "@MrBeast" } });
    expect(screen.getByText(/Exact handle/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));

    await screen.findByText("MrBeast");
    expect(resolveAction).toHaveBeenCalledWith("https://www.youtube.com/@MrBeast", "youtube");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("keeps resolve errors next to the input", async () => {
    resolveAction.mockResolvedValue({
      ok: false,
      errorCode: "unavailable_channel",
      message: "YouTube does not offer that channel.",
    });
    const input = openDialog();
    fireEvent.change(input, { target: { value: "https://www.youtube.com/@nobody" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("YouTube does not offer that channel."),
    );
    expect(
      screen.getByRole("textbox", { name: "Find a creator" }).getAttribute("aria-invalid"),
    ).toBe("true");
  });
});
