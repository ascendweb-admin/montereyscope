"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, ShieldCheck, Unplug } from "lucide-react";

import { requestXConnection, xLoginPending } from "@/lib/x/connection-client";
import { XLogo } from "@/components/ui/platform-logos";
import { AlertNote } from "@/components/ui/alert-note";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Spinner } from "@/components/ui/pending";
import { useToast } from "@/components/ui/toast";
import { X_ERROR_MESSAGES, type XConnectionStatus, type XStorageStatus } from "@/lib/x/model";

interface XConnectionCardProps {
  initialStatus: XConnectionStatus;
  cachedTweetCount: number;
}

function storageBody(storage: XStorageStatus): string {
  switch (storage.reason) {
    case "delete_failed":
      return "X is disconnected for this run, but Scope could not remove the saved login. Retry before closing Scope; otherwise it may reconnect next time.";
    case "no_secure_backend":
      return "Scope needs an unlocked system keyring to save your X login. On Omarchy/Linux that is the freedesktop Secret Service, for example gnome-keyring; KDE uses KWallet. Start and unlock it, then retry. If it was installed after Scope started, restart Scope and sign in again.";
    case "service_unavailable":
      return "The system keyring is running but not usable right now. Unlock it, then retry.";
    case "store_locked":
      return "The system keyring is locked. Unlock it, then retry. Your saved login file stays intact.";
    case "decrypt_failed":
      return "The saved login cannot be decrypted with the current keyring. Unlock it and retry; otherwise sign in again to replace the saved login.";
    case "corrupt_payload":
      return "The saved login file is damaged and cannot be restored. Sign in again to replace it; Disconnect removes it.";
    case "file_unreadable":
      return "The saved login file could not be read. Retry, or sign in again to replace it.";
    case "encrypt_failed":
    case "write_failed":
      return "Scope could not save the login to disk. Any previous saved login is untouched. Retry, and check that the disk is not full.";
    case "invalid_payload":
      return "The X session could not be saved in a supported format. Sign in again.";
    default:
      return "Retry when secure storage is available.";
  }
}

function retryLabel(storage: XStorageStatus): string {
  switch (storage.state) {
    case "delete_failed":
      return "Retry removing saved login";
    case "locked":
      return "Unlock & retry";
    case "unreadable":
      return "Retry restore";
    case "save_failed":
    case "not_saved":
      return "Retry saving login";
    default:
      return "Retry secure storage";
  }
}

function StorageNotice({
  storage,
  connected,
  busy,
  onRetry,
}: {
  storage: XStorageStatus;
  connected: boolean;
  busy: boolean;
  onRetry: () => void;
}) {
  if (storage.state === "saved") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck aria-hidden="true" className="size-3.5" />
        Your X login is saved on this device.
      </p>
    );
  }
  if (storage.state === "checking") {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Checking secure storage…
      </p>
    );
  }
  const title =
    storage.state === "delete_failed"
      ? "Saved login could not be removed"
      : storage.reason === "invalid_payload"
        ? "This X session cannot be saved"
        : connected
          ? "Connected, but your login isn't saved yet"
          : "Your X login isn't saved yet";
  return (
    <AlertNote
      tone="warning"
      politeness="polite"
      title={title}
      action={
        <Button variant="outline" size="sm" onClick={onRetry} disabled={busy} aria-busy={busy}>
          {busy ? <Spinner /> : <RefreshCw aria-hidden="true" />}
          {busy ? "Retrying…" : retryLabel(storage)}
        </Button>
      }
    >
      {storageBody(storage)}
    </AlertNote>
  );
}

/**
 * Settings → Sources → X. Independent from AI-provider auth: this controls
 * Scope's read access to X only. A connection is shown only when the
 * provider verified a real identity — cached posts remain readable in every
 * state, and disconnecting never deletes them. Secure-storage state is
 * tracked separately from the connection so a save failure never hides a
 * working session.
 */
