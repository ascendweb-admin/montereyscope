// @vitest-environment happy-dom
/**
 * In the full-screen chat, a citation to a video someone appears in on another
 * person's channel reads "{person} on {channel}", built from the picker's
 * library data; a channel's own video reads as it always did.
 */
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackgroundChatProvider } from "@/components/ai/background-chat";
import { ChatWorkspace, type ChatWorkspaceVideo } from "@/app/chat/chat-view";

const render = (element: ReactElement) => rtlRender(element, { wrapper: BackgroundChatProvider });

vi.mock("next/navigation", () => ({
  usePathname: () => "/chat",
  useRouter: () => ({ push: vi.fn() }),
}));

const GUEST: ChatWorkspaceVideo = {
  id: "guestVid0001",
  creatorId: 99,
  title: "The big interview",
  creatorName: "Luke Belmar",
  featuredProfileId: 5,
  featuredName: "Luke Belmar",
  hostName: "PBD Podcast",
  platform: "youtube",
  thumbnailUrl: null,
  categoryIds: [],
};
const OWN: ChatWorkspaceVideo = {
  id: "ownVideo0001",
  creatorId: 1,
  title: "A plain upload",
  creatorName: "Dana Writer",
  featuredProfileId: null,
  featuredName: null,
  hostName: null,
  platform: "youtube",
  thumbnailUrl: null,
  categoryIds: [],
};

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

function openThread(videoId: string) {
  const thread = {
    id: 7,
    title: "A question",
    codexSessionId: "session-7",
    videoIds: [videoId],
    mode: "quick",
    createdAt: new Date().toISOString(),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/ai/chat/threads") return jsonResponse({ threads: [] });
      if (url === "/api/ai/chat/threads/7") {
        return jsonResponse({
          thread,
          messages: [
            { id: 1, threadId: 7, role: "user", content: "A question" },
            {
              id: 2,
              threadId: 7,
              role: "assistant",
              content: `A finding from \`transcripts/${videoId}.txt\`.`,
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  render(
    <ChatWorkspace
      videos={[GUEST, OWN]}
      categories={[]}
      initialThreads={[
        {
          id: 7,
          title: "A question",
          videoIds: [videoId],
          messageCount: 2,
          mode: "quick",
          createdAt: thread.createdAt,
          lastMessageAt: thread.createdAt,
        },
      ]}
      initialThreadId={7}
      initialVideoIds={[]}
    />,
  );
}

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
  window.history.replaceState(null, "", "/chat");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ChatWorkspace citations", () => {
  it("cites an appearance as the person on the channel that hosts it", async () => {
    openThread(GUEST.id);
    const pill = await waitFor(() => screen.getByLabelText(/The big interview/));
    act(() => {
      fireEvent.focus(pill);
    });
    expect(pill.getAttribute("aria-label")).toContain("by Luke Belmar on PBD Podcast");
    expect(screen.getByText("on PBD Podcast")).toBeTruthy();
  });

  it("cites a channel's own video as it always did", async () => {
    openThread(OWN.id);
    const pill = await waitFor(() => screen.getByLabelText(/A plain upload/));
    act(() => {
      fireEvent.focus(pill);
    });
    expect(pill.getAttribute("aria-label")).toContain("by Dana Writer");
    expect(pill.getAttribute("aria-label")).not.toContain(" on ");
    expect(screen.queryByText(/^on /)).toBeNull();
  });
});
