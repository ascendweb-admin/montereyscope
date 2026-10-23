// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { importVideosAction, previewVideoLinkAction } from "@/app/actions/videos";
import { AddVideosDialog } from "@/components/creators/add-videos-dialog";
import type { VideoPreview } from "@/lib/videos/import/service";

vi.mock("@/app/actions/videos", () => ({
  previewVideoLinkAction: vi.fn(),
  importVideosAction: vi.fn(),
}));

const previewAction = vi.mocked(previewVideoLinkAction);
const importAction = vi.mocked(importVideosAction);

const PROFILE = { id: 7, displayName: "Luke Belmar" };

const link = (id: string): string => `https://www.youtube.com/watch?v=${id}`;
const A = "aaaaaaaaaaa";
const B = "bbbbbbbbbbb";
const C = "ccccccccccc";
const D = "ddddddddddd";
const E = "eeeeeeeeeee";

function preview(id: string, overrides: Partial<VideoPreview> = {}): VideoPreview {
  return {
    url: link(id),
    videoId: id,
    platform: "youtube",
    title: `Episode ${id}`,
    thumbnailUrl: null,
    durationSeconds: 600,
    publishedAt: "2026-09-01T00:00:00.000Z",
    liveStatus: "not_live",
    hostName: "PBD Podcast",
    hostHandle: "pbdpodcast",
    hostPlatform: "youtube",
    captions: "manual",
    alreadyInLibrary: false,
    alreadyAttached: false,
    ...overrides,
  };
}

const ready = (id: string, overrides: Partial<VideoPreview> = {}) => ({
  ok: true as const,
  preview: preview(id, overrides),
});

const rejection = (message: string, code = "no_english_captions" as const) => ({
  ok: false as const,
  code,
  message,
  retryable: false,
});

