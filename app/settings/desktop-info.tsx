"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { FolderOpen, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  hasDesktopAppBridge,
  hasDesktopIntegrationBridge,
  installDesktopMenuEntry,
  openDesktopLogsFolder,
  platformLabel,
  readDesktopAppInfo,
  readDesktopIntegrationStatus,
  removeDesktopMenuEntry,
  type DesktopAppInfo,
  type DesktopIntegrationStatus,
} from "@/lib/desktop/app-bridge";

/**
 * Desktop-only About block: app version, platform/architecture, a shortcut to
 * the local log folder, and (in a packaged Linux AppImage) optional
 * application-menu integration. Rendered only inside the packaged Electron
 * app; the browser build shows nothing.
 */
const subscribeToNothing = (): (() => void) => () => {};

export function DesktopInfoSection() {
  // Server render and browser mode have no bridge; only the mounted desktop
  // render shows the section, avoiding a hydration mismatch.
  const mounted = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  const available = mounted && hasDesktopAppBridge();
  const integrationBridge = mounted && hasDesktopIntegrationBridge();
  const [info, setInfo] = useState<DesktopAppInfo | null>(null);
  const [integration, setIntegration] = useState<DesktopIntegrationStatus | null>(null);
  const [integrationAction, setIntegrationAction] = useState<"install" | "remove" | null>(null);
  const [opening, setOpening] = useState(false);
  const { showToast, toastElement } = useToast();

  useEffect(() => {
    if (!available) {
      return;
    }
    let cancelled = false;
    void readDesktopAppInfo().then((next) => {
      if (!cancelled) {
        setInfo(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [available]);

  useEffect(() => {
    if (!integrationBridge) {
      return;
    }
    let cancelled = false;
    void readDesktopIntegrationStatus().then((next) => {
      if (!cancelled) {
        setIntegration(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [integrationBridge]);

  const openLogs = async (): Promise<void> => {
    setOpening(true);
    const opened = await openDesktopLogsFolder();
    setOpening(false);
    if (!opened) {
      showToast("The logs folder could not be opened.", "error");
    }
  };

  const addToMenu = async (): Promise<void> => {
    setIntegrationAction("install");
    const result = await installDesktopMenuEntry();
    setIntegrationAction(null);
    if (result.ok && result.data) {
      setIntegration(result.data);
      showToast(
        integration?.integrated
          ? "The application-menu copy was updated. Quit Scope, then launch it from the menu."
          : "Scope was added to your application menu.",
        "success",
      );
      return;
    }
    showToast(
      result.error?.message || "Scope could not be added to the application menu.",
      "error",
    );
  };

  const removeFromMenu = async (): Promise<void> => {
    setIntegrationAction("remove");
    const result = await removeDesktopMenuEntry();
    setIntegrationAction(null);
    if (result.ok && result.data) {
      setIntegration(result.data);
      showToast("Scope was removed from your application menu. Your data was kept.", "success");
      return;
    }
    showToast(
      result.error?.message || "Scope could not be removed from the application menu.",
      "error",
    );
  };

  if (!available) {
    return null;
  }

  const showIntegration =
    integrationBridge &&
    integration !== null &&
    integration.supported &&
    (integration.runningFromAppImage || integration.integrated);

  return (
    <section
      aria-labelledby="desktop-info-heading"
      className="mt-6 rounded-xl border bg-card p-5 shadow-sm sm:p-6"
    >
      <h2 id="desktop-info-heading" className="text-base font-semibold tracking-tight">
        Desktop app
      </h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        {info === null ? (
          "Reading the desktop app information…"
        ) : (
          <>
            Scope {info.version} for {platformLabel(info.platform)} ({info.arch}). Logs are stored
            locally and never include provider tokens or API keys.
          </>
        )}
      </p>
      <div className="mt-3">
        <Button variant="outline" size="sm" onClick={() => void openLogs()} disabled={opening}>
          {opening ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <FolderOpen aria-hidden="true" />
          )}
          Open logs folder
        </Button>
      </div>

      {showIntegration ? (
        <div className="mt-5 border-t pt-4">
          <h3 className="text-sm font-semibold tracking-tight">Application menu</h3>
          {integration.integrated ? (
            <>
              <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                Scope is in your application menu. The entry launches the managed copy at{" "}
                <span className="break-all font-mono text-xs">
                  {integration.managedExecutablePath}
                </span>
                . You can delete the original download. To update, quit Scope, run a newer download,
                and choose “Update application-menu copy”. Then quit and launch Scope from the menu
                to use the updated copy.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => void addToMenu()}
                  disabled={integrationAction !== null || !integration.runningFromAppImage}
                >
                  {integrationAction === "install" ? (
                    <Loader2 aria-hidden="true" className="animate-spin" />
                  ) : null}
                  Update application-menu copy
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void removeFromMenu()}
                  disabled={integrationAction !== null}
                >
                  {integrationAction === "remove" ? (
                    <Loader2 aria-hidden="true" className="animate-spin" />
                  ) : null}
                  Remove from application menu
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                Add Scope to your application menu to launch it like any other application. Scope
                copies the running AppImage to a managed location under your user data; the
                downloaded file can then be deleted.
              </p>
              {integration.desktopEntryState === "foreign" ? (
                <p className="mt-2 max-w-prose text-sm text-amber-600 dark:text-amber-500">
                  Another Scope menu entry already exists that was not created by this app. Remove
                  it first, then try again.
                </p>
              ) : null}
              <div className="mt-3">
                <Button
                  size="sm"
                  onClick={() => void addToMenu()}
                  disabled={integrationAction !== null}
                >
                  {integrationAction === "install" ? (
                    <Loader2 aria-hidden="true" className="animate-spin" />
                  ) : null}
                  Add to application menu
                </Button>
              </div>
            </>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Removing the menu entry keeps your library, reports, and saved X login.
          </p>
        </div>
      ) : null}
      {toastElement}
    </section>
  );
}
