// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TweetDetailDialog } from "@/components/channel/tweet-card";
import { fetchTweetsAction } from "@/components/background/operations";
import { getTweetDetailAction } from "@/app/actions/x";
import { buildFakeTimeline } from "@/lib/x/providers/fake";
import { toTweetViewModel } from "@/lib/x/view-model";
import type { CreatorTweetRecord } from "@/lib/x/repository";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/components/background/operations", () => ({ fetchTweetsAction: vi.fn() }));
vi.mock("@/app/actions/x", () => ({ getTweetDetailAction: vi.fn() }));

const record: CreatorTweetRecord = {
  tweet: buildFakeTimeline("qa")[0].tweet,
  timelineKind: "post",
  timelineAt: null,
  savedAt: "2026-10-21T10:00:00Z",
  fetchedAt: "2026-10-21T10:00:00Z",
};
const complete = toTweetViewModel(record, 2);
const partial = {
  ...complete,
  text: "Preview",
  contentStatus: "summary" as const,
  readyForAnalysis: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchTweetsAction).mockResolvedValue({ ok: true });
  vi.mocked(getTweetDetailAction).mockResolvedValue({ ok: true, tweet: record });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("recovers partial text in place and updates the host", async () => {
  const updated = vi.fn();
  render(<TweetDetailDialog tweet={partial} open onClose={() => {}} onUpdated={updated} />);
  fireEvent.click(screen.getByRole("button", { name: "Fetch full text" }));
  await waitFor(() => expect(screen.getByText("Complete text")).toBeTruthy());
  expect(fetchTweetsAction).toHaveBeenCalledWith(2, [partial.id]);
  expect(updated).toHaveBeenCalledWith(complete);
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Fetch full text" })).toBeNull();
});

it("keeps unavailable posts recoverable with honest feedback", async () => {
  vi.mocked(getTweetDetailAction).mockResolvedValue({
    ok: true,
    tweet: { ...record, tweet: { ...record.tweet, text: "", contentStatus: "unavailable" } },
  });
  render(<TweetDetailDialog tweet={partial} open onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Fetch full text" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "X did not return the full text. You can try again or open the post on X.",
  );
  expect(screen.getByRole("button", { name: "Fetch full text" })).toBeTruthy();
});

it("preserves the preview and permits retry after a fetch failure", async () => {
  vi.mocked(fetchTweetsAction).mockResolvedValue({
    ok: false,
    message: "Connect X to fetch this post.",
  });
  render(<TweetDetailDialog tweet={partial} open onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Fetch full text" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Connect X to fetch this post.",
  );
  expect(screen.getByText("Preview")).toBeTruthy();
  expect(getTweetDetailAction).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Fetch full text" }).hasAttribute("disabled")).toBe(
    false,
  );
});

it("falls back to the author's initials when their picture no longer loads", () => {
  const tweet = {
    ...complete,
    authorName: "Ada Lovelace",
    authorAvatarUrl: "https://pbs.twimg.com/profile_images/stale.jpg",
  };
  // Still loading when mounted, as in a browser, so the error event decides.
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  const view = render(<TweetDetailDialog tweet={tweet} open onClose={() => {}} />);
  const picture = view.baseElement.querySelector('img[src*="/avatar?v="]');
  expect(picture).toBeTruthy();
  fireEvent.error(picture!);
  expect(view.baseElement.querySelector('img[src*="/avatar?v="]')).toBeNull();
  expect(screen.getByText("AL")).toBeTruthy();
});
