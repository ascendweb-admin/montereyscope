/**
 * Normalized X (Twitter) models and typed errors. Shared by the worker
 * adapter, the deterministic fake provider, the mapper, and the persistence
 * layer — no network, no database, no Node-specific imports beyond types.
 */

/** The one failure enum every X read maps to; UI copy keys off these. */
export const X_ERROR_CODES = [
  "not_connected",
  "session_expired",
  "verification_required",
  "rate_limited",
  "not_found",
  "protected_account",
  "network",
  "timeout",
  "cancelled",
  "unsupported_runtime",
  "invalid_response",
] as const;

export type XErrorCode = (typeof X_ERROR_CODES)[number];

export function isXErrorCode(value: unknown): value is XErrorCode {
  return typeof value === "string" && (X_ERROR_CODES as readonly string[]).includes(value);
}

/** Client-safe message per failure kind. Never contains upstream stderr. */
export const X_ERROR_MESSAGES: Record<XErrorCode, string> = {
  not_connected: "X is not connected on this machine.",
  session_expired: "Your X session has expired. Sign in again to continue.",
  verification_required:
    "X is asking for additional verification before this account can be read. Finish it in the X window, then try again.",
  rate_limited: "X is rate limiting reads right now. Wait a bit and try again.",
  not_found: "That X account or post could not be found.",
  protected_account: "That X account is protected, so Scope cannot collect its posts.",
  network: "Scope could not reach X. Check your connection and try again.",
  timeout: "The X request took too long and was stopped.",
  cancelled: "The X request was cancelled.",
  unsupported_runtime:
    "X support is not available in this build yet. The desktop app is required to connect an account.",
  invalid_response: "Scope could not read the data X returned. Try again later.",
};

/** A typed provider failure. `retryAfterSeconds` is surfaced when known. */
export class XProviderError extends Error {
  readonly code: XErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(code: XErrorCode, message?: string, retryAfterSeconds?: number | null) {
    super(message ?? X_ERROR_MESSAGES[code]);
    this.name = "XProviderError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds ?? null;
  }
}

/** A connected X account identity. The user id stays a string. */
export interface XUserIdentity {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  /** Optional bio; stored only for display in the connection card. */
  description?: string | null;
}

