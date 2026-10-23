// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useToast, type ToastAction, type ToastTone } from "@/components/ui/toast";

function Harness({
  message = "Saved.",
  tone = "success",
  action,
}: {
  message?: string;
  tone?: ToastTone;
  action?: ToastAction;
}) {
  const { showToast, toastElement } = useToast();
  return (
    <>
      <button onClick={() => showToast(message, tone, action)}>show</button>
      {toastElement}
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useToast", () => {
  it("shows a message and dismisses it after five seconds", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("show"));
    expect(screen.getByRole("status").textContent).toBe("Saved.");

    act(() => void vi.advanceTimersByTime(4900));
    expect(screen.queryByRole("status")).not.toBeNull();
    act(() => void vi.advanceTimersByTime(200));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows no link unless it is given one", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("show"));
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows an action link that can be reached, and keeps the toast longer for it", () => {
    render(<Harness action={{ label: "View", href: "/creators/7" }} />);
    fireEvent.click(screen.getByText("show"));

    const link = screen.getByRole("link", { name: "View" });
    expect(link.getAttribute("href")).toBe("/creators/7");
    // The toast ignores the pointer, but its link must not.
    expect(link.className).toContain("pointer-events-auto");
    expect(screen.getByRole("status").className).toContain("pointer-events-none");

    act(() => void vi.advanceTimersByTime(5200));
    expect(screen.queryByRole("status")).not.toBeNull();
    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dismisses the toast when its link is followed", () => {
    render(<Harness action={{ label: "View", href: "/creators/7" }} />);
    fireEvent.click(screen.getByText("show"));
    fireEvent.click(screen.getByRole("link", { name: "View" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("drops the previous link when the next toast has none", () => {
    function Two() {
      const { showToast, toastElement } = useToast();
      return (
        <>
          <button onClick={() => showToast("First", "success", { label: "View", href: "/a" })}>
            first
          </button>
          <button onClick={() => showToast("Second", "info")}>second</button>
          {toastElement}
        </>
      );
    }
    render(<Two />);
    fireEvent.click(screen.getByText("first"));
    expect(screen.getByRole("link")).toBeTruthy();
    fireEvent.click(screen.getByText("second"));
    expect(screen.getByRole("status").textContent).toBe("Second");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
