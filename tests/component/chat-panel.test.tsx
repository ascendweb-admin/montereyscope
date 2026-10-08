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

import { ChatPanel, type ChatPanelProps } from "@/components/ai/chat-panel";
import { Markdown } from "@/components/ai/markdown";

/**
 * Chat panel behavior tests (stage 4). fetch is mocked at the boundary: the
 * POST /api/ai/chat mock replays the server's SSE protocol (heartbeat
 * comments included) through a ReadableStream body, and the GET endpoints
 * serve JSON. Behavioral only — nothing here asserts on styling.
 *
 * The reveal buffer types text out over a few ticks, so assertions use
 * waitFor with the default timeout.
 */

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

const SCOPE = ["vid0000001"];
const OTHER_SCOPE_VIDEO = "other00001";

const THREADS = [
  {
    id: 7,
    title: "First question?",
    videoIds: SCOPE,
    messageCount: 3,
    mode: "quick",
    createdAt: "2026-08-26T10:00:00.000Z",
    lastMessageAt: "2026-08-26T10:05:00.000Z",
  },
  {
    id: 9,
    title: "A thread from another scope",
    videoIds: [OTHER_SCOPE_VIDEO],
    messageCount: 1,
    mode: "deep",
    createdAt: "2026-08-26T11:00:00.000Z",
    lastMessageAt: "2026-08-26T11:00:00.000Z",
  },
];

const THREAD_SEVEN = {
  thread: {
    id: 7,
    title: "First question?",
    codexSessionId: "session-7",
    videoIds: SCOPE,
    mode: "quick",
    createdAt: "2026-08-26T10:00:00.000Z",
  },
  messages: [
    { id: 1, threadId: 7, role: "system", content: "SEEDED SYSTEM INSTRUCTION" },
    { id: 2, threadId: 7, role: "user", content: "First question?" },
    { id: 3, threadId: 7, role: "assistant", content: "First answer" },
  ],
};

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

function sseResponse(events: object[], signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseText(events)));
      if (signal) {
        // Mirror a real fetch: aborting the request errors the body.
        signal.addEventListener(
          "abort",
          () => controller.error(new Error("The operation was aborted.")),
          { once: true },
        );
      } else {
        controller.close();
      }
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
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

