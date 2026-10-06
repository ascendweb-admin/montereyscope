"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary for failures that take down the root layout itself.
 * It must render its own <html>/<body>. Kept intentionally unstyled beyond
 * inline attributes so it renders even when the stylesheet failed to load.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          background: "#ffffff",
          color: "#171717",
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
        }}
      >
        <main role="alert" style={{ maxWidth: "28rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>scope could not load</h1>
          <p style={{ fontSize: "0.875rem", lineHeight: 1.6, color: "#525252" }}>
            An unexpected problem stopped the app from rendering. Your saved creators and cached
            data on this machine are unaffected. Retry below; if it keeps failing, restart scope
            from your terminal.
          </p>
          {error.digest ? (
            <p style={{ fontSize: "0.75rem", color: "#737373" }}>Reference: {error.digest}</p>
          ) : null}
          <button
            type="button"
            onClick={() => retry()}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 1.25rem",
              fontSize: "0.875rem",
              borderRadius: "0.375rem",
              border: "1px solid #d4d4d4",
              background: "#171717",
              color: "#fafafa",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
