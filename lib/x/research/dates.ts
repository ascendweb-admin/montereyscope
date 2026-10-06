/** Calendar dates are inclusive in the chosen IANA timezone, never in server time. */
export function calendarDate(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function shiftDate(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== date
  ) {
    throw new Error("Choose a valid calendar date.");
  }
  return new Date(ms + days * 86400000).toISOString().slice(0, 10);
}

/** First instant on this local date; binary search also handles midnight DST shifts. */
function midnight(date: string, timezone: string): number {
  shiftDate(date, 0);
  const center = Date.parse(`${date}T00:00:00Z`);
  let low = center - 36 * 3600000;
  let high = center + 36 * 3600000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (calendarDate(new Date(mid), timezone) < date) low = mid + 1;
    else high = mid;
  }
  if (calendarDate(new Date(low), timezone) !== date)
    throw new Error("That date does not exist in this timezone.");
  return low;
}

export function calendarBounds(start: string, end: string, timezone: string) {
  if (start > end) throw new Error("The end date must be on or after the start date.");
  return {
    since: new Date(midnight(start, timezone)).toISOString(),
    until: new Date(midnight(shiftDate(end, 1), timezone)).toISOString(),
  };
}
