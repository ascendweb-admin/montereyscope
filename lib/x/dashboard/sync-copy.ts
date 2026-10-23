/**
 * What Scope tells people about X syncing. The snapshot keeps every technical
 * state (rate-limit waits, retries, older posts importing) for Settings → Sync
 * details. Everyday views only answer "are my posts here, and how fresh are
 * they?", and only warn when there is something the person can do. X limiting
 * reads is normal: Scope gets the newest posts first and waits it out alone.
 * Client-safe: no server imports.
 */
import { formatRelativeTime } from "@/lib/format";
import type { SyncCreatorState, SyncSnapshot } from "./model";

/** "attention" is reserved for problems someone can fix; nothing else gets a warning color. */
export type SyncTone = "loading" | "busy" | "fresh" | "quiet" | "attention";

/** Account problems someone can act on (remove or fix the account). Other failures retry alone. */
const ACCOUNT_PROBLEMS = new Set(["protected_account", "not_found"]);

/** After this long without a successful update, the details say posts may be behind. */
export const BEHIND_AFTER_MS = 12 * 3600_000;

export const EXPLAINER =
  "X limits how quickly apps can read posts, so Scope gets the newest posts first and fills in older ones gradually. Nothing you need to do.";
export const BEHIND_NOTE = "Some posts may be a bit behind. Scope keeps checking automatically.";

export const isRunning = (c: SyncCreatorState) => c.state === "syncing" || c.state === "waiting";

export const needsAttention = (c: SyncCreatorState) =>
  c.state === "disconnected" || (c.state === "error" && ACCOUNT_PROBLEMS.has(c.errorCode ?? ""));

/** Waiting out X, or a failure Scope retries by itself on the next update. */
const holding = (c: SyncCreatorState) =>
  c.state === "waiting" || c.state === "paused" || (c.state === "error" && !needsAttention(c));

/** True while some account's first import is running; the only work worth a Stop button. */
export const importingNew = (sync: SyncSnapshot) =>
  sync.creators.some((c) => isRunning(c) && c.firstSync);

/** Accounts whose posts aren't all here yet: older posts still coming in, or no posts yet. */
export const stillImporting = (creators: SyncCreatorState[]) =>
  creators.filter((c) => c.olderPosts !== null || (c.lastSyncedAt === null && c.state !== "never"))
    .length;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function syncSummary(
  sync: SyncSnapshot | null,
  nameOf: (creatorId: number) => string | undefined,
  now = Date.now(),
): { label: string; tone: SyncTone } {
  if (!sync) return { label: "Checking…", tone: "loading" };
  if (sync.state === "disconnected") return { label: "X not connected", tone: "attention" };
  const running = sync.creators.filter(isRunning);
  if (running.length) {
    if (!running.every((c) => c.firstSync)) return { label: "Checking for new posts…", tone: "busy" };
    // Name the accounts when there are only a few, so adding one shows what is happening.
    const names = running.map((c) => nameOf(c.creatorId)).filter((n): n is string => Boolean(n));
    return {
      label: names.length && names.length <= 2 ? `Getting posts · ${names.join(", ")}` : "Getting posts…",
      tone: "busy",
    };
  }
  const attention = sync.creators.filter(needsAttention).length;
  if (attention)
    return { label: `${plural(attention, "account needs", "accounts need")} attention`, tone: "attention" };
  const never = sync.creators.filter((c) => c.state === "never").length;
  if (never)
    return {
      label: never === sync.creators.length ? "Not updated yet" : `${never} not updated yet`,
      tone: "quiet",
    };
  if (!sync.lastSyncedAt)
    return { label: sync.creators.length ? "Posts coming soon" : "Up to date", tone: "quiet" };
  return {
    label: `Updated ${formatRelativeTime(sync.lastSyncedAt, now)}`,
    tone: now - Date.parse(sync.lastSyncedAt) > BEHIND_AFTER_MS ? "quiet" : "fresh",
  };
}

/** One plain line per account for the dashboard's details popover. */
export function creatorSummary(
  c: SyncCreatorState,
  now = Date.now(),
): { text: string; tone: SyncTone } {
  if (isRunning(c)) return { text: c.firstSync ? "Getting posts…" : "Checking for new posts…", tone: "busy" };
  if (needsAttention(c)) return { text: c.message ?? "Couldn't update this account", tone: "attention" };
  if (c.state === "never") return { text: "Not updated yet", tone: "quiet" };
  if (!c.lastSyncedAt) return { text: "Posts coming soon", tone: "quiet" };
  const fresh = c.state === "idle" && c.newPosts ? ` · ${c.newPosts} new` : "";
  return {
    text: `Updated ${formatRelativeTime(c.lastSyncedAt, now)}${fresh}${c.olderPosts ? " · adding older posts" : ""}`,
    tone: "quiet",
  };
}

/**
 * The notes under the popover's header: the actionable problem first, then a
 * calm "behind" line, then why posts arrive gradually when that is visible.
 */
export function syncNotes(sync: SyncSnapshot, now = Date.now()): { problem: string | null; info: string[] } {
  const attention = sync.creators.filter(needsAttention);
  const problem =
    sync.state === "disconnected"
      ? sync.message
      : attention.length === 1
        ? attention[0].message
        : attention.length
          ? `${attention.length} accounts can't be updated. See the details below.`
          : null;
  const info: string[] = [];
  const behind = sync.creators.some(
    (c) =>
      holding(c) &&
      !isRunning(c) &&
      (c.lastSyncedAt === null || now - Date.parse(c.lastSyncedAt) > BEHIND_AFTER_MS),
  );
  if (behind) info.push(BEHIND_NOTE);
  if (sync.creators.some((c) => holding(c) || c.olderPosts)) info.push(EXPLAINER);
  return { problem, info };
}

/** How often the accounts on screen are checked, in one plain line. */
export function checkCadence(everyMs: number, accounts: number): string {
  if (!everyMs) return "Automatic updates are off. Use Update now to check for new posts.";
  const minutes = Math.round(everyMs / 60_000);
  const every = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
  return `While you're here, Scope checks ${accounts === 1 ? "this account" : `these ${accounts} accounts`} for new posts every ${every}.`;
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The full technical line per account, for Settings → Sync details. */
export function technicalCreatorLine(state: SyncCreatorState, now = Date.now()): string {
  const older = state.olderPosts
    ? ` · ${state.olderPosts.waiting ? "older posts waiting for X" : `loading older posts back to ${shortDate(state.olderPosts.since)}`}`
    : "";
  switch (state.state) {
    case "syncing":
      return `${state.firstSync ? "First sync · reading recent posts" : "Reading new posts"}${older}`;
    case "waiting":
      return `Rate limited by X · resumes ${state.retryAt ? clock(state.retryAt) : "soon"}${older}`;
    case "paused":
      return `${state.retryAt && Date.parse(state.retryAt) > now ? `Rate limited by X · retries after ${clock(state.retryAt)}` : "Rate limited by X · retries next sync"}${older}`;
    case "disconnected":
    case "error":
      return `${state.message ?? "Couldn't sync"}${state.errorCode ? ` (${state.errorCode})` : ""}${older}`;
    case "never":
      return "Never synced";
    default:
      return `Synced ${formatRelativeTime(state.lastSyncedAt, now) ?? ""}${state.newPosts ? ` · ${state.newPosts} new` : ""}${older}`;
  }
}
