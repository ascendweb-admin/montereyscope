"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/*
 * Themed replacement for the native date picker: a trigger button plus a
 * month grid that follows the app palette in both light and dark themes.
 * Dates are "YYYY-MM-DD" strings; all arithmetic runs in UTC so daylight
 * saving shifts cannot move a calendar day.
 */

const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
const GRID_DAYS = 42;

type YearMonth = { year: number; month: number };

function parseIso(iso: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function addMonthsIso(iso: string, months: number): string {
  const parts = parseIso(iso);
  if (!parts) return iso;
  const total = parts.year * 12 + (parts.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(parts.day, lastDay);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addMonthsToView(view: YearMonth, months: number): YearMonth {
  const total = view.year * 12 + (view.month - 1) + months;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

function isoToUtcDate(iso: string): Date {
  return new Date(Date.parse(`${iso}T00:00:00Z`));
}

function formatLabel(iso: string): string {
  return isoToUtcDate(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function localTodayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

type DatePickerProps = {
  /** Accessible name for the trigger, e.g. "From date". */
  ariaLabel: string;
  value: string;
  onChange: (date: string) => void;
  /** The day highlighted as "today"; defaults to the browser's local day. */
  today?: string;
  /** Edge of the trigger the popover aligns to; "end" keeps it on screen near the viewport's right edge. */
  align?: "start" | "end";
  disabled?: boolean;
  className?: string;
};

export function DatePicker({
  ariaLabel,
  value,
  onChange,
  today = localTodayIso(),
  align = "start",
  disabled = false,
  className,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<YearMonth | null>(null);
  const [cursor, setCursor] = useState<string>(today);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dayRefs = useRef(new Map<string, HTMLButtonElement>());
  const monthLabelId = useId();

  const parsed = parseIso(value);
  const activeCursor = parseIso(cursor) ? cursor : today;

  const openCalendar = (): void => {
    const initial = parseIso(value) ? value : today;
    const parts = parseIso(initial)!;
    setView({ year: parts.year, month: parts.month });
    setCursor(initial);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    dayRefs.current.get(activeCursor)?.focus({ preventScroll: true });
  }, [open, activeCursor]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const weeks = useMemo<string[]>(() => {
    if (!view) return [];
    const firstOfMonth = new Date(Date.UTC(view.year, view.month - 1, 1));
    const leading = (firstOfMonth.getUTCDay() + 6) % 7;
    const gridStart = new Date(Date.UTC(view.year, view.month - 1, 1 - leading));
    return Array.from({ length: GRID_DAYS }, (_, index) =>
      addDays(gridStart.toISOString().slice(0, 10), index),
    );
  }, [view]);

  const moveCursor = (next: string): void => {
    const parts = parseIso(next);
    if (!parts) return;
    setCursor(next);
    if (view && (parts.year !== view.year || parts.month !== view.month)) {
      setView({ year: parts.year, month: parts.month });
    }
  };

  const select = (iso: string): void => {
    onChange(iso);
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  const onGridKeyDown = (event: ReactKeyboardEvent): void => {
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        moveCursor(addDays(activeCursor, -1));
        break;
      case "ArrowRight":
        event.preventDefault();
        moveCursor(addDays(activeCursor, 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        moveCursor(addDays(activeCursor, -7));
        break;
      case "ArrowDown":
        event.preventDefault();
        moveCursor(addDays(activeCursor, 7));
        break;
      case "PageUp":
        event.preventDefault();
        moveCursor(addMonthsIso(activeCursor, event.shiftKey ? -12 : -1));
        break;
      case "PageDown":
        event.preventDefault();
        moveCursor(addMonthsIso(activeCursor, event.shiftKey ? 12 : 1));
        break;
      case "Home": {
        event.preventDefault();
        const offset = (isoToUtcDate(activeCursor).getUTCDay() + 6) % 7;
        moveCursor(addDays(activeCursor, -offset));
        break;
      }
      case "End": {
        event.preventDefault();
        const offset = (isoToUtcDate(activeCursor).getUTCDay() + 6) % 7;
        moveCursor(addDays(activeCursor, 6 - offset));
        break;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        select(activeCursor);
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
        break;
    }
  };

  return (
    <div ref={wrapperRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openCalendar())}
        className={cn(
          "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none",
          parsed ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <span className="truncate">{parsed ? formatLabel(value) : "Pick a date"}</span>
        <Calendar className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      {open && view ? (
        <div
          role="dialog"
          aria-label={`${ariaLabel} calendar`}
          className={cn(
            "absolute top-full z-30 mt-1.5 w-72 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          <div className="mb-1 flex items-center justify-between">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => setView(addMonthsToView(view, -1))}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </button>
            <span id={monthLabelId} className="text-sm font-medium">
              {new Intl.DateTimeFormat(undefined, {
                month: "long",
                year: "numeric",
                timeZone: "UTC",
              }).format(new Date(Date.UTC(view.year, view.month - 1, 1)))}
            </span>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => setView(addMonthsToView(view, 1))}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          </div>
          <div role="grid" aria-labelledby={monthLabelId} onKeyDown={onGridKeyDown}>
            <div role="row" className="grid grid-cols-7">
              {WEEKDAY_LABELS.map((label) => (
                <div
                  key={label}
                  role="columnheader"
                  className="flex h-8 items-center justify-center text-xs text-muted-foreground"
                >
                  {label}
                </div>
              ))}
            </div>
            {Array.from({ length: GRID_DAYS / 7 }, (_, weekIndex) => (
              <div key={weekIndex} role="row" className="grid grid-cols-7">
                {weeks.slice(weekIndex * 7, weekIndex * 7 + 7).map((iso) => {
                  const day = parseIso(iso)!.day;
                  const outsideMonth = parseIso(iso)!.month !== view.month;
                  const isSelected = iso === value && parsed !== null;
                  const isToday = iso === today;
                  return (
                    <div
                      key={iso}
                      role="gridcell"
                      aria-selected={isSelected}
                      className="flex justify-center"
                    >
                      <button
                        type="button"
                        ref={(node) => {
                          if (node) dayRefs.current.set(iso, node);
                          else dayRefs.current.delete(iso);
                        }}
                        tabIndex={iso === activeCursor ? 0 : -1}
                        aria-current={isToday ? "date" : undefined}
                        onClick={() => select(iso)}
                        className={cn(
                          "flex size-8 items-center justify-center rounded-md text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                          outsideMonth ? "text-muted-foreground/60" : "text-foreground",
                          !isSelected && "hover:bg-accent hover:text-accent-foreground",
                          isToday && !isSelected && "font-semibold ring-1 ring-inset ring-ring",
                          isSelected &&
                            "bg-primary font-medium text-primary-foreground hover:bg-primary/90",
                        )}
                      >
                        {day}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