function hangingSse(signal?: AbortSignal | null): Response {
  return sseResponse([], signal);
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
 * happy-dom in this setup ships no localStorage; the panel's mode memory
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
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    throw new Error(`unexpected fetch: ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  installFakeStorage();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function threadListBody(threads: typeof THREADS | unknown[]): Response {
  return jsonResponse({ threads });
}

function routeThreadRequests(list: unknown[] = THREADS, post?: () => Response): void {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/ai/chat/threads") {
      return threadListBody(list);
    }
    if (url.startsWith("/api/ai/chat/threads/")) {
      const id = Number(url.split("/").at(-1));
      if (id === 7) {
        return jsonResponse(THREAD_SEVEN);
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }
    if (url === "/api/ai/chat") {
      if (post) {
        return post();
      }
      throw new Error("POST /api/ai/chat must be scripted by the test");
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function renderPanel(props?: Partial<ChatPanelProps>) {
  const onClose = vi.fn();
  const utils = render(
    <ChatPanel
      open
      onClose={onClose}
      scope={SCOPE}
      description="Grounded in this video's cached transcript."
      {...props}
    />,
  );
  return { onClose, ...utils };
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

describe("ChatPanel — streaming a turn", () => {
  it("streams the answer as it arrives, from working indicator to final text", async () => {
    const stream = controlledSse();
    routeThreadRequests();
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/ai/chat") {
        return stream.response;
      }
      return threadListBody([]);
    });
    renderPanel();

    await sendMessage("Which claims does the video make?");

    stream.push([
      { type: "thread", threadId: 7, created: true },
      { type: "user_message", id: 1, content: "Which claims does the video make?", createdAt: "x" },
      { type: "status", phase: "thinking" },
    ]);

    // Working indicator while codex reasons; user message already visible.
    await waitFor(() => expect(screen.getByText("Reading the transcripts…")).toBeTruthy());
    expect(screen.getByText("Which claims does the video make?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

    stream.push([{ type: "delta", text: "Hello" }]);
    await waitFor(() => expect(screen.getByText(/Hello/)).toBeTruthy());
    expect(screen.queryByText("Reading the transcripts…")).toBeNull();

    stream.push([
      { type: "delta", text: ", world" },
      { type: "message", text: "Hello, world" },
      { type: "done", threadId: 7, assistantMessageId: 2, sessionId: "session-7" },
    ]);
    await waitFor(() => expect(screen.getByText("Hello, world")).toBeTruthy());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();

    const bodies = postBodies();
    expect(bodies).toEqual([
      { videoIds: SCOPE, message: "Which claims does the video make?", mode: "deep" },
    ]);
  });

  it("renders each agent message as its own block (interim + final answers)", async () => {
    const stream = controlledSse();
    routeThreadRequests();
    fetchMock.mockImplementation(async () => stream.response);
    renderPanel();

    await sendMessage("Two parts please");
    stream.push([
      { type: "thread", threadId: 7, created: true },
      { type: "user_message", id: 1, content: "Two parts please", createdAt: "x" },
      { type: "status", phase: "thinking" },
      { type: "message", text: "Part one" },
      { type: "message", text: "Part two" },
      { type: "done", threadId: 7, assistantMessageId: 2, sessionId: null },
    ]);

    await waitFor(() => expect(screen.getByText("Part one")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Part two")).toBeTruthy());
    expect(screen.getByText("Part one").tagName).toBe("P");
    expect(screen.getByText("Part two").tagName).toBe("P");
  });

  it("retracts codex's interim plan message once the real answer arrives", async () => {
    const stream = controlledSse();
    routeThreadRequests();
    fetchMock.mockImplementation(async () => stream.response);
    renderPanel();

    await sendMessage("Summarize in one sentence");
    stream.push([
      { type: "thread", threadId: 7, created: true },
      { type: "user_message", id: 1, content: "Summarize in one sentence", createdAt: "x" },
      { type: "status", phase: "thinking" },
      { type: "message", text: "I'll inspect the transcript headers and content, then summarize." },
      { type: "message_superseded" },
      { type: "message", text: "The final answer." },
      { type: "done", threadId: 7, assistantMessageId: 2, sessionId: null },
    ]);

    await waitFor(() => expect(screen.getByText("The final answer.")).toBeTruthy());
    // The plan paragraph is gone — the answer replaced it.
    await waitFor(() => expect(screen.queryByText(/I'll inspect/)).toBeNull());
  });

  it("renders transcript citations as titled source chips", async () => {
    const stream = controlledSse();
    routeThreadRequests();
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/ai/chat") {
        return stream.response;
      }
      return threadListBody([]);
    });
    renderPanel({
      sources: [{ id: "vid0000001", title: "The Origin of Species", creator: "Charles Darwin" }],
    });

    await sendMessage("What claims does it make?");
    stream.push([
      { type: "thread", threadId: 7, created: true },
      { type: "user_message", id: 1, content: "What claims does it make?", createdAt: "x" },
      {
        type: "message",
        text: "Claim one per `transcripts/vid0000001.txt`, restated in transcripts/vid0000001.txt.",
      },
      { type: "done", threadId: 7, assistantMessageId: 2, sessionId: null },
    ]);

    // One chip per source: the first mention carries it, the repeat is
    // tidied out of the prose (the sentence ends "restated in."). The
    // typewriter reveal trails the SSE, so wait for the tidied tail.
    await waitFor(() => expect(screen.getByRole("log").textContent).toContain("restated in."));
    const log = screen.getByRole("log");
    expect(log.textContent).not.toContain("  ");
    expect(log.textContent).not.toContain("transcripts/");
  });

  it("aborts cleanly when Stop is pressed mid-turn", async () => {
    let seenSignal: AbortSignal | null | undefined;
    routeThreadRequests();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat") {
        seenSignal = init?.signal;
        return hangingSse(init?.signal);
      }
      return threadListBody([]);
    });
    renderPanel();

    await sendMessage("A long question");
    await waitFor(() => expect(screen.getByText("Reading the transcripts…")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
    await waitFor(() => expect(seenSignal?.aborted).toBe(true));
    // A user-initiated stop is quiet: no error alert, no toast.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("The turn was cancelled.")).toBeNull();
  });

  it("surfaces stream errors inline above the composer and restores the draft", async () => {
    const stream = controlledSse();
    routeThreadRequests();
    fetchMock.mockImplementation(async () => stream.response);
    renderPanel();

    await sendMessage("Hello?");
    stream.push([
      { type: "thread", threadId: 7, created: true },
      { type: "user_message", id: 1, content: "Hello?", createdAt: "x" },
      { type: "status", phase: "thinking" },
      {
        type: "error",
        code: "codex_timeout",
        message: "Codex took too long to answer, so the turn was stopped.",
      },
    ]);

    await waitFor(() =>
      expect(
        screen.getByText("Codex took too long to answer, so the turn was stopped."),
      ).toBeTruthy(),
    );
    // One inline alert above the composer (no toast); the user message and
    // draft survive. (The "Hello?" assertion is scoped to the conversation
    // log — happy-dom exposes the textarea's restored draft as text content,
    // which would otherwise also match.)
    expect(within(screen.getByRole("log")).getByText("Hello?")).toBeTruthy();
    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).value).toBe("Hello?");
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("surfaces HTTP failures and drops the optimistic message", async () => {
    routeThreadRequests();
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/ai/chat") {
        return {
          ok: false,
          status: 422,
          json: async () => ({
            error: {
              code: "no_transcripts",
              message:
                "None of the selected videos has a cached transcript. Fetch at least one first.",
            },
          }),
        } as unknown as Response;
      }
      return threadListBody([]);
    });
    renderPanel();

    await sendMessage("Anything?");

    await waitFor(() =>
      expect(
        screen.getByText(
          "None of the selected videos has a cached transcript. Fetch at least one first.",
        ),
      ).toBeTruthy(),
    );
    // The friendly heading replaces the raw error code.
    expect(screen.getByText("No cached sources in this selection.")).toBeTruthy();
    // Nothing was persisted server-side, so the optimistic message goes.
    expect(within(screen.getByRole("log")).queryByText("Anything?")).toBeNull();
    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).value).toBe("Anything?");
  });
});

describe("ChatPanel — thread history", () => {
  it("lists threads for this scope only, reopens one, and continues it", async () => {
    routeThreadRequests(THREADS, () =>
      sseResponse([
        { type: "thread", threadId: 7, created: false },
        { type: "user_message", id: 4, content: "Follow-up?", createdAt: "x" },
        { type: "status", phase: "thinking" },
        { type: "message", text: "Second answer" },
        { type: "done", threadId: 7, assistantMessageId: 5, sessionId: "session-7" },
      ]),
    );
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));

    await waitFor(() => expect(screen.getByText("First question?")).toBeTruthy());
    expect(screen.queryByText("A thread from another scope")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /First question\?/ }));

    await waitFor(() => expect(screen.getByText("First answer")).toBeTruthy());
    expect(screen.getByText("First question?")).toBeTruthy();
    // The seeded instruction stays server-side knowledge.
    expect(screen.queryByText("SEEDED SYSTEM INSTRUCTION")).toBeNull();

    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "Follow-up?" } });
    fireEvent.keyDown(screen.getByLabelText("Your message"), { key: "Enter" });

    await waitFor(() =>
      expect(postBodies()).toEqual([{ threadId: 7, message: "Follow-up?", mode: "quick" }]),
    );
    await waitFor(() => expect(screen.getByText("Second answer")).toBeTruthy());
    // Both turns of the reopened thread stay visible together.
    expect(screen.getByText("First answer")).toBeTruthy();
  });

  it("shows a helpful empty state when this scope has no threads", async () => {
    routeThreadRequests([]);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));

    await waitFor(() =>
      expect(screen.getByText(/No conversations for this selection yet/)).toBeTruthy(),
    );
  });

  it("starts a fresh conversation from history and posts the scope again", async () => {
    routeThreadRequests();
    const stream = controlledSse();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/ai/chat") {
        return stream.response;
      }
      if (url === "/api/ai/chat/threads") {
        return threadListBody(THREADS);
      }
      if (url.startsWith("/api/ai/chat/threads/")) {
        return jsonResponse(THREAD_SEVEN);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));
    await waitFor(() => expect(screen.getByText("First question?")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /First question\?/ }));
    await waitFor(() => expect(screen.getByText("First answer")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));

    await waitFor(() => expect(screen.queryByText("First answer")).toBeNull());
    expect(screen.getByText("Ask about your sources")).toBeTruthy();

    await sendMessage("Brand new question");
    stream.push([
      { type: "thread", threadId: 12, created: true },
      { type: "user_message", id: 5, content: "Brand new question", createdAt: "x" },
      { type: "status", phase: "thinking" },
      { type: "message", text: "Fresh answer" },
      { type: "done", threadId: 12, assistantMessageId: 6, sessionId: "session-12" },
    ]);
    await waitFor(() => expect(screen.getByText("Fresh answer")).toBeTruthy());
    expect(postBodies()).toEqual([
      { videoIds: SCOPE, message: "Brand new question", mode: "quick" },
    ]);
  });

  it("allows history and new chats while a turn is generating", async () => {
    let seenSignal: AbortSignal | null | undefined;
    routeThreadRequests();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat") {
        seenSignal = init?.signal;
        return hangingSse(init?.signal);
      }
      return threadListBody([]);
    });
    renderPanel();

    await sendMessage("Slow turn");
    await waitFor(() => expect(screen.getByText("Reading the transcripts…")).toBeTruthy());

    expect(
      (screen.getByRole("button", { name: "Conversation history" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Start a new chat" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(seenSignal?.aborted).toBe(true));
    expect(
      (screen.getByRole("button", { name: "Conversation history" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("ChatPanel — chrome", () => {
  it("closes via Escape", () => {
    routeThreadRequests();
    const { onClose } = renderPanel();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes via the close button", () => {
    routeThreadRequests();
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("expands to the full-screen chat carrying the fresh scope", () => {
    routeThreadRequests();
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Open full chat view" }));
    expect(pushMock).toHaveBeenCalledWith(`/chat?videos=${SCOPE.join(",")}`);
  });

  it("expands to the full-screen chat carrying the open thread", async () => {
    const stream = controlledSse();
    routeThreadRequests();
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/ai/chat") {
        return stream.response;
      }
      return threadListBody([]);
    });
    renderPanel();

    await sendMessage("Which claims?");
    stream.push([
      { type: "thread", threadId: 7, created: true },
      { type: "user_message", id: 1, content: "Which claims?", createdAt: "x" },
      { type: "done", threadId: 7, assistantMessageId: 2, sessionId: "session-7" },
    ]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Open full chat view" }));
    expect(pushMock).toHaveBeenLastCalledWith("/chat?thread=7");
  });

  it("allows expanding while a turn is generating", async () => {
    let seenSignal: AbortSignal | null | undefined;
    routeThreadRequests();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat") {
        seenSignal = init?.signal;
        return hangingSse(init?.signal);
      }
      return threadListBody([]);
    });
    renderPanel();

    await sendMessage("Slow turn");
    await waitFor(() => expect(screen.getByText("Reading the transcripts…")).toBeTruthy());
    expect(
      (screen.getByRole("button", { name: "Open full chat view" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(seenSignal?.aborted).toBe(true));
    expect(
      (screen.getByRole("button", { name: "Open full chat view" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("ChatPanel — generate report (stage 6)", () => {
  function routeThreadAndReportRequests(
    postReports?: (body: unknown) => Response,
    postChat?: () => Response,
    backend = "codex",
  ): void {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/ai/chat/threads") {
        return threadListBody(THREADS);
      }
      if (url === "/api/settings/ai-backend") {
        return jsonResponse({ value: backend });
      }
      if (url === "/api/ai/chat") {
        if (postChat) {
          return postChat();
        }
        throw new Error("POST /api/ai/chat must be scripted by the test");
      }
      if (url === "/api/ai/reports") {
        if (postReports) {
          return postReports(init?.body ? JSON.parse(String(init.body)) : {});
        }
        throw new Error("POST /api/ai/reports must be scripted by the test");
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  function reportBodies(): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .filter(([url]) => String(url) === "/api/ai/reports")
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
  }

  /** Opens the dialog from the panel header and returns its accessible scope. */
  async function openReportDialog(): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole("button", { name: "Generate report" }));
    const dialog = await screen.findByRole("dialog");
    return dialog;
  }

  it("queues with the remembered options when the user just confirms", async () => {
    routeThreadAndReportRequests((body) => {
      expect(body).toEqual({ videoIds: SCOPE, profile: "balanced", style: "editorial" });
      return jsonResponse({ report: { id: 5, status: "queued" } }, 202);
    });
    renderPanel();

    const dialog = await openReportDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Generate report" }));

    await screen.findByText("Report queued — track it on the Reports page.");
    expect(reportBodies()).toEqual([{ videoIds: SCOPE, profile: "balanced", style: "editorial" }]);
    // The dialog closes once the job is queued.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["codex", "your Codex plan’s usage"],
    ["opencode", "your OpenCode Go usage"],
    ["claude", "your Claude plan’s usage"],
  ])("names the selected provider (%s) in the usage note", async (backend, usage) => {
    routeThreadAndReportRequests(undefined, undefined, backend);
    renderPanel();

    const dialog = await openReportDialog();

    await within(dialog).findByText(new RegExp(usage));
  });

  it("keeps the usage note provider-neutral when the setting cannot be read", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/ai/chat/threads") {
        return threadListBody(THREADS);
      }
      return jsonResponse({ error: { code: "failed" } }, 500);
    });
    renderPanel();

    const dialog = await openReportDialog();

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/settings/ai-backend")).toBe(
        true,
      ),
    );
    expect(within(dialog).getByText(/your AI provider’s usage/)).toBeTruthy();
    expect(within(dialog).queryByText(/Codex/)).toBeNull();
  });

  it("sends the picked profile and style", async () => {
    routeThreadAndReportRequests((body) => {
      expect(body).toEqual({ videoIds: SCOPE, profile: "brief", style: "terminal" });
      return jsonResponse({ report: { id: 8, status: "queued" } }, 202);
    });
    renderPanel();

    const dialog = await openReportDialog();
    fireEvent.click(within(dialog).getByRole("radio", { name: /Brief/ }));
    fireEvent.click(within(dialog).getByRole("radio", { name: /Terminal/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Generate report" }));

    await screen.findByText("Report queued — track it on the Reports page.");
    expect(reportBodies()).toEqual([{ videoIds: SCOPE, profile: "brief", style: "terminal" }]);
  });

  it("passes the open thread's id so the server uses that scope", async () => {
    routeThreadAndReportRequests(
      (body) => {
        expect(body).toEqual({ threadId: 7, profile: "balanced", style: "editorial" });
        return jsonResponse({ report: { id: 6, status: "queued" } }, 202);
      },
      () =>
        sseResponse([
          { type: "thread", threadId: 7, created: true },
          {
            type: "user_message",
            id: 1,
            content: "First question?",
            createdAt: "2026-08-26T10:00:00.000Z",
          },
          { type: "done", threadId: 7, assistantMessageId: 2, sessionId: "session-7" },
        ]),
    );
    renderPanel();
    await sendMessage("First question?");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Generate report" })).toBeTruthy(),
    );

    const dialog = await openReportDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Generate report" }));

    await screen.findByText("Report queued — track it on the Reports page.");
    expect(reportBodies()).toEqual([{ threadId: 7, profile: "balanced", style: "editorial" }]);
  });

  it("surfaces server rejections as an error toast and keeps the dialog open", async () => {
    routeThreadAndReportRequests(() =>
      jsonResponse(
        {
          error: {
            code: "no_transcripts",
            message: "None of the selected videos has a cached transcript.",
          },
        },
        422,
      ),
    );
    renderPanel();

    const dialog = await openReportDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Generate report" }));

    await screen.findByText("None of the selected videos has a cached transcript.");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("is disabled while the scope is empty", () => {
    routeThreadAndReportRequests();
    renderPanel({ scope: [] });

    const button = screen.getByRole("button", { name: "Generate report" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe("ChatPanel — designed failure states (stage 7)", () => {
  it("marks a partial answer as incomplete after Stop and retries it via Ask again", async () => {
    // A controlled stream that also errors the body when the request is
    // aborted, mirroring what a real fetch does on Stop.
    const encoder = new TextEncoder();
    const pushChunks = (events: object[]): void =>
      controller.enqueue(encoder.encode(sseText(events)));
    const failStream = (): void => controller.error(new Error("The operation was aborted."));
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const abortableResponse = {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      }),
    } as unknown as Response;
    routeThreadRequests();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat") {
        init?.signal?.addEventListener("abort", () => failStream(), { once: true });
        return abortableResponse;
      }
      return threadListBody([]);
    });
    renderPanel();

    await sendMessage("Summarize this");
    pushChunks([
      { type: "thread", threadId: 7, created: true },
      { type: "user_message", id: 1, content: "Summarize this", createdAt: "x" },
      { type: "status", phase: "thinking" },
      { type: "delta", text: "The video argues" },
    ]);
    await waitFor(() => expect(screen.getByText(/The video argues/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    // The partial answer stays, clearly marked, with a way to retry — and
    // still no error alert for a deliberate stop.
    await waitFor(() =>
      expect(screen.getByText("Stopped here — this answer may be incomplete.")).toBeTruthy(),
    );
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ask again" }));
    await waitFor(() =>
      expect(postBodies()).toEqual([
        { videoIds: SCOPE, message: "Summarize this", mode: "deep" },
        // The retry continues the thread the first turn created.
        { threadId: 7, message: "Summarize this", mode: "deep" },
      ]),
    );
  });

  it("settles on the authoritative message when it is shorter than the streamed text", async () => {
    // Deltas can outrun the chase buffer, and the completed message that
    // follows may be a slightly shorter authoritative version. The settled
    // block must show that text in full instead of freezing on a prefix.
    const stream = controlledSse();
    routeThreadRequests();
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/ai/chat") {
        return stream.response;
      }
      return threadListBody([]);
    });
    renderPanel();

    await sendMessage("Summarize this");
    stream.push([
      { type: "thread", threadId: 7, created: true },
      { type: "user_message", id: 1, content: "Summarize this", createdAt: "x" },
      { type: "status", phase: "thinking" },
      { type: "delta", text: "The full answer arrives here" },
    ]);
    // Let the chase buffer fully reveal the streamed text first, so the
    // replacement below really is shorter than what is on screen.
    await waitFor(() => expect(screen.getByText("The full answer arrives here")).toBeTruthy());
    stream.push([
      { type: "message", text: "The full answer" },
      { type: "done", threadId: 7, assistantMessageId: 9, sessionId: null },
    ]);

    await waitFor(() => expect(screen.getByText("The full answer")).toBeTruthy());
    expect(screen.queryByText("The full answer arrives here")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
  });

  it("pairs the failure alert with a friendly heading and a Try again action", async () => {
    const stream = controlledSse();
    routeThreadRequests();
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/ai/chat") {
        return stream.response;
      }
      return threadListBody([]);
    });
    renderPanel();

    await sendMessage("Hello?");
    stream.push([
      { type: "thread", threadId: 7, created: true },
      { type: "user_message", id: 1, content: "Hello?", createdAt: "x" },
      { type: "status", phase: "thinking" },
      { type: "delta", text: "Partial ans" },
      {
        type: "error",
        code: "codex_quota_exceeded",
        message: "Codex hit a usage or rate limit. Wait a bit and try again.",
      },
    ]);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Codex hit its usage limit.");
    expect(alert.textContent).toContain(
      "Codex hit a usage or rate limit. Wait a bit and try again.",
    );
    // The partial answer is marked too.
    expect(screen.getByText("Stopped here — this answer may be incomplete.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(postBodies()).toEqual([
        { videoIds: SCOPE, message: "Hello?", mode: "deep" },
        { threadId: 7, message: "Hello?", mode: "deep" },
      ]),
    );
  });

  it("renders server notices as a quiet scope disclosure", async () => {
    const stream = controlledSse();
    routeThreadRequests();
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/ai/chat") {
        return stream.response;
      }
      return threadListBody([]);
    });
    renderPanel();

    await sendMessage("What's covered?");
    stream.push([
      { type: "thread", threadId: 7, created: true },
      { type: "user_message", id: 1, content: "What's covered?", createdAt: "x" },
      {
        type: "notice",
        message:
          "The transcripts for “First video” were cut short to fit the analysis byte budget.",
      },
      { type: "message", text: "Here is the answer." },
      { type: "done", threadId: 7, assistantMessageId: 2, sessionId: "session-7" },
    ]);

    await screen.findByText(
      "The transcripts for “First video” were cut short to fit the analysis byte budget.",
    );
    await waitFor(() => expect(screen.getByText("Here is the answer.")).toBeTruthy());
  });
});

describe("ChatPanel — intelligence modes (stage 8)", () => {
  function modeButtons(): Record<string, HTMLButtonElement> {
    const group = screen.getByRole("group", { name: "Chat mode" });
    const buttons = within(group).queryAllByRole("button");
    const byLabel: Record<string, HTMLButtonElement> = {};
    for (const button of buttons) {
      byLabel[button.textContent ?? ""] = button as HTMLButtonElement;
    }
    return byLabel;
  }

  it("offers Quick, Balanced, and Deep with Deep selected by default", () => {
    routeThreadRequests();
    renderPanel();

    const buttons = modeButtons();
    expect(Object.keys(buttons).sort()).toEqual(["Balanced", "Deep", "Quick"]);
    expect(buttons["Deep"]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons["Quick"]?.getAttribute("aria-pressed")).toBe("false");
    expect(buttons["Balanced"]?.getAttribute("aria-pressed")).toBe("false");
    // Each option explains itself in its tooltip.
    expect(buttons["Quick"]?.getAttribute("title")).toBe("Fast, conversational answers");
  });

  it("sends the selected mode with the turn and shows its working label", async () => {
    // A pending stream keeps the working phase on screen for the assertion.
    const stream = controlledSse();
    routeThreadRequests();
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/ai/chat") {
        return stream.response;
      }
      return threadListBody([]);
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Quick" }));
    expect(screen.getByText("Fast, conversational answers")).toBeTruthy();
    await sendMessage("Hi");

    stream.push([
      { type: "thread", threadId: 3, created: true },
      { type: "user_message", id: 1, content: "Hi", createdAt: "x" },
      { type: "status", phase: "thinking" },
    ]);
    await waitFor(() =>
      expect(postBodies()).toEqual([{ videoIds: SCOPE, message: "Hi", mode: "quick" }]),
    );
    await waitFor(() => expect(screen.getByText("Thinking…")).toBeTruthy());
  });

  it("remembers the selection across panel remounts", async () => {
    routeThreadRequests();
    const { unmount } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Balanced" }));
    expect(window.localStorage.getItem("localtube.chat-mode")).toBe("balanced");
    unmount();

    renderPanel();
    const buttons = modeButtons();
    expect(buttons["Balanced"]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons["Deep"]?.getAttribute("aria-pressed")).toBe("false");
  });

  it("follows the reopened thread's stored mode", async () => {
    routeThreadRequests();
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));
    await waitFor(() => expect(screen.getByText("First question?")).toBeTruthy());
    // The history entry names the mode the thread runs in.
    expect(screen.getByText(/3 messages · Quick ·/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /First question\?/ }));

    await waitFor(() => expect(screen.getByText("First answer")).toBeTruthy());
    // Thread 7 was created in quick mode; the switcher follows it.
    const buttons = modeButtons();
    expect(buttons["Quick"]?.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Fast, conversational answers")).toBeTruthy();
  });
});

describe("Markdown", () => {
  it("joins soft-wrapped lines into one paragraph", () => {
    const { container } = render(<Markdown text={"line one\nline two"} />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("p")?.textContent).toBe("line one line two");
  });

  it("renders unordered and ordered lists", () => {
    const { container } = render(<Markdown text={"- alpha\n- beta\n\n1. one\n2. two"} />);
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.querySelectorAll("ul > li")[0]?.textContent).toBe("alpha");
    expect(container.querySelectorAll("ol > li")[1]?.textContent).toBe("two");
  });

  it("renders bold, italic, and inline code without raw markers", () => {
    const { container } = render(<Markdown text={"**bold** and *italic* and `code()` bits"} />);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
    expect(container.querySelector("code")?.textContent).toBe("code()");
    expect(container.textContent).not.toContain("**");
  });

  it("renders headings as emphasized paragraphs and rules as separators", () => {
    const { container } = render(<Markdown text={"## Heading\n\nBody\n\n---"} />);
    const heading = container.querySelector("p");
    expect(heading?.textContent).toBe("Heading");
    expect(heading?.className).toContain("font-semibold");
    expect(container.querySelector('[role="separator"]')).not.toBeNull();
  });

  it("leaves unmatched asterisks alone", () => {
    const { container } = render(<Markdown text={"2 * 3 = 6"} />);
    expect(container.querySelector("p")?.textContent).toBe("2 * 3 = 6");
    expect(container.querySelector("em")).toBeNull();
  });
});

describe("Markdown — source citations", () => {
  const SOURCES = new Map([
    [
      "abc123XYZ_-",
      {
        id: "abc123XYZ_-",
        title: "Deep Dive on Things",
        creator: "Nova Labs",
        thumbnailUrl: "https://img.example/deep.jpg",
      },
    ],
    ["plainId9", { id: "plainId9", title: "A Video Without a Creator" }],
  ]);

  it("renders backticked transcript paths as creator chips with a hover card", async () => {
    const { container } = render(
      <Markdown text={"Claim one `transcripts/abc123XYZ_-.txt` holds."} sources={SOURCES} />,
    );
    const chip = container.querySelector("span[aria-label]");
    expect(chip?.getAttribute("aria-label")).toBe(
      "Video transcript — Deep Dive on Things by Nova Labs",
    );
    // The pill stays small: the channel rides on it, the full title only in
    // the hover card.
    expect(chip?.textContent).toBe("Nova Labs");
    // Hovering (after the open delay) reveals the full citation: thumbnail,
    // full title, creator.
    fireEvent.mouseEnter(chip!);
    const card = await waitFor(() => {
      const preview = container.querySelector("span[aria-hidden='true']");
      expect(preview?.textContent).toContain("Deep Dive on Things");
      return preview;
    });
    expect(card?.textContent).toContain("Deep Dive on Things");
    expect(card?.textContent).toContain("Nova Labs · Video transcript");
    expect(card?.querySelector("img")?.getAttribute("src")).toBe("https://img.example/deep.jpg");
    fireEvent.mouseLeave(chip!);
    expect(container.querySelector("span[aria-hidden='true']")).toBeNull();
    // The file path never reaches the screen.
    expect(container.textContent).not.toContain("transcripts/");
    expect(container.querySelector("code")).toBeNull();
  });

  it("absorbs parentheses wrapped around a citation", () => {
    const { container } = render(
      <Markdown
        text={"…exchanges such as Kraken (transcripts/abc123XYZ_-.txt)."}
        sources={SOURCES}
      />,
    );
    const chip = container.querySelector("span[aria-label]");
    expect(chip?.textContent).toBe("Nova Labs");
    // The chip is the citation mark: the model's brackets don't double up
    // around it, and the sentence's own period survives.
    expect(container.textContent).not.toContain("(");
    expect(container.textContent?.trimEnd().endsWith(".")).toBe(true);
    expect(container.textContent).not.toContain("transcripts/");
  });

  it("keeps an unbalanced parenthesis as prose", () => {
    const { container } = render(
      <Markdown text={"Impact (transcripts/abc123XYZ_-.txt spans the quarter"} sources={SOURCES} />,
    );
    expect(container.querySelector("span[aria-label]")?.textContent).toBe("Nova Labs");
    // An unclosed "(" is sentence text, not citation punctuation.
    expect(container.textContent).toContain("(");
  });

  it("renders bare transcript paths as citation chips too", () => {
    const { container } = render(
      <Markdown
        text={"Two sources: transcripts/abc123XYZ_-.txt and transcripts/plainId9.txt."}
        sources={SOURCES}
      />,
    );
    const chips = container.querySelectorAll("span[aria-label]");
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toBe("Nova Labs");
    // No creator on record: the pill falls back to the title.
    expect(chips[1]?.getAttribute("aria-label")).toBe(
      "Video transcript — A Video Without a Creator",
    );
    expect(chips[1]?.textContent).toBe("A Video Without a Creator");
    expect(container.textContent).not.toContain("transcripts/");
  });

  it("cites each source once and tidies repeated citations out of the prose", () => {
    const { container } = render(
      <Markdown
        text={
          "First `transcripts/abc123XYZ_-.txt`, then (transcripts/abc123XYZ_-.txt) again.\n\nLater cites transcripts/abc123XYZ_-.txt.\n\n- list cites transcripts/abc123XYZ_-.txt again\n\nLast `transcripts/plainId9.txt` word."
        }
        sources={SOURCES}
      />,
    );
    // One chip per source, at its first mention; every repeat is gone.
    const chips = container.querySelectorAll("span[aria-label]");
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toBe("Nova Labs");
    expect(chips[1]?.textContent).toBe("A Video Without a Creator");
    // The tidied prose stays grammatical: comma joins and final periods
    // survive, with no orphaned brackets or doubled spaces.
    const text = container.textContent ?? "";
    expect(text).toContain("First Nova Labs, then again.");
    expect(text).toContain("Later cites.");
    expect(text).toContain("list cites again");
    expect(text).toContain("Last A Video Without a Creator word.");
    expect(text).not.toContain("  ");
    expect(text).not.toContain("transcripts/");
  });

  it("keeps transcript paths as inline code when the id is not in scope", () => {
    const { container } = render(
      <Markdown text={"Unknown `transcripts/missing01.txt` here."} sources={SOURCES} />,
    );
    expect(container.querySelector("code")?.textContent).toBe("transcripts/missing01.txt");
    expect(container.querySelector("span[aria-label]")).toBeNull();
  });

  it("keeps the plain code rendering when no source index is given", () => {
    const { container } = render(<Markdown text={"See `transcripts/abc123XYZ_-.txt`."} />);
    expect(container.querySelector("code")?.textContent).toBe("transcripts/abc123XYZ_-.txt");
  });

  it("keeps a code span holding several transcript paths as code", () => {
    const { container } = render(
      <Markdown
        text={"Paths `transcripts/abc123XYZ_-.txt and transcripts/plainId9.txt` differ."}
        sources={SOURCES}
      />,
    );
    expect(container.querySelector("code")).not.toBeNull();
  });
});