const transient = (message: string) => ({
  ok: false as const,
  code: "throttled" as const,
  message,
  retryable: true,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type PreviewResult = Awaited<ReturnType<typeof previewVideoLinkAction>>;

/** Answers each link from a table, immediately. */
function answerPreviews(table: Record<string, PreviewResult>) {
  previewAction.mockImplementation(async (url) => {
    const answer = table[String(url)];
    if (!answer) throw new Error(`unexpected preview for ${String(url)}`);
    return answer;
  });
}

function openDialog(onImported = vi.fn()) {
  render(<AddVideosDialog profile={PROFILE} onImported={onImported} />);
  fireEvent.click(screen.getByRole("button", { name: "Add videos" }));
  return {
    textarea: screen.getByRole("textbox", {
      name: "Paste video links, one per line or all at once",
    }) as HTMLTextAreaElement,
    onImported,
  };
}

function paste(textarea: HTMLTextAreaElement, ...lines: string[]) {
  fireEvent.change(textarea, { target: { value: lines.join("\n") } });
}

async function findVideos(textarea: HTMLTextAreaElement, ...lines: string[]) {
  paste(textarea, ...lines);
  fireEvent.click(screen.getByRole("button", { name: "Find videos" }));
  await screen.findByRole("list", { name: "Pasted videos" });
}

function rowOf(title: string): HTMLElement {
  const row = screen.getByText(title).closest("li");
  if (!row) throw new Error(`no row for ${title}`);
  return row;
}

function checkboxOf(title: string): HTMLInputElement {
  return screen.getByRole("checkbox", { name: `Select ${title}` }) as HTMLInputElement;
}

beforeEach(() => {
  previewAction.mockReset();
  importAction.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("AddVideosDialog: paste step", () => {
  it("disables Find videos until something is pasted", () => {
    const { textarea } = openDialog();

    const button = screen.getByRole("button", { name: "Find videos" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    paste(textarea, link(A));
    expect(button.disabled).toBe(false);
  });

  it("looks the links up with Ctrl+Enter but not with Enter", async () => {
    answerPreviews({ [link(A)]: ready(A) });
    const { textarea } = openDialog();
    paste(textarea, link(A));

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(previewAction).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    await screen.findByRole("list", { name: "Pasted videos" });
    expect(previewAction).toHaveBeenCalledWith(link(A), PROFILE.id);
  });

  it("says so when the paste holds no links at all", () => {
    const { textarea } = openDialog();
    paste(textarea, "just some words, no links here");

    fireEvent.click(screen.getByRole("button", { name: "Find videos" }));

    expect(screen.getByRole("alert").textContent).toContain("No video links found");
    expect(previewAction).not.toHaveBeenCalled();
  });
});

describe("AddVideosDialog: review step", () => {
  it("looks up three links at a time and starts the next as each finishes", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<PreviewResult>>>();
    previewAction.mockImplementation((url) => {
      const entry = deferred<PreviewResult>();
      pending.set(String(url), entry);
      return entry.promise;
    });
    const { textarea } = openDialog();
    await findVideos(textarea, link(A), link(B), link(C), link(D), link(E));

    await waitFor(() => expect(previewAction).toHaveBeenCalledTimes(3));
    expect(previewAction.mock.calls.map(([url]) => url)).toEqual([link(A), link(B), link(C)]);
    expect(screen.getAllByText("Checking…")).toHaveLength(5);

    await act(async () => pending.get(link(B))!.resolve(ready(B)));
    await waitFor(() => expect(previewAction).toHaveBeenCalledTimes(4));
    expect(previewAction.mock.calls[3][0]).toBe(link(D));
    // The finished row filled in while the others still check.
    expect(within(rowOf("Episode bbbbbbbbbbb")).getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Checking 4 of 5 links…")).toBeTruthy();

    await act(async () => pending.get(link(A))!.resolve(ready(A)));
    await act(async () => pending.get(link(C))!.resolve(ready(C)));
    await waitFor(() => expect(previewAction).toHaveBeenCalledTimes(5));
    expect(previewAction.mock.calls[4][0]).toBe(link(E));
  });

  it("shows what each link turned out to be, and only lets ready ones be ticked", async () => {
    answerPreviews({
      [link(A)]: ready(A),
      [link(B)]: ready(B, { alreadyAttached: true }),
      [link(C)]: rejection("No original English captions are available for this video."),
      [link(D)]: transient("YouTube is slowing scope down. Try again in a moment."),
    });
    const { textarea } = openDialog();
    await findVideos(
      textarea,
      link(A),
      link(B),
      link(C),
      link(D),
      "https://example.com/some-video",
      "https://www.youtube.com/@pbdpodcast",
    );
    await screen.findByText("Ready");

    expect(within(rowOf("Episode aaaaaaaaaaa")).getByText("Ready")).toBeTruthy();
    expect(within(rowOf("Episode bbbbbbbbbbb")).getByText("Already in Other videos")).toBeTruthy();
    expect(
      screen.getByText("Rejected: No original English captions are available for this video."),
    ).toBeTruthy();
    expect(
      screen.getByText("Couldn't check: YouTube is slowing scope down. Try again in a moment."),
    ).toBeTruthy();
    // The two links that are not single videos are rejected rows with their message.
    expect(screen.getAllByText(/^Rejected: /)).toHaveLength(3);

    // Ready is pre-ticked; nothing else can be ticked.
    expect(checkboxOf("Episode aaaaaaaaaaa").checked).toBe(true);
    expect(checkboxOf("Episode aaaaaaaaaaa").disabled).toBe(false);
    expect(checkboxOf("Episode bbbbbbbbbbb").disabled).toBe(true);
    for (const box of screen.getAllByRole("checkbox", { name: /^Select https:/ })) {
      expect((box as HTMLInputElement).disabled).toBe(true);
      expect((box as HTMLInputElement).checked).toBe(false);
    }
    expect(screen.getByRole("button", { name: "Add 1 video" })).toBeTruthy();
  });

  it("shows the captions kind, host, and a load hint for what is selected", async () => {
    answerPreviews({
      [link(A)]: ready(A, { captions: "manual", durationSeconds: 3600 }),
      [link(B)]: ready(B, { captions: "automatic", durationSeconds: 5400 }),
    });
    const { textarea } = openDialog();
    await findVideos(textarea, link(A), link(B));
    await screen.findByRole("button", { name: "Add 2 videos" });

    expect(within(rowOf("Episode aaaaaaaaaaa")).getByText("Human captions")).toBeTruthy();
    expect(within(rowOf("Episode bbbbbbbbbbb")).getByText("Auto captions")).toBeTruthy();
    expect(within(rowOf("Episode aaaaaaaaaaa")).getByText("PBD Podcast")).toBeTruthy();
    expect(
      screen.getByText("2 videos · 2.5 h selected. An analysis takes up to 25 videos or 50 hours."),
    ).toBeTruthy();

    fireEvent.click(checkboxOf("Episode bbbbbbbbbbb"));
    expect(screen.getByRole("button", { name: "Add 1 video" })).toBeTruthy();
    expect(
      screen.getByText("1 video · 1 h selected. An analysis takes up to 25 videos or 50 hours."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(
      (screen.getByRole("button", { name: "Add 0 videos" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Select all ready" }));
    expect(screen.getByRole("button", { name: "Add 2 videos" })).toBeTruthy();
  });

  it("holds the Add button back until every link has been checked", async () => {
    const slow = deferred<PreviewResult>();
    previewAction.mockImplementation((url) =>
      String(url) === link(B) ? slow.promise : Promise.resolve(ready(A)),
    );
    const { textarea } = openDialog();
    await findVideos(textarea, link(A), link(B));
    await screen.findByText("Ready");

    expect(
      (screen.getByRole("button", { name: "Add 1 video" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => slow.resolve(ready(B)));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Add 2 videos" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("retries a link that could not be checked", async () => {
    previewAction.mockResolvedValueOnce(transient("scope could not reach YouTube."));
    const { textarea } = openDialog();
    await findVideos(textarea, link(A));
    await screen.findByText("Couldn't check: scope could not reach YouTube.");

    previewAction.mockResolvedValueOnce(ready(A));
    fireEvent.click(screen.getByRole("button", { name: `Retry ${link(A)}` }));

    await screen.findByText("Ready");
    expect(previewAction).toHaveBeenCalledTimes(2);
    expect(previewAction).toHaveBeenLastCalledWith(link(A), PROFILE.id);
    expect(checkboxOf("Episode aaaaaaaaaaa").checked).toBe(true);
  });

  it("collapses repeats and says when the paste was cut at 30 links", async () => {
    previewAction.mockImplementation(async (url) => ready(String(url).slice(-11)));
    const { textarea } = openDialog();
    const ids = Array.from({ length: 31 }, (_, index) => `video${String(index).padStart(6, "0")}`);
    await findVideos(textarea, ...ids.map(link), link(ids[0]));

    expect(screen.getByText("Only the first 30 links were used.")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(30);
  });

  it("goes back to the paste step with the text intact", async () => {
    answerPreviews({ [link(A)]: ready(A) });
    const { textarea } = openDialog();
    await findVideos(textarea, link(A));

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    const again = screen.getByRole("textbox", {
      name: "Paste video links, one per line or all at once",
    }) as HTMLTextAreaElement;
    expect(again.value).toBe(link(A));
  });
});

describe("AddVideosDialog: adding", () => {
  it("adds the ticked videos, then closes with a toast and tells the page", async () => {
    answerPreviews({ [link(A)]: ready(A), [link(B)]: ready(B), [link(C)]: ready(C) });
    importAction.mockResolvedValue({
      ok: true,
      results: [
        { url: link(A), status: "added", videoId: A },
        { url: link(C), status: "attached_existing", videoId: C },
      ],
    });
    const { textarea, onImported } = openDialog();
    await findVideos(textarea, link(A), link(B), link(C));
    await screen.findByRole("button", { name: "Add 3 videos" });
    fireEvent.click(checkboxOf("Episode bbbbbbbbbbb"));

    fireEvent.click(screen.getByRole("button", { name: "Add 2 videos" }));

    await screen.findByText("Added 2 videos to Luke Belmar's Other videos.");
    expect(importAction).toHaveBeenCalledWith([link(A), link(C)], {
      profileId: PROFILE.id,
      followHost: false,
    });
    expect(onImported).toHaveBeenCalledTimes(1);
    // The dialog resets for the next paste.
    await waitFor(() =>
      expect(
        (
          screen.getByRole("textbox", {
            name: "Paste video links, one per line or all at once",
            hidden: true,
          }) as HTMLTextAreaElement
        ).value,
      ).toBe(""),
    );
  });

  it("says 'video' for one", async () => {
    answerPreviews({ [link(A)]: ready(A) });
    importAction.mockResolvedValue({
      ok: true,
      results: [{ url: link(A), status: "added", videoId: A }],
    });
    const { textarea } = openDialog();
    await findVideos(textarea, link(A));
    await screen.findByRole("button", { name: "Add 1 video" });

    fireEvent.click(screen.getByRole("button", { name: "Add 1 video" }));

    await screen.findByText("Added 1 video to Luke Belmar's Other videos.");
  });

  it("also follows the channels only when the switch is on", async () => {
    answerPreviews({ [link(A)]: ready(A) });
    importAction.mockResolvedValue({
      ok: true,
      results: [{ url: link(A), status: "added", videoId: A }],
    });
    const { textarea } = openDialog();
    await findVideos(textarea, link(A));
    await screen.findByRole("button", { name: "Add 1 video" });

    const follow = screen.getByRole("switch", { name: /Also follow these channels/ });
    expect((follow as HTMLInputElement).checked).toBe(false);
    fireEvent.click(follow);
    fireEvent.click(screen.getByRole("button", { name: "Add 1 video" }));

    await screen.findByText("Added 1 video to Luke Belmar's Other videos.");
    expect(importAction).toHaveBeenCalledWith([link(A)], {
      profileId: PROFILE.id,
      followHost: true,
    });
  });

  it("disables everything while saving", async () => {
    answerPreviews({ [link(A)]: ready(A) });
    const saving = deferred<Awaited<ReturnType<typeof importVideosAction>>>();
    importAction.mockReturnValue(saving.promise);
    const { textarea } = openDialog();
    await findVideos(textarea, link(A));
    await screen.findByRole("button", { name: "Add 1 video" });

    fireEvent.click(screen.getByRole("button", { name: "Add 1 video" }));

    const busy = await screen.findByRole("button", { name: "Adding…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
    expect(checkboxOf("Episode aaaaaaaaaaa").disabled).toBe(true);
    expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(true);
    // A second press cannot start a second import.
    fireEvent.click(busy);
    expect(importAction).toHaveBeenCalledTimes(1);

    await act(async () =>
      saving.resolve({ ok: true, results: [{ url: link(A), status: "added", videoId: A }] }),
    );
  });

  it("stays open when some fail, keeps the saved ones marked Added, and retries the rest", async () => {
    answerPreviews({ [link(A)]: ready(A), [link(B)]: ready(B), [link(C)]: ready(C) });
    importAction.mockResolvedValueOnce({
      ok: true,
      results: [
        { url: link(A), status: "added", videoId: A },
        {
          url: link(B),
          status: "rejected",
          error: {
            code: "throttled",
            message: "YouTube asked scope to slow down.",
            retryable: true,
          },
        },
        {
          url: link(C),
          status: "rejected",
          error: {
            code: "no_english_captions",
            message: "No original English captions are available for this video.",
            retryable: false,
          },
        },
      ],
    });
    const { textarea, onImported } = openDialog();
    await findVideos(textarea, link(A), link(B), link(C));
    await screen.findByRole("button", { name: "Add 3 videos" });

    fireEvent.click(screen.getByRole("button", { name: "Add 3 videos" }));

    await screen.findByText("Couldn't add: YouTube asked scope to slow down.");
    expect(within(rowOf("Episode aaaaaaaaaaa")).getByText("Added")).toBeTruthy();
    expect(screen.queryByText(/Added \d+ videos? to/)).toBeNull();
    // A final answer is no longer retryable: the row turns into a rejected one.
    const rejected = rowOf("Episode ccccccccccc");
    expect(
      within(rejected).getByText(
        "Rejected: No original English captions are available for this video.",
      ),
    ).toBeTruthy();
    expect(checkboxOf("Episode ccccccccccc").disabled).toBe(true);
    expect(within(rejected).queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(onImported).toHaveBeenCalledTimes(1);

    importAction.mockResolvedValueOnce({
      ok: true,
      results: [{ url: link(B), status: "added", videoId: B }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry adding Episode bbbbbbbbbbb" }));

    await screen.findByText("Added 2 videos to Luke Belmar's Other videos.");
    expect(importAction).toHaveBeenLastCalledWith([link(B)], {
      profileId: PROFILE.id,
      followHost: false,
    });
    expect(onImported).toHaveBeenCalledTimes(2);
  });

  it("keeps the rows and shows the message when the whole request fails", async () => {
    answerPreviews({ [link(A)]: ready(A) });
    importAction.mockResolvedValue({
      ok: false,
      message: "The videos could not be added to your library. Please try again.",
    });
    const { textarea, onImported } = openDialog();
    await findVideos(textarea, link(A));
    await screen.findByRole("button", { name: "Add 1 video" });

    fireEvent.click(screen.getByRole("button", { name: "Add 1 video" }));

    await screen.findByText("The videos could not be added to your library. Please try again.");
    expect(onImported).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: "Add 1 video" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("AddVideosDialog: closing", () => {
  it("ignores lookups that finish after the dialog was closed", async () => {
    const pending = deferred<PreviewResult>();
    previewAction.mockReturnValue(pending.promise);
    const { textarea } = openDialog();
    await findVideos(textarea, link(A));
    expect(screen.getByText("Checking…")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => pending.resolve(ready(A)));

    // Nothing landed in the dialog: it is back to an empty paste step.
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Pasted videos", hidden: true })).toBeNull(),
    );
    expect(screen.queryByText("Ready")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add videos" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "Paste video links, one per line or all at once",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("");
  });

  it("stops starting new lookups once closed", async () => {
    const pending: Array<ReturnType<typeof deferred<PreviewResult>>> = [];
    previewAction.mockImplementation(() => {
      const entry = deferred<PreviewResult>();
      pending.push(entry);
      return entry.promise;
    });
    const { textarea } = openDialog();
    await findVideos(textarea, link(A), link(B), link(C), link(D));
    await waitFor(() => expect(previewAction).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => pending[0].resolve(ready(A)));

    expect(previewAction).toHaveBeenCalledTimes(3);
  });
});
