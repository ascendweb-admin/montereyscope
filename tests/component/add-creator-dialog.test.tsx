// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  followVideoChannelAction,
  listProfilesAction,
  resolveCreatorAction,
  saveCreatorAction,
} from "@/app/actions/creators";
import { importVideosAction, previewVideoLinkAction } from "@/app/actions/videos";
import { AddCreatorDialog } from "@/components/library/add-creator-dialog";
import type { CreatorSearchResult } from "@/lib/creators/search/model";
import type { VideoPreview } from "@/lib/videos/import/service";

vi.mock("@/app/actions/creators", () => ({
  followVideoChannelAction: vi.fn(),
  listProfilesAction: vi.fn(async () => []),
  resolveCreatorAction: vi.fn(),
  saveCreatorAction: vi.fn(),
}));
vi.mock("@/app/actions/videos", () => ({
  importVideosAction: vi.fn(),
  previewVideoLinkAction: vi.fn(),
}));
vi.mock("@/app/actions/categories", () => ({ createCategoryAction: vi.fn() }));
vi.mock("@/components/background/operations", () => ({ refreshCreatorTweetsAction: vi.fn() }));
vi.mock("@/lib/x/connection-client", () => ({
  requestXConnection: vi.fn(async () => ({ capability: "disconnected", user: null })),
  xLoginPending: () => false,
}));

const resolveAction = vi.mocked(resolveCreatorAction);
const saveAction = vi.mocked(saveCreatorAction);
const profilesAction = vi.mocked(listProfilesAction);
const previewAction = vi.mocked(previewVideoLinkAction);
const importAction = vi.mocked(importVideosAction);
const followAction = vi.mocked(followVideoChannelAction);

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
  profilesAction.mockReset();
  profilesAction.mockResolvedValue([]);
  previewAction.mockReset();
  importAction.mockReset();
  followAction.mockReset();
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
        profileId: 7,
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
      null,
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

