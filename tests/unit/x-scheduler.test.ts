import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XProviderError } from "@/lib/x/model";
import { mapXRateLimit } from "@/lib/x/mapper";
import {
  heldByQuota,
  recordRateLimit,
  resetXScheduler,
  reserveFor,
  scheduleX,
  X_PRIORITY,
  xQuotaStatus,
} from "@/lib/x/scheduler";
import {
  boostX,
  currentXFocus,
  FOCUS_TTL_MS,
  resetXFocus,
  setXFocus,
  xReadPriority,
} from "@/lib/x/focus";

beforeEach(() => {
  resetXScheduler();
  resetXFocus();
});
afterEach(() => {
  vi.useRealTimers();
  resetXScheduler();
});

/** Holds the X connection until released, so other reads queue up behind it. */
function hold() {
  let release!: () => void;
  const held = scheduleX(() => new Promise<void>((resolve) => (release = resolve)));
  return { held, release: () => release() };
}

describe("X read scheduler", () => {
  it("runs the most urgent waiter next, re-reading priorities while they wait", async () => {
    const order: string[] = [];
    const { held, release } = hold();
    let focused = false;
    const reads = [
      scheduleX(async () => void order.push("backfill"), { priority: X_PRIORITY.backfill }),
      // Not on screen when it queued; the list it belongs to is opened while it waits.
      scheduleX(async () => void order.push("switched-to"), {
        priority: () => (focused ? X_PRIORITY.focusHead : X_PRIORITY.head),
      }),
      scheduleX(async () => void order.push("background-head"), { priority: X_PRIORITY.head }),
      scheduleX(async () => void order.push("search"), { priority: X_PRIORITY.interactive }),
    ];
    focused = true;
    release();
    await Promise.all([held, ...reads]);
    expect(order).toEqual(["search", "switched-to", "background-head", "backfill"]);
  });

  it("keeps a reserve of timeline reads for more urgent work", async () => {
    const now = Date.now();
    recordRateLimit(
      "timeline",
      { limit: 50, remaining: 12, reset: Math.floor(now / 1000) + 600 },
      now,
    );
    // Older-post imports stop at 20 left; new posts for the list on screen may go down to 2.
    expect(heldByQuota(X_PRIORITY.backfill)).toBe(true);
    expect(heldByQuota(X_PRIORITY.focusBackfill)).toBe(true);
    expect(heldByQuota(X_PRIORITY.head)).toBe(false);
    expect(heldByQuota(X_PRIORITY.focusHead)).toBe(false);
    const order: string[] = [];
    const backfill = scheduleX(async () => void order.push("backfill"), {
      priority: X_PRIORITY.backfill,
      bucket: "timeline",
    });
    await scheduleX(async () => void order.push("head"), {
      priority: X_PRIORITY.head,
      bucket: "timeline",
    });
    // Profile lookups have their own quota and never wait for this one.
    await scheduleX(async () => void order.push("lookup"), { priority: X_PRIORITY.backfill });
    expect(order).toEqual(["head", "lookup"]);
    expect(xQuotaStatus()).toMatchObject({ available: 11, estimated: false });
    // A fresh window lets the import continue.
    recordRateLimit("timeline", {
      limit: 50,
      remaining: 50,
      reset: Math.floor(Date.now() / 1000) + 900,
    });
    await scheduleX(async () => void order.push("next"), { priority: X_PRIORITY.interactive });
    await backfill;
    expect(order).toEqual(["head", "lookup", "next", "backfill"]);
  });

  it("counts its own timeline reads when X sends no quota headers", async () => {
    for (let n = 0; n < 30; n++) await scheduleX(async () => ({}), { bucket: "timeline" });
    expect(xQuotaStatus()).toMatchObject({ available: 20, estimated: true });
    expect(heldByQuota(X_PRIORITY.backfill)).toBe(true);
    expect(heldByQuota(X_PRIORITY.focusBackfill)).toBe(false);
  });

  it("follows the quota X reports with each page", async () => {
    const reset = Math.floor(Date.now() / 1000) + 300;
    await scheduleX(async () => ({ items: [], rateLimit: { limit: 50, remaining: 7, reset } }), {
      bucket: "timeline",
    });
    expect(xQuotaStatus()).toMatchObject({
      available: 7,
      limit: 50,
      nextAt: new Date(reset * 1000).toISOString(),
    });
  });

  it("holds only timeline reads after X answers 429, until the time X gave", async () => {
    vi.useFakeTimers();
    await expect(
      scheduleX(async () => Promise.reject(new XProviderError("rate_limited", undefined, 120)), {
        bucket: "timeline",
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(xQuotaStatus().available).toBe(0);
    const order: string[] = [];
    const page = scheduleX(async () => void order.push("page"), {
      priority: X_PRIORITY.manual,
      bucket: "timeline",
    });
    await scheduleX(async () => void order.push("search"));
    expect(order).toEqual(["search"]);
    await vi.advanceTimersByTimeAsync(121_000);
    await page;
    expect(order).toEqual(["search", "page"]);
  });

  it("drops a waiter whose work was cancelled", async () => {
    const { held, release } = hold();
    const controller = new AbortController();
    const operation = vi.fn(async () => "never");
    const waiting = scheduleX(operation, { signal: controller.signal });
    controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
    release();
    await held;
    expect(operation).not.toHaveBeenCalled();
  });

  it("keeps reserves ordered from urgent to background", () => {
    const levels = Object.values(X_PRIORITY).map(reserveFor);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
    expect(reserveFor(X_PRIORITY.manual)).toBe(0);
  });

  it("leaves enough reads for one Update now of the accounts on screen", () => {
    expect(reserveFor(X_PRIORITY.focusBackfill)).toBe(12);
    setXFocus(
      Array.from({ length: 18 }, (_, i) => i + 1),
      30,
    );
    expect(reserveFor(X_PRIORITY.focusBackfill)).toBe(20);
    expect(reserveFor(X_PRIORITY.backfill)).toBe(26);
    // Never so much that a long list stops older posts entirely.
    setXFocus(
      Array.from({ length: 200 }, (_, i) => i + 1),
      30,
    );
    expect(reserveFor(X_PRIORITY.focusBackfill)).toBe(25);
    expect(reserveFor(X_PRIORITY.backfill)).toBe(30);
  });

  it("ignores malformed or implausible quota reports", () => {
    expect(mapXRateLimit({ remaining: "3", reset: 1 })).toBeNull();
    expect(mapXRateLimit({ remaining: 3, reset: 1800000000, limit: 50 })).toEqual({
      remaining: 3,
      reset: 1800000000,
      limit: 50,
    });
    recordRateLimit("timeline", { remaining: 0, reset: 1 });
    expect(xQuotaStatus()).toMatchObject({ available: 50, estimated: true });
  });
});

describe("what's on screen", () => {
  it("puts the accounts on screen first and Update now above everything automatic", () => {
    const now = Date.now();
    expect(xReadPriority(1, "head", now)).toBe(X_PRIORITY.head);
    expect(setXFocus([1, 2], 30, now)).toBe(true);
    expect(setXFocus([2, 1], 30, now + 1000)).toBe(false);
    expect(setXFocus([1, 2], 90, now + 2000)).toBe(true);
    expect(xReadPriority(1, "head", now)).toBe(X_PRIORITY.focusHead);
    expect(xReadPriority(1, "history", now)).toBe(X_PRIORITY.focusBackfill);
    expect(xReadPriority(3, "history", now)).toBe(X_PRIORITY.backfill);
    boostX([3], now);
    expect(xReadPriority(3, "head", now)).toBe(X_PRIORITY.manual);
    // A closed dashboard stops counting as on screen.
    expect(currentXFocus(now + 2000 + FOCUS_TTL_MS)).toBeNull();
    expect(xReadPriority(1, "head", now + 2000 + FOCUS_TTL_MS)).toBe(X_PRIORITY.head);
  });
});
