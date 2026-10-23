// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { requestJson, useFeed, type FeedQuery } from "@/components/x-dashboard/use-dashboard-data";

const query: FeedQuery = { creatorIds: [1], period: "all", show: "posts", query: "" };
const emptyPage = { posts: [], page: 1, total: 0, scopeTotal: 0, hasMore: false };
const json = (body: unknown) => new Response(JSON.stringify(body));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reports unreadable successful responses instead of accepting an empty object", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{")),
  );
  await expect(requestJson("/api/test")).rejects.toThrow("unreadable response");
});

it("keeps an aborted response-body read cancelled without poisoning the next feed", async () => {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        body = controller;
      },
    }),
  );
  let finishNext!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(async (_url: string, init: RequestInit) => {
      init.signal!.addEventListener("abort", () =>
        body.error(new DOMException("Cancelled", "AbortError")),
      );
      return response;
    })
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishNext = resolve;
        }),
    );
  vi.stubGlobal("fetch", fetch);
  const view = renderHook(({ value }) => useFeed(value), { initialProps: { value: query } });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  view.rerender({ value: { ...query, query: "new terms" } });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.result.current.posts).toEqual([]);
  expect(view.result.current.error).toBeNull();
  await act(async () => finishNext(json(emptyPage)));
  await waitFor(() => expect(view.result.current.loaded).toBe(true));
  expect(view.result.current.key).toContain("new terms");
});

it("shows a retryable feed error for incomplete JSON and recovers on reload", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce(json({})).mockResolvedValueOnce(json(emptyPage)),
  );
  const view = renderHook(() => useFeed(query));
  await waitFor(() => expect(view.result.current.error).toContain("feed response was incomplete"));
  expect(view.result.current.posts).toEqual([]);
  act(() => view.result.current.reload());
  await waitFor(() => expect(view.result.current.error).toBeNull());
  expect(view.result.current.posts).toEqual([]);
  expect(view.result.current.loaded).toBe(true);
});

it("ignores a valid old response even when the transport does not honor cancellation", async () => {
  let finishOld!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce(json(emptyPage));
  vi.stubGlobal("fetch", fetch);
  const view = renderHook(({ value }) => useFeed(value), { initialProps: { value: query } });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  view.rerender({ value: { ...query, query: "latest" } });
  await waitFor(() => expect(view.result.current.loaded).toBe(true));
  const latestKey = view.result.current.key;
  await act(async () => finishOld(json({ ...emptyPage, total: 99 })));
  expect(view.result.current.key).toBe(latestKey);
  expect(view.result.current.total).toBe(0);
});

it("preserves structured HTTP errors and rejects primitive successful payloads", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Reconnect X." } }), { status: 422 }),
    )
    .mockResolvedValueOnce(json(null));
  vi.stubGlobal("fetch", fetch);
  await expect(requestJson("/api/test")).rejects.toThrow("Reconnect X.");
  await expect(requestJson("/api/test")).rejects.toThrow("invalid response");
});
