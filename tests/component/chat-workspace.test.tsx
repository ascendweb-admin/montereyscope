// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { BackgroundChatProvider } from "@/components/ai/background-chat";
import type { ReactElement } from "react";

const render = (element: ReactElement) => rtlRender(element, { wrapper: BackgroundChatProvider });

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatWorkspace, type ChatWorkspaceThread } from "@/app/chat/chat-view";

/**
 * The full-screen chat workspace: every conversation from every source
 * collection in one sidebar, continuation of old threads, fresh chats with a
 * picked scope, and delete. fetch is mocked at the boundary — the POST
 * /api/ai/chat mock replays the server's SSE protocol through a
 * ReadableStream body, and the GET/DELETE endpoints serve JSON.
 *
 * The reveal buffer types text out over a few ticks, so assertions use
 * waitFor with the default timeout.
 */

const { pathnameMock } = vi.hoisted(() => ({ pathnameMock: vi.fn(() => "/chat") }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
  useRouter: () => ({ push: vi.fn() }),
}));

/** Relative ISO timestamps so the recency buckets stay deterministic. */
function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

const MINUTE = 60_000;
const DAY = 86_400_000;

const THREADS: ChatWorkspaceThread[] = [
  {
    id: 7,
    title: "First question?",
    videoIds: ["vidA000001"],
    messageCount: 3,
    mode: "quick",
    createdAt: isoAgo(3 * DAY),
    lastMessageAt: isoAgo(5 * MINUTE),
  },
  {
    id: 9,
    title: "A conversation from another scope",
    videoIds: ["vidB000001"],
    messageCount: 1,
    mode: "deep",
    createdAt: isoAgo(40 * DAY),
    lastMessageAt: isoAgo(40 * DAY),
  },
];

const THREAD_SEVEN = {
  thread: {
    id: 7,
    title: "First question?",
    codexSessionId: "session-7",
    videoIds: ["vidA000001"],
    mode: "quick",
    createdAt: isoAgo(3 * DAY),
  },
  messages: [
    { id: 1, threadId: 7, role: "system", content: "SEEDED SYSTEM INSTRUCTION" },
    { id: 2, threadId: 7, role: "user", content: "First question?" },
    { id: 3, threadId: 7, role: "assistant", content: "First answer" },
  ],
};

const VIDEOS = [
  {
    id: "vidA000001",
    creatorId: 1,
    title: "Alpha deep dive",
    creatorName: "Alpha Channel",
    thumbnailUrl: null,
    categoryIds: [1],
    hasTranscript: true,
  },
  {
    id: "vidA000002",
    creatorId: 1,
    title: "Alpha quick update",
    creatorName: "Alpha Channel",
    thumbnailUrl: null,
    categoryIds: [1],
    hasTranscript: false,
  },
  {
    id: "vidB000001",
    creatorId: 2,
    title: "Beta interview",
    creatorName: "Beta Channel",
    thumbnailUrl: null,
    categoryIds: [],
    hasTranscript: true,
  },
];

const CATEGORIES = [{ id: 1, name: "Technology", color: "sky" as const, creatorCount: 1 }];

function sseText(events: object[]): string {
  // A heartbeat comment is mixed in to prove the parser ignores them.
  return (
    events
      .map(
        (event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join("") + ": ping\n\n"
  );
}

interface ControlledStream {
  response: Response;
  push: (events: object[]) => void;
  close: () => void;
}

/** A stream the test extends over time, to watch rendering arrive in steps. */
function controlledSse(): ControlledStream {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: { ok: true, status: 200, body: stream } as unknown as Response,
    push: (events) => controller.enqueue(encoder.encode(sseText(events))),
    close: () => controller.close(),
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

/**
 * happy-dom in this setup ships no localStorage; the engine's mode memory
 * needs one. Fresh per test, so selections never leak between tests.
 */
function installFakeStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    },
  });
}

