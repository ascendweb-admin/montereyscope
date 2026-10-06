import { runCommand } from "./runner";

/**
 * Executable name or absolute path used to invoke yt-dlp.
 * Override with SCOPE_YTDLP_PATH when yt-dlp is not on PATH.
 */
export const YT_DLP_COMMAND =
  process.env.SCOPE_YTDLP_PATH ?? process.env.LOCALTUBE_YTDLP_PATH ?? "yt-dlp";

const VERSION_TIMEOUT_MS = 10_000;
const VERSION_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Resolves the installed yt-dlp version, e.g. "2026.08.19", or null when the
 * executable is missing, times out, or exits nonzero (health reporting uses
 * this to flag degradation without surfacing raw process errors).
 */
export async function getYtDlpVersion(command: string = YT_DLP_COMMAND): Promise<string | null> {
  const result = await runCommand(command, ["--version"], {
    timeoutMs: VERSION_TIMEOUT_MS,
    maxOutputBytes: VERSION_MAX_OUTPUT_BYTES,
  });
  if (!result.ok) {
    return null;
  }
  return result.stdout.trim() || null;
}
