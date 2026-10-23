/**
 * What the person is looking at right now, so X reads for it go first. The
 * X Dashboard reports the accounts and timeframe in view with every status
 * poll; the report expires shortly after the dashboard closes. "Update now"
 * boosts its accounts above everything automatic for a few minutes.
 * Server-only; shared through globalThis across route bundles.
 */
import { setXOnScreen, X_PRIORITY } from "./scheduler";

/** A dashboard polls at least every 10 seconds; after this long it is gone. */
export const FOCUS_TTL_MS = 45_000;
const BOOST_MS = 5 * 60_000;

export interface XFocus {
  creatorIds: ReadonlySet<number>;
  /** Days of history the timeframe in view asks for; null for "all time". */
  days: number | null;
  at: number;
}

interface FocusState {
  focus: XFocus | null;
  boosts: Map<number, number>;
}

const shared = globalThis as typeof globalThis & { __scopeXFocus?: FocusState };
const state = (): FocusState => (shared.__scopeXFocus ??= { focus: null, boosts: new Map() });

/** Records the accounts and timeframe on screen. Returns true when they changed. */
export function setXFocus(creatorIds: number[], days: number | null, now = Date.now()): boolean {
  const s = state();
  const previous = s.focus && now - s.focus.at < FOCUS_TTL_MS ? s.focus : null;
  const ids = new Set(creatorIds);
  s.focus = { creatorIds: ids, days, at: now };
  setXOnScreen(ids.size);
  return (
    !previous ||
    previous.days !== days ||
    previous.creatorIds.size !== ids.size ||
    [...ids].some((id) => !previous.creatorIds.has(id))
  );
}

export function currentXFocus(now = Date.now()): XFocus | null {
  const focus = state().focus;
  return focus && now - focus.at < FOCUS_TTL_MS ? focus : null;
}

/** Puts these accounts ahead of all automatic work for a few minutes ("Update now"). */
export function boostX(creatorIds: number[], now = Date.now()): void {
  const boosts = state().boosts;
  for (const id of creatorIds) boosts.set(id, now + BOOST_MS);
}

/** Ends a boost once its account's new posts are in. */
export function settleXBoost(creatorId: number): void {
  state().boosts.delete(creatorId);
}

/**
 * The read priority for one creator's work: new posts before older posts, the
 * accounts on screen before the rest, and "Update now" above all of it.
 */
export function xReadPriority(
  creatorId: number,
  lane: "head" | "history",
  now = Date.now(),
): number {
  const s = state();
  const boosted = (s.boosts.get(creatorId) ?? 0) > now;
  const inView = currentXFocus(now)?.creatorIds.has(creatorId) ?? false;
  if (lane === "head")
    return boosted ? X_PRIORITY.manual : inView ? X_PRIORITY.focusHead : X_PRIORITY.head;
  return inView ? X_PRIORITY.focusBackfill : X_PRIORITY.backfill;
}

/** Test seam. */
export function resetXFocus(): void {
  delete shared.__scopeXFocus;
}
