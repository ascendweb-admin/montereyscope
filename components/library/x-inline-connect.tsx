"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { requestXConnection, xLoginPending } from "@/lib/x/connection-client";
import { X_UNAVAILABLE_STATUS, type XConnectionStatus } from "@/lib/x/model";

export function XInlineConnect({
  onConnected,
  purpose = "link",
}: {
  onConnected: () => void;
  /** What resumes after connecting; only changes the guidance copy. */
  purpose?: "link" | "search";
}) {
  const [status, setStatus] = useState<XConnectionStatus>(X_UNAVAILABLE_STATUS);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const connectedCallback = useRef(onConnected);
  useEffect(() => {
    connectedCallback.current = onConnected;
  }, [onConnected]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const before = generation.current;
      try {
        const next = await requestXConnection("status");
        if (!disposed && before === generation.current) {
          setStatus(next);
          if (next.capability === "connected") {
            connectedCallback.current();
            return;
          }
        }
      } catch {
        /* The controls allow a retry. */
      }
      if (!disposed) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  const run = async (action: "connect" | "cancel" | "focus" | "retry-storage") => {
    generation.current++;
    setBusy(true);
    setMessage(null);
    try {
      const next = await requestXConnection(action);
      setStatus(next);
      if (next.capability === "connected") connectedCallback.current();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "X could not connect.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <p role="status">
        {message ??
          (status.restoring
            ? "Restoring your saved X login…"
            : xLoginPending(status)
              ? purpose === "search"
                ? "Finish signing in in the X window. Your search runs as soon as X connects."
                : "Finish signing in in the X window. Your link and categories stay here."
              : status.capability === "unavailable"
                ? "Connect X in the desktop app. If its worker is missing, repair or update the app."
                : purpose === "search"
                  ? "Connect X to search accounts. Your search runs as soon as X connects."
                  : "Connect X, then resolve this link again. Your link and categories stay here.")}
      </p>
      {xLoginPending(status) && !status.restoring ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => void run("focus")}>
            Show X window
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void run("cancel")}>
            Cancel sign-in
          </Button>
        </div>
      ) : status.phase === "error" && status.storage?.state === "saved" ? (
        <Button type="button" disabled={busy} onClick={() => void run("retry-storage")}>
          Retry connection
        </Button>
      ) : status.capability !== "unavailable" && !status.restoring ? (
        <Button type="button" disabled={busy} onClick={() => void run("connect")}>
          Connect X
        </Button>
      ) : null}
    </div>
  );
}
