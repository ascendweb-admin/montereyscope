// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackgroundActivity } from "@/components/background/activity";
import { dismissTask, getTasks, updateTask } from "@/components/background/task-store";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
const router = { refresh };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

beforeEach(() => {
  for (const task of getTasks()) {
    updateTask({ ...task, status: "done" });
    dismissTask(task.key);
  }
  refresh.mockClear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"reports":[]}')));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const task = { key: "activity:test", label: "Weekly briefing", href: "/reports" };

describe("BackgroundActivity", () => {
  it("clears finished work without removing running or queued tasks", () => {
    updateTask({ ...task, status: "running" });
    updateTask({ ...task, key: "activity:queued", label: "Next report", status: "queued" });
    updateTask({ ...task, key: "activity:done", label: "Finished report", status: "done" });
    updateTask({
      ...task,
      key: "activity:failed",
      label: "Failed report",
      status: "failed",
      message: "Connection lost",
    });
    render(<BackgroundActivity />);
    fireEvent.click(screen.getByRole("button", { name: "Background activity, 2 active" }));
    const panel = screen.getByRole("dialog", { name: "Activity" });
    expect(within(panel).getByText("Connection lost")).toBeTruthy();
    expect(within(panel).getByText("Completed")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Dismiss Weekly briefing" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Clear finished" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close activity" }));
    expect(
      getTasks()
        .map((item) => item.status)
        .sort(),
    ).toEqual(["queued", "running"]);
    expect(within(panel).queryByText("Recent")).toBeNull();
    expect(within(panel).getByRole("link", { name: "Weekly briefing" })).toBeTruthy();
  });

  it("offers Stop only for active cancellable work and dismisses stopped tasks", () => {
    const cancel = vi.fn(() => updateTask({ ...task, status: "stopped", cancel }));
    updateTask({ ...task, status: "running", cancel });
    render(<BackgroundActivity />);
    fireEvent.click(screen.getByRole("button", { name: "Background activity, 1 active" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop Weekly briefing" }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop Weekly briefing" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Weekly briefing" }));
    expect(screen.getByText("You’re all caught up")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close activity" }));
  });

  it("closes with Escape, outside clicks, and focus leaving the nonmodal panel", () => {
    render(
      <>
        <BackgroundActivity />
        <button>Outside</button>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Background activity" });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close activity" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByText("Outside"));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger);
    act(() => screen.getByText("Outside").focus());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refreshes on completion and shows a dismissible notification that links to the result", async () => {
    updateTask({ ...task, status: "running" });
    render(<BackgroundActivity />);
    await act(async () => {
      updateTask({ ...task, status: "done" });
    });
    expect(refresh).toHaveBeenCalledOnce();
    const notification = await screen.findByRole("status");
    expect(
      within(notification)
        .getByRole("link", { name: "Weekly briefing Completed" })
        .getAttribute("href"),
    ).toBe("/reports");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