export interface XTweetAuthor {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

export type XMediaKind = "photo" | "video" | "gif";

/** Validated media metadata. URLs are always https on X image hosts. */
export interface XTweetMedia {
  kind: XMediaKind;
  /** Canonical media URL (image file or video poster). */
  url: string;
  /** Small preview when the provider exposes one. */
  previewUrl: string | null;
  altText: string | null;
}

/** A snapshot of the post a tweet quotes, when quoted text was available. */
export interface XQuotedTweet {
  tweetId: string;
  userId: string | null;
  handle: string | null;
  name: string | null;
  text: string;
  url: string;
}

/**
 * Content status:
 * - `complete`: the full post text is cached.
 * - `summary`: only a truncated preview is cached (timeline-only payloads).
 * - `unavailable`: the post exists but its text could not be read.
 */
export type XContentStatus = "summary" | "complete" | "unavailable";

/** One normalized post, ready to be persisted. */
export interface XTweetDraft {
  id: string;
  author: XTweetAuthor;
  text: string;
  language: string | null;
  publishedAt: string | null;
  url: string;
  replyCount: number | null;
  repostCount: number | null;
  likeCount: number | null;
  quoteCount: number | null;
  contentStatus: XContentStatus;
  isRepost: boolean;
  repostedByUserId: string | null;
  repostedByHandle: string | null;
  conversationId: string | null;
  inReplyToTweetId: string | null;
  inReplyToUserId: string | null;
  inReplyToHandle: string | null;
  quoted: XQuotedTweet | null;
  media: XTweetMedia[];
}

/** How a tweet appeared in a creator's timeline. */
export type XTimelineKind = "post" | "repost" | "reply";

/** One timeline slot: the post plus the timeline event that surfaced it. */
export interface XTimelineItem {
  tweet: XTweetDraft;
  timelineKind: XTimelineKind;
  /** Repost time when available, otherwise the post's publication time. */
  timelineAt: string | null;
}

/** One bounded page of a creator's timeline. */
export interface XTimelinePage {
  items: XTimelineItem[];
  /** Opaque cursor for the next (older) page, or null when exhausted. */
  nextCursor: string | null;
  exhausted: boolean;
  /** How many fetched entries were skipped as unusable. */
  skipped: number;
}

export interface XUserLookup {
  user: XUserIdentity;
  /** A pinned post's id when the user pinned one; used for previews only. */
  pinnedTweetId: string | null;
}

/**
 * The provider contract. `twitter-cli` and any future official-API adapter
 * satisfy the same interface; everything above this boundary works from
 * normalized records only.
 */
export interface XProvider {
  readonly id: string;
  /**
   * Whether this provider can establish a connection itself. The fake
   * provider and a worker that owns its own session can; a desktop-only
   * provider cannot in web mode.
   */
  readonly canConnect: boolean;
  status(signal?: AbortSignal): Promise<XConnectionStatus>;
  connect?(signal?: AbortSignal): Promise<XConnectionStatus>;
  disconnect?(): Promise<void>;
  cancel?(): Promise<void>;
  focus?(): Promise<void>;
  /** Retries secure-storage setup/saving without opening X sign-in again. */
  retryStorage?(): Promise<XConnectionStatus>;
  resolveUser(handle: string, signal?: AbortSignal): Promise<XUserLookup>;
  listUserTweets(
    input: { userId: string; handle: string; cursor?: string | null; limit: number },
    signal?: AbortSignal,
  ): Promise<XTimelinePage>;
  /**
   * Reads one post. `authorHandle` is an optional hint from the caller (a
   * status URL or creator row already knows it); providers that need the
   * handle in their lookup path may use it, others ignore it.
   */
  getTweet(
    tweetId: string,
    authorHandle?: string | null,
    signal?: AbortSignal,
  ): Promise<XTweetDraft | null>;
}

export type XCapability = "unavailable" | "connected" | "disconnected" | "session_only";

/**
 * Secure-storage lifecycle for the desktop session file, tracked separately
 * from the X connection. Only `saved` means the current verified session is
 * durably stored.
 */
export const X_STORAGE_STATES = [
  "checking",
  "saved",
  "locked",
  "unavailable",
  "save_failed",
  "delete_failed",
  "unreadable",
  "not_saved",
] as const;

export type XStorageState = (typeof X_STORAGE_STATES)[number];

/** Bounded storage reasons; never paths, backend arguments, or secrets. */
export const X_STORAGE_REASONS = [
  "missing_file",
  "no_secure_backend",
  "service_unavailable",
  "restart_required",
  "store_locked",
  "decrypt_failed",
  "corrupt_payload",
  "invalid_payload",
  "encrypt_failed",
  "write_failed",
  "delete_failed",
  "file_unreadable",
] as const;

export type XStorageReason = (typeof X_STORAGE_REASONS)[number];

export interface XStorageStatus {
  state: XStorageState;
  reason: XStorageReason | null;
  /** Selected OS backend name, for the diagnostics disclosure only. */
  backend: string | null;
}

export function isXStorageState(value: unknown): value is XStorageState {
  return typeof value === "string" && (X_STORAGE_STATES as readonly string[]).includes(value);
}

export function isXStorageReason(value: unknown): value is XStorageReason {
  return typeof value === "string" && (X_STORAGE_REASONS as readonly string[]).includes(value);
}

export function isXStorageStatus(value: unknown): value is XStorageStatus {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!isXStorageState(record.state)) return false;
  if (record.reason !== null && record.reason !== undefined && !isXStorageReason(record.reason)) {
    return false;
  }
  if (
    record.backend !== null &&
    record.backend !== undefined &&
    typeof record.backend !== "string"
  ) {
    return false;
  }
  return true;
}

export interface XConnectionStatus {
  phase?:
    | "disconnected"
    | "opening"
    | "awaiting_login"
    | "verifying"
    | "connected"
    | "expired"
    | "cancelled"
    | "error";
  attemptId?: string;
  capability: XCapability;
  providerId: string | null;
  user: XUserIdentity | null;
  /** Error detail when the last status check failed. */
  errorCode: XErrorCode | null;
  /** True when the session is session-only (not persisted securely). */
  sessionOnly: boolean;
  /**
   * Desktop secure-storage state. Absent when the provider owns its own
   * session (worker-owned or fake); desktop status always includes it.
   */
  storage?: XStorageStatus | null;
  /** True while a saved session is being decrypted and verified at startup. */
  restoring?: boolean;
}

export const X_UNAVAILABLE_STATUS: XConnectionStatus = {
  capability: "unavailable",
  providerId: null,
  user: null,
  errorCode: "unsupported_runtime",
  sessionOnly: false,
};

/** Bounds shared by every caller. App limits, not upstream promises. */
export const X_DEFAULT_RECENT_LIMIT = 20;
export const X_MAX_RECENT_LIMIT = 100;
export const X_MAX_DETAIL_BATCH = 50;
