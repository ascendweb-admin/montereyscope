// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { BackgroundChatProvider, useBackgroundChat } from "@/components/ai/background-chat";
import { getTasks, runBackgroundTask } from "@/components/background/task-store";

function Chat({ onCreated }: { onCreated?: (id: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const engine = useBackgroundChat({
    scope: ["vid0000001"],
    scrollerRef: ref,
    onThreadCreated: onCreated,
  });
  return (
    <div>
      <button onClick={() => engine.send("Question")}>Send question</button>
      <button onClick={() => void engine.openThread(71)}>Open running thread</button>
      <button onClick={() => engine.startNewChat()}>New conversation</button>
      <button onClick={engine.stop}>Stop answer</button>
      <span>{engine.generating ? "Generating" : "Idle"}</span>
      {engine.messages.map((message) => (
        <p key={message.id}>{message.content}</p>
      ))}
    </div>
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function streamResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body),
    push(event: object) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    close() {
      controller.close();
    },
  };
}

describe("background work across page lifetimes", () => {
  it("continues a chat with no page mounted, avoids stale navigation callbacks, and reattaches its live answer", async () => {
    const stream = streamResponse();
    let signal: AbortSignal | null | undefined;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return stream.response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const onCreated = vi.fn();
    const view = render(
      <BackgroundChatProvider>
        <Chat onCreated={onCreated} />
      </BackgroundChatProvider>,
    );
    fireEvent.click(screen.getByText("Send question"));
    await waitFor(() => expect(screen.getByText("Generating")).toBeTruthy());
    view.rerender(
      <BackgroundChatProvider>
        <p>Another page</p>
      </BackgroundChatProvider>,
    );
    await act(async () => {
      stream.push({ type: "thread", threadId: 71, created: true });
      stream.push({ type: "delta", text: "Answer while browsing" });
    });
    expect(signal?.aborted).toBe(false);
    expect(onCreated).not.toHaveBeenCalled();
    expect(
      getTasks().some((task) => task.href === "/chat?thread=71" && task.status === "running"),
    ).toBe(true);
    view.rerender(
      <BackgroundChatProvider>
        <Chat />
      </BackgroundChatProvider>,
    );
    fireEvent.click(screen.getByText("Open running thread"));
    await waitFor(() => expect(screen.getByText("Answer while browsing")).toBeTruthy());
    expect(screen.getByText("Generating")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      stream.push({ type: "done", threadId: 71, assistantMessageId: 2, sessionId: null });
      stream.close();
    });
    await waitFor(() => expect(screen.getByText("Idle")).toBeTruthy());
  });

  it("starts another conversation while the previous answer keeps running", async () => {
    const first = streamResponse();
    const second = streamResponse();
    const signals: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init?: RequestInit) => {
        signals.push(init?.signal);
        return signals.length === 1 ? first.response : second.response;
      }),
    );
    render(
      <BackgroundChatProvider>
        <Chat />
      </BackgroundChatProvider>,
    );
    fireEvent.click(screen.getByText("Send question"));
    await waitFor(() => expect(screen.getByText("Generating")).toBeTruthy());
    fireEvent.click(screen.getByText("New conversation"));
    await waitFor(() => expect(screen.getByText("Idle")).toBeTruthy());
    fireEvent.click(screen.getByText("Send question"));
    await waitFor(() => expect(signals.length).toBe(2));
    expect(signals[0]?.aborted).toBe(false);
    fireEvent.click(screen.getByText("Stop answer"));
    expect(signals[1]?.aborted).toBe(true);
    expect(signals[0]?.aborted).toBe(false);
    await act(async () => {
      first.push({ type: "done", threadId: 71 });
      first.close();
      second.close();
    });
  });

  it("deduplicates work and retains completion and failures after the initiating view disappears", async () => {
    let resolve!: (result: { ok: boolean }) => void;
    const work = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((done) => {
          resolve = done;
        }),
    );
    const task = { key: "test:background", label: "Test refresh", href: "/" };
    const promise = runBackgroundTask(task, work);
    const duplicate = runBackgroundTask(task, work);
    expect(duplicate).toBe(promise);
    expect(work).toHaveBeenCalledTimes(1);
    resolve({ ok: true });
    await promise;
    expect(getTasks().find((item) => item.key === task.key)?.status).toBe("done");
    await runBackgroundTask(task, async () => {
      throw new Error("Network lost");
    });
    expect(getTasks().find((item) => item.key === task.key)?.status).toBe("failed");
    expect(getTasks().find((item) => item.key === task.key)?.message).toContain("try again");
  });
});