beforeEach(() => {
  // Refresh the relative fixture so a suite running across local midnight
  // still has a thread in the Today bucket.
  THREADS[0].lastMessageAt = new Date().toISOString();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    throw new Error(`unexpected fetch: ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  installFakeStorage();
  window.history.replaceState(null, "", "/chat");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderWorkspace(props?: Partial<Parameters<typeof ChatWorkspace>[0]>) {
  return render(
    <ChatWorkspace
      videos={VIDEOS}
      categories={CATEGORIES}
      initialThreads={THREADS}
      initialThreadId={null}
      initialVideoIds={[]}
      {...props}
    />,
  );
}

function routeThreads(): void {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/ai/chat/threads") {
      return jsonResponse({ threads: THREADS });
    }
    if (url === "/api/ai/chat/threads/7") {
      return jsonResponse(THREAD_SEVEN);
    }
    if (url.startsWith("/api/ai/chat/threads/") && init?.method === "DELETE") {
      return jsonResponse({ deleted: true });
    }
    if (url === "/api/ai/chat") {
      throw new Error("POST /api/ai/chat must be scripted by the test");
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

async function sendMessage(text: string): Promise<void> {
  fireEvent.change(screen.getByLabelText("Your message"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

function postBodies(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url) === "/api/ai/chat")
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

describe("ChatWorkspace — history sidebar", () => {
  it("lists every conversation across every scope, bucketed by recency", async () => {
    renderWorkspace();

    // The point of the workspace: chats from other source collections are
    // visible here, not filtered behind the current selection.
    expect(screen.getByText("First question?")).toBeTruthy();
    expect(screen.getByText("A conversation from another scope")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Today")).toBeTruthy());
    expect(screen.getByText("Older")).toBeTruthy();
    // The scoped view of the same library would have hidden thread 9.
    expect(screen.queryByText("Pick sources to ground the answers")).toBeTruthy();
  });

  it("opens a past conversation and continues it in place", async () => {
    routeThreads();
    const stream = controlledSse();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/ai/chat") {
        return stream.response;
      }
      if (url === "/api/ai/chat/threads") {
        return jsonResponse({ threads: THREADS });
      }
      if (url === "/api/ai/chat/threads/7") {
        return jsonResponse(THREAD_SEVEN);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    renderWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "First question?" }));

    await waitFor(() => expect(screen.getByText("First answer")).toBeTruthy());
    // The thread title shows in the header and the first user message in the
    // log; the seeded instruction stays server-side knowledge.
    expect(screen.getByText("First question?", { selector: "h2" })).toBeTruthy();
    expect(within(screen.getByRole("log")).getByText("First question?")).toBeTruthy();
    expect(screen.queryByText("SEEDED SYSTEM INSTRUCTION")).toBeNull();

    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "Follow-up?" } });
    fireEvent.keyDown(screen.getByLabelText("Your message"), { key: "Enter" });

    await waitFor(() =>
      expect(postBodies()).toEqual([{ threadId: 7, message: "Follow-up?", mode: "quick" }]),
    );
    stream.push([
      { type: "thread", threadId: 7, created: false },
      { type: "user_message", id: 4, content: "Follow-up?", createdAt: "x" },
      { type: "message", text: "Second answer" },
      { type: "done", threadId: 7, assistantMessageId: 5, sessionId: "session-7" },
    ]);
    await waitFor(() => expect(screen.getByText("Second answer")).toBeTruthy());
    expect(screen.getByText("First answer")).toBeTruthy();
  });

  it("starts a fresh chat that stays disabled until sources are picked", async () => {
    routeThreads();
    renderWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "First question?" }));
    await waitFor(() => expect(screen.getByText("First answer")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: "New chat" })[0]);

    await waitFor(() => expect(screen.queryByText("First answer")).toBeNull());
    expect(screen.getByText("What would you like to research?")).toBeTruthy();
    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).disabled).toBe(true);
  });
});

describe("ChatWorkspace — picking sources for a fresh chat", () => {
  it("narrows source groups with category filters", async () => {
    renderWorkspace();
    fireEvent.click(screen.getAllByRole("button", { name: "Choose sources" })[0]);
    const dialog = await screen.findByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "Technology 1" }));
    expect(within(dialog).getByRole("region", { name: "Alpha Channel" })).toBeTruthy();
    expect(within(dialog).queryByRole("region", { name: "Beta Channel" })).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "All" }));
    expect(within(dialog).getByRole("region", { name: "Beta Channel" })).toBeTruthy();
  });

  it("opens the picker, refuses transcript-less rows, and confirms a scope", async () => {
    routeThreads();
    const stream = controlledSse();
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/ai/chat") {
        return stream.response;
      }
      return jsonResponse({ threads: THREADS });
    });
    renderWorkspace();

    fireEvent.click(screen.getAllByRole("button", { name: "Choose sources" })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Choose sources")).toBeTruthy();

    // The picker defaults to ready sources; reveal unavailable rows to verify
    // they remain visible-but-disabled when that convenience filter is off.
    fireEvent.click(within(dialog).getByRole("button", { name: "Ready for analysis" }));
    const noTranscript = within(dialog).getByRole("checkbox", {
      name: "Select Alpha quick update",
    }) as HTMLInputElement;
    expect(noTranscript.disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Select Alpha deep dive" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Use 1 source" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Ready to chat about 1 source")).toBeTruthy();
    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).disabled).toBe(false);

    await sendMessage("Summarize the deep dive");
    stream.push([
      { type: "thread", threadId: 12, created: true },
      { type: "user_message", id: 1, content: "Summarize the deep dive", createdAt: "x" },
      { type: "status", phase: "thinking" },
      { type: "message", text: "Here is the summary." },
      { type: "done", threadId: 12, assistantMessageId: 2, sessionId: "session-12" },
    ]);
    await waitFor(() => expect(screen.getByText("Here is the summary.")).toBeTruthy());
    expect(postBodies()).toEqual([
      { videoIds: ["vidA000001"], message: "Summarize the deep dive", mode: "deep" },
    ]);
    // A created conversation lands in the address bar.
    await waitFor(() => expect(window.location.search).toBe("?thread=12"));
  });

  it("prefills the scope from the collapsed panel's expand (?videos=)", async () => {
    routeThreads();
    const stream = controlledSse();
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/ai/chat") {
        return stream.response;
      }
      return jsonResponse({ threads: THREADS });
    });
    renderWorkspace({ initialVideoIds: ["vidB000001", "vidA000001"] });

    await waitFor(() => expect(screen.getByText("Ready to chat about 2 sources")).toBeTruthy());
    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).disabled).toBe(false);

    await sendMessage("Compare both videos");
    stream.push([
      { type: "thread", threadId: 13, created: true },
      { type: "user_message", id: 1, content: "Compare both videos", createdAt: "x" },
      { type: "done", threadId: 13, assistantMessageId: 2, sessionId: null },
    ]);
    await waitFor(() =>
      expect(postBodies()).toEqual([
        { videoIds: ["vidB000001", "vidA000001"], message: "Compare both videos", mode: "deep" },
      ]),
    );
  });

  it("drops ids the library no longer knows from a preselected scope", () => {
    routeThreads();
    renderWorkspace({ initialVideoIds: ["vidA000001", "gone0000001"] });

    expect(screen.getByText("Ready to chat about 1 source")).toBeTruthy();
  });
});

describe("ChatWorkspace — deleting conversations", () => {
  it("removes a past conversation after confirmation", async () => {
    routeThreads();
    renderWorkspace();

    fireEvent.click(
      screen.getByRole("button", { name: "Delete A conversation from another scope" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete this conversation?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete conversation" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.queryByText("A conversation from another scope")).toBeNull());
    expect(screen.getByText("First question?")).toBeTruthy();

    const deletes = fetchMock.mock.calls.filter(
      ([url, init]) => String(url) === "/api/ai/chat/threads/9" && init?.method === "DELETE",
    );
    expect(deletes).toHaveLength(1);
  });

  it("deleting the open conversation returns to a fresh chat", async () => {
    routeThreads();
    renderWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "First question?" }));
    await waitFor(() => expect(screen.getByText("First answer")).toBeTruthy());
    expect(window.location.search).toBe("?thread=7");

    fireEvent.click(screen.getByRole("button", { name: "Delete First question?" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete conversation" }));

    await waitFor(() => expect(screen.queryByText("First answer")).toBeNull());
    expect(screen.getByText("What would you like to research?")).toBeTruthy();
    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).disabled).toBe(true);
    expect(window.location.search).toBe("");
  });
});

describe("ChatWorkspace — search", () => {
  it("narrows the sidebar without touching the open conversation", async () => {
    routeThreads();
    renderWorkspace();

    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "another" },
    });

    await waitFor(() => expect(screen.queryByText("First question?")).toBeNull());
    expect(screen.getByText("A conversation from another scope")).toBeTruthy();
  });
});

describe("ChatWorkspace — collapsible history sidebar", () => {
  beforeEach(() => {
    window.localStorage.removeItem("localtube.chat-sidebar-collapsed");
  });

  it("collapses the history list for a full-width canvas and restores it", async () => {
    routeThreads();
    renderWorkspace();
    await waitFor(() => expect(screen.getByRole("region", { name: "Today" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Hide conversation list" }));

    await waitFor(() => expect(screen.queryByRole("region", { name: "Today" })).toBeNull());
    expect(window.localStorage.getItem("localtube.chat-sidebar-collapsed")).toBe("true");
    expect(screen.getByRole("button", { name: "Show conversation list" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show conversation list" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Today" })).toBeTruthy());
    expect(window.localStorage.getItem("localtube.chat-sidebar-collapsed")).toBe("false");
  });

  it("starts collapsed when the remembered preference says so", async () => {
    routeThreads();
    window.localStorage.setItem("localtube.chat-sidebar-collapsed", "true");
    renderWorkspace();

    await waitFor(() => expect(screen.queryByRole("region", { name: "Today" })).toBeNull());
    expect(screen.getByRole("button", { name: "Show conversation list" })).toBeTruthy();
  });
});