export function XConnectionCard({ initialStatus, cachedTweetCount }: XConnectionCardProps) {
  const [status, setStatus] = useState<XConnectionStatus>(initialStatus);
  const [busy, setBusy] = useState<"connect" | "disconnect" | "retry-storage" | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const { showToast, toastElement } = useToast();

  const requestGeneration = useRef(0);
  const connected = status.capability === "connected" && status.user !== null;
  const unavailable = status.capability === "unavailable";
  const restoring = status.restoring === true;
  const pending = xLoginPending(status) && !restoring;
  const storage = status.storage ?? null;
  const canRetryRestore = !connected && status.phase === "error" && storage?.state === "saved";
  const following =
    restoring || pending || (!connected && !unavailable && storage?.state === "checking");

  useEffect(() => {
    if (!following) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const generation = requestGeneration.current;
    const poll = async () => {
      try {
        const next = await requestXConnection("status");
        if (!disposed && generation === requestGeneration.current) setStatus(next);
      } catch {
        /* Keep controls available after transient status failures. */
      }
      if (!disposed) timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [following]);

  const runConnect = async (): Promise<void> => {
    requestGeneration.current++;
    setBusy("connect");
    try {
      setStatus(await requestXConnection("connect"));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "X could not connect.", "error");
    } finally {
      setBusy(null);
    }
  };
  const runDisconnect = async (): Promise<void> => {
    requestGeneration.current++;
    setBusy("disconnect");
    try {
      setStatus(await requestXConnection("disconnect"));
      setConfirmDisconnect(false);
      showToast("X disconnected. Cached posts stay in your library.", "success");
    } catch {
      try {
        setStatus(await requestXConnection("status"));
      } catch {
        /* Keep retry available. */
      }
      setConfirmDisconnect(false);
      showToast("The saved X login could not be removed. Retry before closing Scope.", "error");
    } finally {
      setBusy(null);
    }
  };
  const runRetryStorage = async (): Promise<void> => {
    requestGeneration.current++;
    setBusy("retry-storage");
    try {
      const next = await requestXConnection("retry-storage");
      setStatus(next);
      if (canRetryRestore) {
        showToast(
          next.capability === "connected"
            ? "X connection restored."
            : "X could not reconnect. Your saved login is retained; try again when X is reachable.",
          next.capability === "connected" ? "success" : "error",
        );
      } else if (next.storage?.state === "saved") {
        showToast("Your X login is saved on this device.", "success");
      } else {
        showToast(
          "Secure storage is still unavailable. Check the guidance and try again.",
          "error",
        );
      }
    } catch {
      showToast("Secure storage could not be updated. Try again.", "error");
    } finally {
      setBusy(null);
    }
  };
  const cancelLogin = async () => {
    requestGeneration.current++;
    try {
      setStatus(await requestXConnection("cancel"));
    } catch {
      showToast("The sign-in could not be cancelled. Close the X window.", "error");
    }
  };

  return (
    <section
      aria-labelledby="x-connection-heading"
      className="mt-6 rounded-xl border bg-card p-5 shadow-sm sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="x-connection-heading"
            className="flex items-center gap-2 text-base font-semibold tracking-tight"
          >
            <XLogo aria-hidden="true" className="size-4 text-foreground" />X (Twitter)
          </h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Read public X accounts and posts into your local library. Scope never posts, likes,
            reposts, or follows.
          </p>
        </div>
        {connected ? (
          <Badge variant="secondary" className="shrink-0">
            Connected
          </Badge>
        ) : (
          <Badge variant="outline" className="shrink-0 text-muted-foreground">
            {restoring
              ? "Restoring"
              : pending
                ? status.phase === "verifying"
                  ? "Verifying"
                  : "Waiting for sign-in"
                : unavailable
                  ? "Unavailable"
                  : "Not connected"}
          </Badge>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {restoring ? (
          <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner aria-hidden="true" />
            Restoring your saved X login…
          </div>
        ) : pending ? (
          <div role="status" className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Finish signing in in the X window. Scope will continue here.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  void requestXConnection("focus").catch(() =>
                    showToast("The X window could not be opened.", "error"),
                  )
                }
              >
                Show X window
              </Button>
              <Button variant="ghost" onClick={() => void cancelLogin()}>
                Cancel sign-in
              </Button>
            </div>
          </div>
        ) : connected && status.user ? (
          <>
            <div className="flex items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2.5">
              {status.user.avatarUrl ? (
                <img
                  src={status.user.avatarUrl}
                  alt=""
                  className="size-9 rounded-full border border-border object-cover"
                />
              ) : (
                <span className="flex size-9 items-center justify-center rounded-full bg-muted">
                  <XLogo aria-hidden="true" className="size-4 text-muted-foreground" />
                </span>
              )}
              <div className="min-w-0 text-sm">
                <p className="truncate font-medium">{status.user.displayName}</p>
                <p className="truncate text-muted-foreground">@{status.user.handle}</p>
              </div>
            </div>
            {storage ? (
              <StorageNotice
                storage={storage}
                connected
                busy={busy === "retry-storage"}
                onRetry={() => void runRetryStorage()}
              />
            ) : status.sessionOnly ? (
              <AlertNote tone="warning" politeness="polite" title="Session-only connection">
                This provider cannot store the X session securely, so you will need to sign in again
                after closing Scope.
              </AlertNote>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {status.providerId === "fake" ? (
                <Badge variant="outline" className="text-muted-foreground">
                  Development provider
                </Badge>
              ) : null}
              <Button
                variant="outline"
                onClick={() => void runConnect()}
                disabled={busy !== null}
                aria-busy={busy === "connect"}
              >
                {busy === "connect" ? <Spinner /> : <RefreshCw aria-hidden="true" />}
                {busy === "connect" ? "Signing in…" : "Sign in again"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setConfirmDisconnect(true)}
                disabled={busy !== null}
              >
                <Unplug aria-hidden="true" />
                Disconnect
              </Button>
            </div>
          </>
        ) : unavailable ? (
          <>
            <AlertNote tone="info" politeness="polite" title="X reads are not available here yet.">
              {status.errorCode === "unsupported_runtime"
                ? "Connect X in the desktop app. If you are already using it, repair or update the app to restore its X worker. Cached posts remain available."
                : "No X session is available on this machine. You can still browse anything already cached."}
            </AlertNote>
            <p className="text-xs text-muted-foreground">
              {cachedTweetCount > 0
                ? `${cachedTweetCount} cached ${cachedTweetCount === 1 ? "post" : "posts"} in your library remain readable.`
                : "No cached posts yet."}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Connecting opens X in a separate desktop sign-in window. Scope only keeps the session
              it needs for reads.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => void runConnect()}
                disabled={busy !== null}
                aria-busy={busy === "connect"}
              >
                {busy === "connect" ? (
                  <Spinner />
                ) : (
                  <XLogo aria-hidden="true" className="size-3.5" />
                )}
                {busy === "connect" ? "Signing in…" : "Connect X"}
              </Button>
            </div>
            {canRetryRestore ? (
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => void runRetryStorage()}
              >
                {busy === "retry-storage" ? <Spinner /> : <RefreshCw aria-hidden="true" />}
                Retry connection
              </Button>
            ) : null}
            {!storage && status.sessionOnly ? (
              <AlertNote tone="warning" politeness="polite" title="Session-only connection">
                This provider cannot store the X session securely, so you will need to sign in again
                after closing Scope.
              </AlertNote>
            ) : null}
            {storage && !["not_saved", "checking", "saved"].includes(storage.state) ? (
              <StorageNotice
                storage={storage}
                connected={false}
                busy={busy !== null}
                onRetry={() =>
                  void (storage.state === "delete_failed" ? runDisconnect() : runRetryStorage())
                }
              />
            ) : null}
            {status.errorCode === "session_expired" ? (
              <p className="text-xs text-muted-foreground">
                The previous session expired. Sign in again to continue fetching posts.
              </p>
            ) : null}
          </>
        )}
        {!restoring &&
        !pending &&
        status.errorCode &&
        !["unsupported_runtime", "session_expired", "verification_required", "cancelled"].includes(
          status.errorCode,
        ) ? (
          <AlertNote tone="warning" politeness="polite" title="X could not connect.">
            {status.errorCode === "timeout"
              ? "Sign-in or verification timed out. Connect again to retry."
              : X_ERROR_MESSAGES[status.errorCode]}
          </AlertNote>
        ) : null}
        {status.errorCode === "verification_required" ? (
          <AlertNote tone="warning" politeness="polite" title="X asked for verification.">
            Finish the verification X requested, then sign in again.
          </AlertNote>
        ) : null}
        {storage ? (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">Secure storage diagnostics</summary>
            <p className="mt-1">
              State: {storage.state}
              {" · "}Reason: {storage.reason ?? "none"}
              {" · "}Backend: {storage.backend ?? "unknown"}
            </p>
          </details>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        busy={busy === "disconnect"}
        busyLabel="Disconnecting…"
        onConfirm={() => void runDisconnect()}
        title="Disconnect X?"
        description="Scope will remove its stored access and stop fetching posts until you connect again."
        confirmLabel="Disconnect"
        cancelLabel="Keep connected"
        destructive
      >
        <p className="text-sm text-muted-foreground">
          Cached posts and saved creators stay in your library, and old reports remain readable. To
          remove cached posts, use the tweet cache action below the connection settings.
        </p>
      </ConfirmDialog>

      {toastElement}
    </section>
  );
}
