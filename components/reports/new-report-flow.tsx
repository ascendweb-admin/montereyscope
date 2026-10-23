"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { ChatSourcePicker } from "@/components/ai/chat-source-picker";
import { prefetchTranscripts } from "@/components/ai/prefetch-transcripts";
import { ReportOptionsDialog } from "@/components/ai/report-options-dialog";
import type { ReportProfileId, ReportStyleId } from "@/components/ai/report-options";
import type { SourceLibrary } from "@/lib/ai/source-library";
import { sourceKey, type SourceRef } from "@/lib/content/model";

/**
 * "New report" on the Reports page: the same source picker AI Chat uses,
 * then the report's style and depth, then the job is queued — no chat in
 * between. Back on the second step returns to the picker with the ticks
 * kept. The host mounts the flow only while it runs, so every new report
 * starts from an empty selection.
 *
 * The picker's library (every cached video and post) is too large to ship
 * with the Reports page, which re-renders whenever a background job
 * finishes, so it is read from GET /api/ai/sources when the flow opens, and
 * again whenever a creator refresh finishes while the picker is open. One
 * dialog is mounted at a time: the native dialog reports a programmatic
 * close as a dismissal, which would end the flow between its steps.
 */

/** How long a read is reused: hovering "New report" warms it for the click. */
const LIBRARY_REUSE_MS = 30_000;

interface LibraryRead {
  request: Promise<SourceLibrary>;
  startedAt: number;
  /** The answer once it arrived, so a warmed flow opens without a loading frame. */
  value: SourceLibrary | null;
}

/**
 * Reads the picker's library for one Reports page. A read started moments
 * ago is reused; after that each new report reads afresh, so newly synced
 * posts show up. A failed read is never reused.
 */
export function createSourceLibraryLoader() {
  let last: LibraryRead | null = null;
  const recent = (): LibraryRead | null =>
    last !== null && Date.now() - last.startedAt < LIBRARY_REUSE_MS ? last : null;

  function load(): Promise<SourceLibrary> {
    const reusable = recent();
    return reusable ? reusable.request : readFresh();
  }

  function readFresh(): Promise<SourceLibrary> {
    const read: LibraryRead = {
      startedAt: Date.now(),
      value: null,
      request: fetch("/api/ai/sources", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }
        const value = (await response.json()) as SourceLibrary;
        read.value = value;
        return value;
      }),
    };
    read.request.catch(() => {
      if (last === read) {
        last = null;
      }
    });
    last = read;
    return read.request;
  }

  return {
    load,
    /** Reads afresh, past any recent read: the library changed under it. */
    reload: readFresh,
    /** Starts a read ahead of the click; a failure surfaces when the flow opens. */
    warm(): void {
      load().catch(() => {});
    },
    /** The library already in hand, when a recent read finished. */
    peek(): SourceLibrary | null {
      return recent()?.value ?? null;
    },
  };
}

export type SourceLibraryLoader = ReturnType<typeof createSourceLibraryLoader>;

/** "8 sources by 3 creators": people, not accounts, as the chat header counts them. */
function selectionSummary(selection: readonly SourceRef[], library: SourceLibrary): string {
  const picked = new Set(selection.map(sourceKey));
  const profileOf = new Map(library.creators.map((creator) => [creator.id, creator.profileId]));
  const personOf = (item: { creatorId: number; featuredProfileId?: number | null }): number =>
    // An appearance counts for the person it features, not the channel it is on.
    item.featuredProfileId ?? profileOf.get(item.creatorId) ?? -item.creatorId;
  const people = new Set<number>();
  for (const [kind, items] of [
    ["video", library.videos],
    ["tweet", library.tweets],
  ] as const) {
    for (const item of items) {
      if (picked.has(`${kind}:${item.id}`)) {
        people.add(personOf(item));
      }
    }
  }
  const sources = selection.length === 1 ? "1 source" : `${selection.length} sources`;
  return people.size === 0
    ? sources
    : `${sources} by ${people.size} ${people.size === 1 ? "creator" : "creators"}`;
}

export interface NewReportFlowProps {
  loader: SourceLibraryLoader;
  /** Ends the flow: cancelled, or the report was queued. */
  onClose: () => void;
  /** Queues the report; resolves true once it was accepted, which ends the flow. */
  onGenerate: (
    sources: SourceRef[],
    profile: ReportProfileId,
    style: ReportStyleId,
  ) => Promise<boolean>;
  /** The library could not be read; the host ends the flow and says so. */
  onLoadFailed: () => void;
}

export function NewReportFlow({ loader, onClose, onGenerate, onLoadFailed }: NewReportFlowProps) {
  const [library, setLibrary] = useState<SourceLibrary | null>(() => loader.peek());
  const [step, setStep] = useState<"sources" | "options">("sources");
  const [selection, setSelection] = useState<SourceRef[]>([]);
  const [busy, setBusy] = useState(false);

  const mounted = useRef(true);
  const reloading = useRef<"idle" | "reading" | "again">("idle");

  useEffect(() => {
    mounted.current = true;
    loader.load().then(
      (value) => {
        if (mounted.current) setLibrary(value);
      },
      () => {
        if (mounted.current) onLoadFailed();
      },
    );
    return () => {
      mounted.current = false;
    };
    // Once per flow: the host mounts it fresh for every new report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A creator refresh landed: read the library again so its sources show up.
  // Refreshes finish in bursts during "Refresh all"; one read runs at a
  // time, and whatever finishes meanwhile is covered by a single read after.
  // A failed read keeps the library already shown.
  function reloadLibrary(): void {
    if (reloading.current !== "idle") {
      reloading.current = "again";
      return;
    }
    reloading.current = "reading";
    loader
      .reload()
      .then(
        (value) => {
          if (mounted.current) setLibrary(value);
        },
        () => {},
      )
      .finally(() => {
        const again = reloading.current === "again";
        reloading.current = "idle";
        if (again && mounted.current) reloadLibrary();
      });
  }

  const selectedKeys = useMemo(() => new Set(selection.map(sourceKey)), [selection]);
  const summary = useMemo(
    () => (library === null ? null : selectionSummary(selection, library)),
    [selection, library],
  );

  async function generate(profile: ReportProfileId, style: ReportStyleId): Promise<void> {
    setBusy(true);
    try {
      if (await onGenerate(selection, profile, style)) {
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  if (step === "sources") {
    return (
      <ChatSourcePicker
        purpose="report"
        open
        loading={library === null}
        onClose={onClose}
        videos={library?.videos ?? []}
        tweets={library?.tweets ?? []}
        creators={library?.creators ?? []}
        categories={library?.categories ?? []}
        selected={selectedKeys}
        onSourcesUpdated={reloadLibrary}
        onConfirm={(refs) => {
          setSelection(refs);
          setStep("options");
          // Captions download while the style and depth are picked.
          prefetchTranscripts(refs.filter((ref) => ref.kind === "video").map((ref) => ref.id));
        }}
      />
    );
  }

  return (
    <ReportOptionsDialog
      open
      onClose={onClose}
      onBack={() => setStep("sources")}
      onGenerate={(profile, style) => void generate(profile, style)}
      busy={busy}
      description={`One self-contained HTML document from ${summary ?? "the sources you picked"}.`}
      progressHint="This one appears at the top of the list once it’s queued."
    />
  );
}
