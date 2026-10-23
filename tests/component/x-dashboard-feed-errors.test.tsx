// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FeedList } from "@/components/x-dashboard/feed-column";
import { buildFakeTimeline } from "@/lib/x/providers/fake";
import { toTweetViewModel } from "@/lib/x/view-model";
import type { ComponentProps } from "react";

afterEach(cleanup);

it("shows a failed new query instead of silently displaying the previous results", () => {
  const tweet = toTweetViewModel(
    {
      tweet: buildFakeTimeline("qa")[0].tweet,
      timelineKind: "post",
      timelineAt: null,
      savedAt: "2026-10-21T12:00:00Z",
      fetchedAt: "2026-10-21T12:00:00Z",
    },
    1,
  );
  const retry = vi.fn(),
    clear = vi.fn();
  const props: ComponentProps<typeof FeedList> = {
    posts: [
      {
        tweet,
        eventAt: "2026-10-21T12:00:00Z",
        postType: "original",
        provenance: [],
        parentCached: false,
      },
    ],
    total: 1,
    hasMore: false,
    loadingMore: false,
    initialLoading: false,
    stale: false,
    error: null,
    terms: [],
    selection: [],
    syncing: false,
    neverSynced: false,
    xConnected: true,
    hasCreators: true,
    query: "",
    period: "all",
    scrollRoot: { current: null },
    onLoadMore: vi.fn(),
    onRetry: retry,
    onToggleSelect: vi.fn(),
    onAsk: vi.fn(),
    onOpen: vi.fn(),
    onPeriod: vi.fn(),
    onClearQuery: clear,
    onEditList: null,
    onSync: vi.fn(),
  };
  const view = render(<FeedList {...props} />);
  expect(screen.getByRole("article", { name: "Post by Qa" })).toBeTruthy();
  view.rerender(
    <FeedList {...props} query="-unicode" error="Include at least one word to search for." />,
  );
  expect(screen.getByRole("alert").textContent).toContain("Include at least one word");
  expect(screen.queryByRole("article")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(clear).toHaveBeenCalledOnce();
  view.rerender(<FeedList {...props} />);
  expect(screen.getByRole("article")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("asks for a different search instead of a retry when the search text is refused", () => {
  const clear = vi.fn();
  render(
    <FeedList
      posts={[]}
      total={0}
      hasMore={false}
      loadingMore={false}
      initialLoading={false}
      stale={false}
      error="Add at least one word to search for, not only exclusions."
      invalidQuery
      terms={[]}
      selection={[]}
      syncing={false}
      neverSynced={false}
      xConnected
      hasCreators
      query="-unicode"
      period="all"
      scrollRoot={{ current: null }}
      onLoadMore={vi.fn()}
      onRetry={vi.fn()}
      onToggleSelect={vi.fn()}
      onAsk={vi.fn()}
      onOpen={vi.fn()}
      onPeriod={vi.fn()}
      onClearQuery={clear}
      onEditList={null}
      onSync={vi.fn()}
    />,
  );
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Check your search");
  expect(alert.textContent).toContain("Add at least one word");
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(clear).toHaveBeenCalledOnce();
});
