"use client";

/**
 * Clipboard helpers (client-only). Prefers the async browser Clipboard API
 * when the context is secure, and falls back to a hidden textarea +
 * execCommand for plain-http local use. Never throws: callers get a
 * three-way outcome so they can keep the transcript visible and offer a
 * manual-select instruction when copying fails.
 */
export type CopyOutcome = "clipboard_api" | "fallback" | "failed";

export function clipboardApiAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator !== "undefined" &&
    navigator.clipboard !== undefined &&
    typeof navigator.clipboard.writeText === "function"
  );
}

export async function copyTextToClipboard(text: string): Promise<CopyOutcome> {
  if (clipboardApiAvailable()) {
    try {
      await navigator.clipboard.writeText(text);
      return "clipboard_api";
    } catch {
      // Fall through to the legacy path (e.g. permission denied).
    }
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    // Keep it off-screen but focusable/rendered — display:none breaks copy.
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const succeeded = document.execCommand("copy");
    document.body.removeChild(textarea);
    return succeeded ? "fallback" : "failed";
  } catch {
    return "failed";
  }
}
