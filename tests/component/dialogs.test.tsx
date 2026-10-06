// @vitest-environment happy-dom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppDialog } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * Dialog behavior tests: Escape closes, focus returns to the opener after
 * close (no focus is lost to <body>), and destructive confirms start on the
 * safe action, lock dismissal, and disable the confirm button while work is
 * in flight. Behavioral only — nothing here asserts on styling or layout.
 *
 * happy-dom does not translate an Escape keypress into the native dialog
 * `cancel` event, so tests dispatch that event directly (bubbling, as
 * React's delegated listener expects) — the browser provides this event
 * when a user presses Escape.
 */

afterEach(() => {
  cleanup();
});

function pressEscape(): void {
  document
    .querySelector("dialog")
    ?.dispatchEvent(new window.Event("cancel", { bubbles: true, cancelable: true }));
}

function Harness(props: {
  open: boolean;
  onClose: () => void;
  busy?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <>
      <button type="button" onClick={() => undefined}>
        Opener
      </button>
      <AppDialog open={props.open} onClose={props.onClose} title="Test dialog" busy={props.busy}>
        {props.children}
      </AppDialog>
    </>
  );
}

describe("AppDialog", () => {
  it("opens as a modal and reports itself open", () => {
    render(<Harness open onClose={vi.fn()} />);
    const dialog = document.querySelector("dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.open).toBe(true);
    expect(screen.getByText("Test dialog")).toBeTruthy();
  });

  it("stays closed when open=false", () => {
    render(<Harness open={false} onClose={vi.fn()} />);
    expect(document.querySelector("dialog")?.open).toBe(false);
  });

  it("closes via the Escape path (dialog cancel event) by calling onClose", () => {
    const onClose = vi.fn();
    render(<Harness open onClose={onClose} />);
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape while busy so in-flight work cannot be orphaned", () => {
    const onClose = vi.fn();
    render(<Harness open onClose={onClose} busy />);
    pressEscape();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("restores focus to the opener element after closing", async () => {
    function ToggleHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open dialog
          </button>
          <AppDialog open={open} onClose={() => setOpen(false)} title="Focus dialog">
            <button type="button" onClick={() => setOpen(false)}>
              Done
            </button>
          </AppDialog>
        </>
      );
    }
    render(<ToggleHarness />);

    const opener = screen.getByText("Open dialog");
    opener.focus();

    fireEvent.click(opener);
    expect(document.querySelector("dialog")?.open).toBe(true);

    fireEvent.click(screen.getByText("Done"));
    // The explicit restoration effect runs on a timeout tick.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe(opener);
  });
});

describe("ConfirmDialog", () => {
  function ConfirmHarness(props: { busy: boolean; onConfirm: () => void; onClose: () => void }) {
    return (
      <ConfirmDialog
        open
        onClose={props.onClose}
        onConfirm={props.onConfirm}
        busy={props.busy}
        busyLabel="Clearing…"
        confirmLabel="Clear transcripts"
        cancelLabel="Keep transcripts"
        destructive
        title="Clear all cached transcripts?"
        description="This permanently deletes data."
      >
        <p>Scope explanation.</p>
      </ConfirmDialog>
    );
  }

  it("moves focus to the safe Cancel action for a destructive confirm", async () => {
    render(<ConfirmHarness busy={false} onConfirm={vi.fn()} onClose={vi.fn()} />);
    const cancel = screen.getByRole("button", { name: "Keep transcripts" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe(cancel);
  });

  it("disables both actions while busy and shows the working label", () => {
    const onConfirm = vi.fn();
    render(<ConfirmHarness busy onConfirm={onConfirm} onClose={vi.fn()} />);

    const confirm = screen.getByRole("button", { name: /Clearing…/ });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    const cancel = screen.getByRole("button", { name: "Keep transcripts" });
    expect(cancel.hasAttribute("disabled")).toBe(true);

    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps dismissal locked while busy (Escape and Cancel both inert)", () => {
    const onClose = vi.fn();
    render(<ConfirmHarness busy onConfirm={vi.fn()} onClose={onClose} />);
    pressEscape();
    fireEvent.click(screen.getByRole("button", { name: "Keep transcripts" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("invokes onConfirm exactly once per click when idle", () => {
    const onConfirm = vi.fn();
    render(<ConfirmHarness busy={false} onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear transcripts" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
