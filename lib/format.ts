/**
 * Display formatting helpers shared by server components. All functions are
 * pure so formatted strings can be produced during server rendering (the
 * channel pages are force-dynamic) without client/server hydration drift.
 */

/** Formats cache sizes in KB, MB, or GB without rounding small caches to zero. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1024) return "<1 KB";
  const unit = bytes >= 1024 ** 3 ? "GB" : bytes >= 1024 ** 2 ? "MB" : "KB";
  const divisor = unit === "GB" ? 1024 ** 3 : unit === "MB" ? 1024 ** 2 : 1024;
  const value = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(
    bytes / divisor,
  );
  return `${value} ${unit}`;
}

/** 65 → "1:05"; 3755 → "1:02:35". Null/unknown renders an em dash. */
export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** ISO date → "Aug 12, 2026" (UTC, deterministic across environments). */
export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

/**
 * ISO datetime → exact local timestamp like "Aug 12, 2026, 3:05 PM".
 * Uses the machine's locale/timezone so server-rendered tooltips match what
 * the user would read off their own clock (scope is single-machine).
 */
export function formatAbsoluteTimestamp(iso: string | null | undefined): string | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** ISO datetime → coarse relative label like "5 minutes ago". */
export function formatRelativeTime(
  iso: string | null | undefined,
  nowMs = Date.now(),
): string | null {
  if (!iso) {
    return null;
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return null;
  }
  const elapsedSeconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (elapsedSeconds < 45) {
    return "just now";
  }
  if (elapsedSeconds < 90) {
    return "a minute ago";
  }
  const minutes = Math.round(elapsedSeconds / 60);
  if (minutes < 60) {
    return `${minutes} minutes ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return days === 1 ? "yesterday" : `${days} days ago`;
  }
  const months = Math.round(days / 30);
  if (months < 12) {
    return months === 1 ? "a month ago" : `${months} months ago`;
  }
  const years = Math.round(months / 12);
  return years === 1 ? "a year ago" : `${years} years ago`;
}