describe("AddCreatorDialog with creator profiles", () => {
  const janeOnYouTube = {
    id: 40,
    displayName: "Jane Doe",
    avatarUrl: null,
    avatarCreatorId: null,
    categories: [{ id: 3, name: "Markets", color: "emerald" as const }],
    accounts: [
      {
        id: 40,
        platform: "youtube" as const,
        displayName: "Jane Doe",
        handle: "janedoe",
        channelUrl: "https://www.youtube.com/@janedoe",
        avatarUrl: null,
        lastRefreshedAt: null,
      },
    ],
  };

  function savedSummary(profileId: number) {
    return {
      ok: true,
      status: "created" as const,
      creator: {
        id: 41,
        displayName: "Jane Doe",
        handle: "janedoe",
        channelUrl: "https://rumble.com/c/janedoe",
        avatarUrl: null,
        youtubeChannelId: null,
        platformUserId: null,
        platform: "rumble" as const,
        profileId,
        categories: [],
      },
    };
  }

  it("suggests the matching person and files the account under them", async () => {
    profilesAction.mockResolvedValue([janeOnYouTube]);
    vi.stubGlobal(
      "fetch",
      searchResponse([
        result({
          platform: "rumble",
          id: "janedoe",
          displayName: "Jane Doe",
          handle: "janedoe",
          channelUrl: "https://rumble.com/c/janedoe",
          youtubeChannelId: null,
          verified: false,
        }),
      ]),
    );
    saveAction.mockResolvedValue(savedSummary(40));

    const input = openDialog();
    await waitFor(() => expect(profilesAction).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("radio", { name: /Rumble/ }));
    fireEvent.change(input, { target: { value: "jane doe" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const list = await screen.findByRole("region", { name: "Search results for jane doe" });
    fireEvent.click(within(list).getByRole("button", { name: "Add Jane Doe" }));

    // The likely person is preselected, and the categories step steps aside.
    expect(
      screen
        .getByRole("radio", { name: /Add to an existing creator/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByRole("option", { name: /Jane Doe/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.queryByText("Categories")).toBeNull();
    expect(screen.getByText(/Filed under Jane Doe/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add to Jane Doe" }));
    await screen.findByText("Added Jane Doe on Rumble to Jane Doe.");
    expect(saveAction).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "rumble" }),
      [],
      40,
    );
  });

  it("saves as a new creator when the user says so", async () => {
    profilesAction.mockResolvedValue([janeOnYouTube]);
    vi.stubGlobal(
      "fetch",
      searchResponse([
        result({
          platform: "rumble",
          id: "janedoe",
          displayName: "Jane Doe",
          handle: "janedoe",
          channelUrl: "https://rumble.com/c/janedoe",
          youtubeChannelId: null,
          verified: false,
        }),
      ]),
    );
    saveAction.mockResolvedValue(savedSummary(41));

    const input = openDialog();
    await waitFor(() => expect(profilesAction).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("radio", { name: /Rumble/ }));
    fireEvent.change(input, { target: { value: "jane doe" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const list = await screen.findByRole("region", { name: "Search results for jane doe" });
    fireEvent.click(within(list).getByRole("button", { name: "Add Jane Doe" }));
    fireEvent.click(screen.getByRole("radio", { name: /New creator/ }));
    expect(screen.getByText("Categories")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save to library" }));
    await screen.findByText("Added Jane Doe to your library.");
    expect(saveAction).toHaveBeenCalledWith(expect.anything(), [], null);
  });

  it("adds every account to the creator a page targets", async () => {
    vi.stubGlobal(
      "fetch",
      searchResponse([
        result({
          platform: "rumble",
          id: "janedoe",
          displayName: "Jane Doe",
          handle: "janedoe",
          channelUrl: "https://rumble.com/c/janedoe",
          youtubeChannelId: null,
          verified: false,
        }),
      ]),
    );
    saveAction.mockResolvedValue(savedSummary(40));
    render(
      <AddCreatorDialog
        categories={[]}
        initialPlatform="rumble"
        targetProfile={{ id: 40, displayName: "Jane Doe", avatarUrl: null, avatarCreatorId: null }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add platform" }));
    expect(screen.getByRole("dialog", { name: "Add a platform to Jane Doe" })).toBeTruthy();
    // The person's name starts the search.
    const input = screen.getByRole("textbox", { name: "Find a creator" }) as HTMLInputElement;
    expect(input.value).toBe("Jane Doe");
    expect(profilesAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const list = await screen.findByRole("region", { name: "Search results for Jane Doe" });
    fireEvent.click(within(list).getByRole("button", { name: "Add Jane Doe" }));
    expect(screen.queryByRole("radiogroup", { name: "Save as" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add to Jane Doe" }));
    await screen.findByText("Added Jane Doe on Rumble to Jane Doe.");
    expect(saveAction).toHaveBeenCalledWith(expect.anything(), [], 40);
  });
});

describe("AddCreatorDialog video links", () => {
  const VIDEO_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
  const RUMBLE_URL = "https://rumble.com/v7emyxa";

  function videoPreview(overrides: Partial<VideoPreview> = {}): VideoPreview {
    return {
      url: VIDEO_URL,
      videoId: "jNQXAC9IVRw",
      platform: "youtube",
      title: "Me at the zoo",
      thumbnailUrl: null,
      durationSeconds: 19,
      publishedAt: "2005-04-24T00:00:00.000Z",
      liveStatus: "not_live",
      hostName: "jawed",
      hostHandle: "jawed",
      hostPlatform: "youtube",
      captions: "manual",
      alreadyInLibrary: false,
      alreadyAttached: false,
      ...overrides,
    };
  }

  const jane = {
    id: 40,
    displayName: "Jane Doe",
    avatarUrl: null,
    avatarCreatorId: null,
    categories: [],
    accounts: [
      {
        id: 40,
        platform: "youtube" as const,
        displayName: "Jane Doe",
        handle: "janedoe",
        channelUrl: "https://www.youtube.com/@janedoe",
        avatarUrl: null,
        lastRefreshedAt: null,
      },
    ],
  };
  const sam = {
    ...jane,
    id: 41,
    displayName: "Sam Lee",
    accounts: [{ ...jane.accounts[0], id: 41, displayName: "Sam Lee", handle: "samlee" }],
  };

  function importedRow(overrides: Record<string, unknown> = {}) {
    return {
      ok: true as const,
      results: [
        {
          url: VIDEO_URL,
          status: "added" as const,
          videoId: "jNQXAC9IVRw",
          title: "Me at the zoo",
          hostName: "jawed",
          hostCreatorId: 90,
          hostFollowedBefore: false,
          ...overrides,
        },
      ],
    };
  }

  async function lookUp(
    link = VIDEO_URL,
    props: Partial<React.ComponentProps<typeof AddCreatorDialog>> = {},
  ) {
    const input = openDialog(props);
    fireEvent.change(input, { target: { value: link } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    await screen.findByText("Me at the zoo");
    return input;
  }

  it("previews a pasted video link instead of resolving a creator", async () => {
    previewAction.mockResolvedValue({ ok: true, preview: videoPreview() });
    profilesAction.mockResolvedValue([jane, sam]);
    const input = openDialog();
    fireEvent.change(input, { target: { value: VIDEO_URL } });
    expect(screen.getByText(/Video link detected/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));

    await screen.findByText("Me at the zoo");
    expect(previewAction).toHaveBeenCalledWith(VIDEO_URL, undefined);
    expect(resolveAction).not.toHaveBeenCalled();
    expect(screen.getByText("Human captions")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "What to do with this video" })).toBeTruthy();
    // Adding to a person is the default; nobody is picked until the user does.
    expect(
      screen.getByRole("radio", { name: /Add to a person/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect((screen.getByRole("button", { name: "Add video" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("adds the video to the person the user picks", async () => {
    previewAction.mockResolvedValue({ ok: true, preview: videoPreview() });
    profilesAction.mockResolvedValue([jane, sam]);
    importAction.mockResolvedValue(importedRow());
    await lookUp();

    const people = screen.getByRole("listbox", { name: "Creators in your library" });
    fireEvent.click(
      within(within(people).getByRole("option", { name: /Sam Lee/ })).getByRole("button"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add video to Sam Lee" }));

    await screen.findByText("Added “Me at the zoo” to Sam Lee's Other videos.");
    expect(importAction).toHaveBeenCalledWith([VIDEO_URL], { profileId: 41, followHost: false });
    expect(followAction).not.toHaveBeenCalled();
    expect(saveAction).not.toHaveBeenCalled();
  });

  it("can also follow the video's channel", async () => {
    previewAction.mockResolvedValue({ ok: true, preview: videoPreview() });
    profilesAction.mockResolvedValue([jane]);
    importAction.mockResolvedValue(importedRow());
    await lookUp();

    fireEvent.click(within(screen.getByRole("option", { name: /Jane Doe/ })).getByRole("button"));
    const alsoFollow = screen.getByRole("switch", { name: /Also follow jawed/ });
    expect((alsoFollow as HTMLInputElement).checked).toBe(false);
    fireEvent.click(alsoFollow);
    fireEvent.click(screen.getByRole("button", { name: "Add video to Jane Doe" }));

    await screen.findByText(
      "Added “Me at the zoo” to Jane Doe's Other videos. jawed is in your library now too.",
    );
    expect(importAction).toHaveBeenCalledWith([VIDEO_URL], { profileId: 40, followHost: true });
  });

  it("says so when the video was already in the person's Other videos", async () => {
    previewAction.mockResolvedValue({ ok: true, preview: videoPreview() });
    profilesAction.mockResolvedValue([jane]);
    importAction.mockResolvedValue(importedRow({ status: "already_attached" }));
    await lookUp();
    fireEvent.click(within(screen.getByRole("option", { name: /Jane Doe/ })).getByRole("button"));
    fireEvent.click(screen.getByRole("button", { name: "Add video to Jane Doe" }));
    await screen.findByText("“Me at the zoo” was already in Jane Doe's Other videos.");
  });

  it("locks the person when the dialog is opened from their page", async () => {
    previewAction.mockResolvedValue({ ok: true, preview: videoPreview({ alreadyAttached: true }) });
    importAction.mockResolvedValue(importedRow());
    render(
      <AddCreatorDialog
        categories={[]}
        targetProfile={{ id: 40, displayName: "Jane Doe", avatarUrl: null, avatarCreatorId: null }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add platform" }));
    const input = screen.getByRole("textbox", { name: "Find a creator" });
    fireEvent.change(input, { target: { value: VIDEO_URL } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    await screen.findByText("Me at the zoo");

    // The preview asks whether this person already has it.
    expect(previewAction).toHaveBeenCalledWith(VIDEO_URL, 40);
    expect(profilesAction).not.toHaveBeenCalled();
    expect(screen.getByText(/Already in Jane Doe's Other videos/)).toBeTruthy();
    // No choice to make: the person is fixed and there is no people list.
    expect(screen.queryByRole("radiogroup", { name: "What to do with this video" })).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText(/Goes to/).textContent).toContain("Jane Doe");
    fireEvent.click(screen.getByRole("button", { name: "Add video to Jane Doe" }));

    await screen.findByText("Added “Me at the zoo” to Jane Doe's Other videos.");
    expect(importAction).toHaveBeenCalledWith([VIDEO_URL], { profileId: 40, followHost: false });
  });

  it("follows the channel as a creator, with categories", async () => {
    previewAction.mockResolvedValue({ ok: true, preview: videoPreview() });
    profilesAction.mockResolvedValue([jane]);
    const saved = {
      id: 90,
      displayName: "jawed",
      handle: "jawed",
      channelUrl: "https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A",
      avatarUrl: null,
      youtubeChannelId: "UC4QobU6STFB0P71PMvOGN5A",
      platformUserId: null,
      platform: "youtube" as const,
      profileId: 90,
      categories: [],
    };
    followAction.mockResolvedValue({ ok: true, status: "created", creator: saved });
    const onSaved = vi.fn();
    render(
      <AddCreatorDialog
        categories={[{ id: 3, name: "Markets", color: "emerald", creatorCount: 0 }]}
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add creator" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find a creator" }), {
      target: { value: VIDEO_URL },
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    await screen.findByText("Me at the zoo");

    fireEvent.click(screen.getByRole("radio", { name: /Follow jawed as a creator/ }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText("Categories")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Markets/ }));
    fireEvent.click(screen.getByRole("button", { name: "Follow jawed" }));

    await screen.findByText("Added jawed to your library, with “Me at the zoo”.");
    expect(followAction).toHaveBeenCalledWith(VIDEO_URL, [3]);
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(importAction).not.toHaveBeenCalled();
  });

  it("says so when the followed channel was already in the library", async () => {
    previewAction.mockResolvedValue({ ok: true, preview: videoPreview() });
    followAction.mockResolvedValue({
      ok: true,
      status: "already_saved",
      creator: {
        id: 90,
        displayName: "jawed",
        handle: "jawed",
        channelUrl: "https://www.youtube.com/@jawed",
        avatarUrl: null,
        youtubeChannelId: null,
        platformUserId: null,
        platform: "youtube",
        profileId: 90,
        categories: [],
      },
    });
    await lookUp();
    // An empty library leaves only the channel to follow.
    fireEvent.click(screen.getByRole("button", { name: "Follow jawed" }));
    await screen.findByText("Added “Me at the zoo” under jawed, who was already in your library.");
  });

  it("offers only the channel when the library is empty", async () => {
    previewAction.mockResolvedValue({ ok: true, preview: videoPreview() });
    profilesAction.mockResolvedValue([]);
    await lookUp();
    await waitFor(() =>
      expect(
        screen
          .getByRole("radio", { name: /Follow jawed as a creator/ })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    const person = screen.getByRole("radio", { name: /Add to a person/ }) as HTMLButtonElement;
    expect(person.disabled).toBe(true);
    expect(screen.getByText("Your library is empty.")).toBeTruthy();
  });

  it("ignores the selected platform tab, because the link names its platform", async () => {
    previewAction.mockResolvedValue({
      ok: true,
      preview: videoPreview({
        url: RUMBLE_URL,
        videoId: "v7emyxa",
        platform: "rumble",
        hostPlatform: "rumble",
        hostName: "Redacted News",
      }),
    });
    const input = openDialog({ initialPlatform: "x" });
    fireEvent.change(input, { target: { value: RUMBLE_URL } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    await screen.findByText("Me at the zoo");
    expect(previewAction).toHaveBeenCalledWith(RUMBLE_URL, undefined);
    expect(resolveAction).not.toHaveBeenCalled();
  });

  it("expands a bare video address before looking it up", async () => {
    previewAction.mockResolvedValue({ ok: true, preview: videoPreview() });
    await lookUp("youtu.be/jNQXAC9IVRw");
    expect(previewAction).toHaveBeenCalledWith("https://youtu.be/jNQXAC9IVRw", undefined);
  });

  it("shows a rejected video next to the input", async () => {
    previewAction.mockResolvedValue({
      ok: false,
      code: "no_english_captions",
      message: "No original English captions are available for this video.",
      retryable: false,
    });
    const input = openDialog();
    fireEvent.change(input, { target: { value: VIDEO_URL } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "No original English captions are available for this video.",
      ),
    );
    // The input comes back (the dialog replaces it while it looks the link up).
    const again = screen.getByRole("textbox", { name: "Find a creator" });
    expect(again.getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByRole("radiogroup", { name: "What to do with this video" })).toBeNull();
    // Editing the link clears the message.
    fireEvent.change(again, { target: { value: `${VIDEO_URL}&t=1` } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("points to the yt-dlp setup when it is missing", async () => {
    previewAction.mockResolvedValue({
      ok: false,
      code: "ytdlp_missing",
      message: "yt-dlp is not installed.",
      retryable: true,
    });
    const input = openDialog();
    fireEvent.change(input, { target: { value: VIDEO_URL } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    await screen.findByText("Local tool missing.");
    expect(screen.queryByText("yt-dlp is not installed.")).toBeNull();
  });

  it("keeps the dialog open with the reason when saving the video is turned down", async () => {
    previewAction.mockResolvedValue({ ok: true, preview: videoPreview() });
    profilesAction.mockResolvedValue([jane]);
    importAction.mockResolvedValue({
      ok: true,
      results: [
        {
          url: VIDEO_URL,
          status: "rejected",
          error: {
            code: "no_english_captions",
            message: "No original English captions are available for this video.",
            retryable: false,
          },
        },
      ],
    });
    await lookUp();
    fireEvent.click(within(screen.getByRole("option", { name: /Jane Doe/ })).getByRole("button"));
    fireEvent.click(screen.getByRole("button", { name: "Add video to Jane Doe" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "No original English captions are available for this video.",
      ),
    );
    // Still on the confirm step, so the user can go back or choose differently.
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.queryByText(/Added “Me at the zoo”/)).toBeNull();
  });

  it("goes back to the input with the link still there", async () => {
    previewAction.mockResolvedValue({ ok: true, preview: videoPreview() });
    await lookUp();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const input = (await screen.findByRole("textbox", {
      name: "Find a creator",
    })) as HTMLInputElement;
    expect(input.value).toBe(VIDEO_URL);
    expect(screen.queryByText("Me at the zoo")).toBeNull();
  });

  it("leaves channel, X profile, and X post links on the creator lookup", async () => {
    resolveAction.mockResolvedValue({ ok: false, errorCode: "invalid_url", message: "nope" });
    openDialog();
    for (const [link, platform] of [
      ["https://www.youtube.com/@MrBeast", "youtube"],
      ["https://rumble.com/c/Bongino", "youtube"],
      ["https://x.com/jane/status/1234567890", "youtube"],
      ["https://x.com/jane", "youtube"],
    ] as const) {
      resolveAction.mockClear();
      const input = await screen.findByRole("textbox", { name: "Find a creator" });
      fireEvent.change(input, { target: { value: link } });
      fireEvent.click(screen.getByRole("button", { name: "Look up" }));
      await waitFor(() => expect(resolveAction).toHaveBeenCalledWith(link, platform));
    }
    expect(previewAction).not.toHaveBeenCalled();
  });

  it("keeps a platform-locked dialog on the creator lookup for a video link", async () => {
    resolveAction.mockResolvedValue({
      ok: false,
      errorCode: "invalid_url",
      message: "That is a YouTube link. Choose the X platform above to add it.",
    });
    const input = openDialog({ initialPlatform: "x", lockPlatform: true });
    fireEvent.change(input, { target: { value: VIDEO_URL } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    await screen.findByText(/Choose the X platform/);
    expect(previewAction).not.toHaveBeenCalled();
  });
});
