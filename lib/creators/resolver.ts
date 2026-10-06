/**
 * Resolves a YouTube channel URL into canonical creator identity using the
 * yt-dlp safe runner boundary (argument arrays only). Server-only.
 */
import { parseCreatorChannelUrl } from "@/lib/validation/creator-url";
import { YT_DLP_COMMAND } from "@/lib/ytdlp/version";
import { NETWORK_UNREACHABLE_MESSAGE, YTDLP_MISSING_MESSAGE } from "@/lib/ytdlp/user-messages";
import { runCommand, type ExecFileResult } from "@/lib/ytdlp/runner";

export interface ResolvedCreator {
  /** Which platform this creator belongs to; YouTube for this resolver. */
  platform: "youtube" | "rumble";
  /** Canonical UC… channel ID when yt-dlp reports one. */
  youtubeChannelId: string | null;
  /** Lowercase handle without the leading @, when known. */
  handle: string | null;
  displayName: string;
  /** Canonical https://www.youtube.com/channel/<ID> URL when known. */
  channelUrl: string;
  /** Remote avatar/thumbnail URL — never downloaded or stored locally. */
  avatarUrl: string | null;
}

export type CreatorResolutionErrorCode =
  | "invalid_url"
  | "ytdlp_missing"
  | "unavailable_channel"
  | "network"
  | "timeout"
  | "unexpected_response";

export interface CreatorResolutionError {
  code: CreatorResolutionErrorCode;
  /** Plain-language, UI-safe message. Never contains stderr or paths. */
  message: string;
}

export type CreatorResolutionResult =
  { ok: true; creator: ResolvedCreator } | { ok: false; error: CreatorResolutionError };

export interface ResolutionDeps {
  command: string;
  run: typeof runCommand;
  timeoutMs: number;
  maxOutputBytes: number;
}

const DEFAULT_RESOLUTION_TIMEOUT_MS = 20_000;
// Channel metadata JSON is small; the cap guards against pathological output.
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Builds the yt-dlp argument array for cheap flat channel extraction. */
export function buildResolutionArgs(channelUrl: string): string[] {
  return [
    "--dump-single-json",
    "--flat-playlist",
    // Only peek at the first entry; we want channel identity, not its feed.
    "--playlist-items",
    "1",
    "--no-warnings",
    "--no-progress",
    channelUrl,
  ];
}

function fail(code: CreatorResolutionErrorCode, message: string): CreatorResolutionResult {
  return { ok: false, error: { code, message } };
}

interface YtDlpChannelJson {
  readonly channel_id?: unknown;
  readonly channel?: unknown;
  readonly uploader?: unknown;
  readonly title?: unknown;
  readonly uploader_id?: unknown;
  readonly channel_url?: unknown;
  readonly webpage_url?: unknown;
  readonly thumbnails?: unknown;
}

