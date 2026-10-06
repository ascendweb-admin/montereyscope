// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clipboardApiAvailable, copyTextToClipboard } from "@/lib/clipboard";

/**
 * Clipboard behavior matters for the one-click copy promise: the API path,
 * the legacy fallback, and — critically — a clean failure outcome that keeps
 * the transcript on screen instead of throwing.
 */

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

function stubClipboardApi(writeText: unknown): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

beforeEach(() => {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
  if (originalExecCommand) {
    Object.defineProperty(document, "execCommand", originalExecCommand);
  } else {
    // @ts-expect-error removing the polyfill
    delete document.execCommand;
  }
  vi.restoreAllMocks();
});

describe("copyTextToClipboard", () => {
  it("uses the async Clipboard API when available and permitted", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboardApi(writeText);

    const outcome = await copyTextToClipboard("hello transcript");
    expect(outcome).toBe("clipboard_api");
    expect(writeText).toHaveBeenCalledWith("hello transcript");
  });

  it("falls back to execCommand when the API rejects (permission denied)", async () => {
    stubClipboardApi(vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")));
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    const outcome = await copyTextToClipboard("fallback please");
    expect(outcome).toBe("fallback");
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("returns failed — never throws — when every path is blocked", async () => {
    stubClipboardApi(vi.fn().mockRejectedValue(new Error("denied")));
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });

    await expect(copyTextToClipboard("do not throw")).resolves.toBe("failed");
  });

  it("returns failed when the legacy fallback itself throws", async () => {
    stubClipboardApi(vi.fn().mockRejectedValue(new Error("denied")));
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockImplementation(() => {
        throw new Error("no legacy support");
      }),
    });

    await expect(copyTextToClipboard("still do not throw")).resolves.toBe("failed");
  });

  it("treats an insecure context (plain http LAN access) via the fallback path", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    const writeText = vi.fn();
    stubClipboardApi(writeText);
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    const outcome = await copyTextToClipboard("insecure context");
    expect(outcome).toBe("fallback");
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("clipboardApiAvailable", () => {
  it("is false when navigator.clipboard is absent", () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    expect(clipboardApiAvailable()).toBe(false);
  });
});
