import { PlugZap } from "lucide-react";

import { AlertNote } from "@/components/ui/alert-note";

/**
 * Setup guidance shown whenever an operation fails because yt-dlp itself is
 * missing. Explains what to install without exposing private filesystem
 * paths — the env var name is the only machine detail mentioned.
 */
export function YtDlpSetupNote() {
  return (
    <AlertNote tone="danger" title="Local tool missing." className="not-prose">
      <span>
        scope could not find <code className="font-mono text-xs">yt-dlp</code>, the local helper it
        uses to talk to YouTube. Install it with your package manager (for example{" "}
        <code className="font-mono text-xs">pip install yt-dlp</code>) so that running{" "}
        <code className="font-mono text-xs">yt-dlp --version</code> works in your terminal, or set{" "}
        <code className="font-mono text-xs">SCOPE_YTDLP_PATH</code> in your{" "}
        <code className="font-mono text-xs">.env.local</code> to its full path, then restart scope.
      </span>
      <span className="mt-1 flex items-center gap-1.5 text-xs opacity-80">
        <PlugZap aria-hidden="true" className="size-3.5" />
        Nothing was fetched, changed, or deleted by this attempt.
      </span>
    </AlertNote>
  );
}