interface YtDlpThumbnailJson {
  readonly url?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly preference?: unknown;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Picks the best square avatar-style thumbnail. YouTube channel JSON mixes
 * wide banner crops with the square avatar; prefer explicit squares, then
 * highest preference, then largest area.
 */
export function pickAvatarUrl(thumbnails: unknown): string | null {
  if (!Array.isArray(thumbnails)) {
    return null;
  }
  const candidates = thumbnails
    .filter((item): item is YtDlpThumbnailJson => typeof item === "object" && item !== null)
    .filter((item) => {
      const url = asNonEmptyString(item.url);
      return url !== null && url.startsWith("https://");
    });
  if (candidates.length === 0) {
    return null;
  }

  const scoreOf = (item: YtDlpThumbnailJson): number => {
    const width = typeof item.width === "number" ? item.width : 0;
    const height = typeof item.height === "number" ? item.height : 0;
    const preference = typeof item.preference === "number" ? item.preference : 0;
    const isSquare = width > 0 && height > 0 && Math.abs(width - height) <= 2;
    return (isSquare ? 10_000_000 : 0) + preference * 100_000 + width * height;
  };

  const best = [...candidates].sort((a, b) => scoreOf(b) - scoreOf(a))[0];
  return best ? asNonEmptyString(best.url) : null;
}

function handleFromUploaderId(uploaderId: string): string | null {
  const trimmed = uploaderId.trim();
  if (!trimmed.startsWith("@")) {
    return null;
  }
  return trimmed.slice(1).toLowerCase() || null;
}

function classifyFailure(result: Extract<ExecFileResult, { ok: false }>): CreatorResolutionError {
  switch (result.kind) {
    case "missing_executable":
      return {
        code: "ytdlp_missing",
        message: YTDLP_MISSING_MESSAGE,
      };
    case "timeout":
      return {
        code: "timeout",
        message: "Looking up that creator took too long and was stopped. Please try again.",
      };
    default:
      break;
  }

  const stderrTail = result.stderrTail.toLowerCase();

  if (
    /does not exist|not found|404|has been terminated|is unavailable|no longer available|this channel|empty playlist/.test(
      stderrTail,
    )
  ) {
    return {
      code: "unavailable_channel",
      message:
        "YouTube does not offer that channel (it may have been removed, renamed, or made private).",
    };
  }
  if (
    /getaddrinfo|temporary failure|name or service not known|network|connection|unable to download|resolve|refused|reset by peer/.test(
      stderrTail,
    )
  ) {
    return {
      code: "network",
      message: NETWORK_UNREACHABLE_MESSAGE,
    };
  }

  return {
    code: "unexpected_response",
    message: "scope could not read that channel right now. Please try again later.",
  };
}

/**
 * Parses raw input and resolves it to stable creator identity. All failures
 * come back as typed, user-safe errors; raw process details stay on server.
 */
export async function resolveCreatorFromUrl(
  rawInput: string,
  overrides: Partial<ResolutionDeps> = {},
): Promise<CreatorResolutionResult> {
  const parsed = parseCreatorChannelUrl(rawInput);
  if (!parsed.ok) {
    return fail("invalid_url", parsed.message);
  }

  const target =
    parsed.target.kind === "channel_id"
      ? `https://www.youtube.com/channel/${parsed.target.channelId}`
      : `https://www.youtube.com/@${parsed.target.handle}`;

  const deps: ResolutionDeps = {
    command: YT_DLP_COMMAND,
    run: runCommand,
    timeoutMs: DEFAULT_RESOLUTION_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    ...overrides,
  };

  const result = await deps.run(deps.command, buildResolutionArgs(target), {
    timeoutMs: deps.timeoutMs,
    maxOutputBytes: deps.maxOutputBytes,
  });

  if (!result.ok) {
    return { ok: false, error: classifyFailure(result) };
  }

  let payload: YtDlpChannelJson;
  try {
    payload = JSON.parse(result.stdout) as YtDlpChannelJson;
  } catch {
    return fail(
      "unexpected_response",
      "scope could not read that channel right now. Please try again.",
    );
  }

  const youtubeChannelId = asNonEmptyString(payload.channel_id);
  const displayName =
    asNonEmptyString(payload.channel) ??
    asNonEmptyString(payload.uploader) ??
    asNonEmptyString(payload.title);
  if (displayName === null) {
    return fail(
      "unexpected_response",
      "That link resolved to something scope cannot save as a creator.",
    );
  }

  const uploaderHandle =
    typeof payload.uploader_id === "string" ? handleFromUploaderId(payload.uploader_id) : null;
  const inputHandle = parsed.target.kind === "handle" ? parsed.target.handle : null;
  const handle = uploaderHandle ?? inputHandle;

  const canonicalChannelUrl =
    youtubeChannelId !== null
      ? `https://www.youtube.com/channel/${youtubeChannelId}`
      : (asNonEmptyString(payload.channel_url) ?? asNonEmptyString(payload.webpage_url) ?? target);

  return {
    ok: true,
    creator: {
      platform: "youtube",
      youtubeChannelId,
      handle: handle ?? null,
      displayName,
      channelUrl: canonicalChannelUrl,
      avatarUrl: pickAvatarUrl(payload.thumbnails),
    },
  };
}
