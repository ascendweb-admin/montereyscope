"use client";

import { useBackgroundTask } from "@/components/background/task-store";
import { creatorTaskKey } from "@/components/background/operations";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ListChecks, Search, X } from "lucide-react";

import { getCachedTimelineAction } from "@/app/actions/x";
import { fetchTweetsAction } from "@/components/background/operations";
import { refreshCreatorTweetsAction } from "@/components/background/operations";
import { ChatPanel } from "@/components/ai/chat-panel";
import type { ChatSource } from "@/components/ai/citation";
import { ScopeSelectionBar, type ScopeSelectionNote } from "@/components/ai/scope-selection-bar";
import { TweetCard, TweetDetailDialog } from "@/components/channel/tweet-card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/pending";
import { useToast } from "@/components/ui/toast";
import {
  formatScopeCapMessage,
  formatSkippedSources,
  MAX_SCOPE_SOURCES,
} from "@/lib/ai/scope-selection";
import { formatRelativeTime } from "@/lib/format";
import { toTweetViewModel, type TweetViewModel } from "@/lib/x/view-model";
import { cn } from "@/lib/utils";

export interface TweetTimelineState {
  lastRefreshedAt: string | null;
  lastError: string | null;
  exhausted: boolean;
}

interface TweetTimelineProps {
  creatorId: number;
  creatorName: string;
  tweets: TweetViewModel[];
  totalCount: number;
  hasMoreCached: boolean;
  state: TweetTimelineState | null;
}

type RefreshJob = "recent" | "older" | "fetch" | "cached" | null;

/**
 * The X creator timeline: readable text cards over the local cache, with
 * client-side search and reply/repost filters, selection that survives
 * filtering and detail views, an explicit fetch action for selected posts,
 * and a cursor-based "Load older tweets" action. Network work only ever runs
 * from these explicit buttons — cache reads never touch X.
 */
export function TweetTimeline({
  creatorId,
  creatorName,
  tweets: initialTweets,
  totalCount,
  hasMoreCached: initialHasMore,
  state,
}: TweetTimelineProps) {
  const router = useRouter();
  const { showToast, toastElement } = useToast();

  const [extraTweets, setExtraTweets] = useState<TweetViewModel[]>([]);
  const tweets = useMemo(() => {
    const byId = new Map(initialTweets.map((tweet) => [tweet.id, tweet]));
    for (const tweet of extraTweets) {
      if (!byId.has(tweet.id)) byId.set(tweet.id, tweet);
    }
    return [...byId.values()];
  }, [initialTweets, extraTweets]);
  const hasMoreCached = initialHasMore && tweets.length < totalCount;
  const [query, setQuery] = useState("");
  const [includeReplies, setIncludeReplies] = useState(false);
  const [includeReposts, setIncludeReposts] = useState(true);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [localJob, setJob] = useState<RefreshJob>(null);
  const creatorTask = useBackgroundTask(creatorTaskKey(creatorId));
  const postTask = useBackgroundTask(`posts:${creatorId}`);
  const job =
    localJob ??
    (creatorTask?.status === "running"
      ? "recent"
      : postTask?.status === "running"
        ? "fetch"
        : null);
  const [note, setNote] = useState<ScopeSelectionNote | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [reportOnOpen, setReportOnOpen] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tweets.filter((tweet) => {
      if (!includeReplies && tweet.timelineKind === "reply") {
        return false;
      }
      if (!includeReposts && tweet.isRepost) {
        return false;
      }
      if (needle.length === 0) {
        return true;
      }
      return (
        tweet.text.toLowerCase().includes(needle) ||
        tweet.authorHandle.toLowerCase().includes(needle) ||
        tweet.authorName.toLowerCase().includes(needle)
      );
    });
  }, [tweets, query, includeReplies, includeReposts]);

  const selectedTweets = useMemo(
    () => tweets.filter((tweet) => selectedIds.has(tweet.id)),
    [tweets, selectedIds],
  );
  const selectedReady = selectedTweets.filter((tweet) => tweet.readyForAnalysis);
  const selectedMissing = selectedTweets.filter((tweet) => !tweet.readyForAnalysis);
  const hiddenSelectedCount = selectedTweets.filter(
    (tweet) => !filtered.some((candidate) => candidate.id === tweet.id),
  ).length;
  const detailTweet = detailId ? (tweets.find((tweet) => tweet.id === detailId) ?? null) : null;

  const chatSources = useMemo<ChatSource[]>(
    () =>
      selectedReady.map((tweet) => ({
        id: tweet.id,
        kind: "tweet",
        title: tweet.text.split(/\r?\n/)[0]?.slice(0, 120) || "X post",
        creator: tweet.authorName,
        url: tweet.url,
        publishedAt: tweet.publishedAt,
        thumbnailUrl: tweet.media[0]?.previewUrl ?? null,
      })),
    [selectedReady],
  );
  const scopeSources = useMemo(
    () => selectedReady.map((tweet) => ({ kind: "tweet" as const, id: tweet.id })),
    [selectedReady],
  );

  const toggleTweet = (tweetId: string): void => {
    if (!selectedIds.has(tweetId) && selectedIds.size >= MAX_SCOPE_SOURCES) {
      setNote({ tone: "danger", message: formatScopeCapMessage(selectedIds.size + 1) });
      return;
    }
    setNote(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(tweetId)) {
        next.delete(tweetId);
      } else {
        next.add(tweetId);
      }
      return next;
    });
  };

  const selectVisible = (): void => {
    const visibleIds = filtered.map((tweet) => tweet.id);
    if (selectedIds.size >= MAX_SCOPE_SOURCES && visibleIds.some((id) => !selectedIds.has(id))) {
      setNote({ tone: "danger", message: formatScopeCapMessage(MAX_SCOPE_SOURCES + 1) });
      return;
    }
    setNote(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of visibleIds) {
        if (next.size >= MAX_SCOPE_SOURCES) {
          break;
        }
        next.add(id);
      }
      return next;
    });
  };

  const clearSelection = (): void => {
    setSelectedIds(new Set());
    setNote(null);
  };

  const loadCached = async (): Promise<void> => {
    setJob("cached");
    try {
      const outcome = await getCachedTimelineAction(creatorId, {
        offset: tweets.length,
        limit: 100,
        includeReplies: true,
        includeReposts: true,
      });
      if (!outcome.ok || !outcome.page) throw new Error("Cached posts could not be loaded.");
      setExtraTweets((previous) => [
        ...previous,
        ...outcome.page!.items.map((item) => toTweetViewModel(item, creatorId)),
      ]);
    } catch {
      showToast("Cached posts could not be loaded. Try again.", "error");
    } finally {
      setJob(null);
    }
  };

  const runRefresh = async (mode: "recent" | "older"): Promise<void> => {
    if (job !== null) {
      return;
    }
    setJob(mode);
    const outcome = await refreshCreatorTweetsAction(creatorId, mode);
    setJob(null);
    if (!outcome.ok) {
      showToast(outcome.message ?? "The timeline could not be updated.", "error");
      return;
    }
    if (outcome.status === "exhausted") {
      showToast("There are no older posts to load.", "info");
      return;
    }
    if (mode === "recent") {
      showToast(
        outcome.newItemCount && outcome.newItemCount > 0
          ? `Fetched ${outcome.newItemCount} recent ${outcome.newItemCount === 1 ? "post" : "posts"}.`
          : "The recent timeline is already up to date.",
        "success",
      );
    } else {
      showToast(
        outcome.newItemCount && outcome.newItemCount > 0
          ? `Loaded ${outcome.newItemCount} older ${outcome.newItemCount === 1 ? "post" : "posts"}.`
          : "No older posts were returned.",
        "success",
      );
    }
    router.refresh();
  };

  const fetchSelected = async (): Promise<void> => {
    if (job !== null) {
      return;
    }
    const targets = selectedMissing.map((tweet) => tweet.id);
    if (targets.length === 0) {
      setNote({
        tone: "info",
        message:
          "Every selected post already has its complete text cached — nothing needs fetching.",
      });
      return;
    }
    setJob("fetch");
    const outcome = await fetchTweetsAction(creatorId, targets);
    setJob(null);
    if (!outcome.ok || !outcome.batch) {
      showToast(outcome.message ?? "Fetching the selected posts failed.", "error");
      return;
    }
    if (extraTweets.length > 0) {
      const updated: TweetViewModel[] = [];
      for (let offset = initialTweets.length; offset < tweets.length; offset += 100) {
        const page = await getCachedTimelineAction(creatorId, {
          offset,
          limit: 100,
          includeReplies: true,
          includeReposts: true,
        });
        if (page.page)
          updated.push(...page.page.items.map((item) => toTweetViewModel(item, creatorId)));
      }
      setExtraTweets(updated);
    }
    const { savedCount, alreadyCompleteCount, unavailableCount, failedCount } = outcome.batch;
    const parts = [`${savedCount} saved`];
    if (alreadyCompleteCount > 0) {
      parts.push(`${alreadyCompleteCount} already complete`);
    }
    if (unavailableCount > 0) {
      parts.push(`${unavailableCount} unavailable`);
    }
    if (failedCount > 0) {
      parts.push(`${failedCount} failed`);
    }
    showToast(parts.join(", ") + ".", failedCount > 0 ? "error" : "success");
    router.refresh();
  };

  const openChat = (): void => {
    if (selectedReady.length === 0) {
      setNote({
        tone: "danger",
        message:
          "None of the selected posts has its complete text cached yet. Fetch the selected posts first.",
      });
      return;
    }
    setReportOnOpen(false);
    setNote(
      selectedMissing.length > 0
        ? {
            tone: "info",
            message: formatSkippedSources(
              selectedMissing.map((tweet) => ({
                kind: "tweet" as const,
                id: tweet.id,
                title: tweet.text.split(/\r?\n/)[0]?.slice(0, 120) || "X post",
                readyForAnalysis: tweet.readyForAnalysis,
              })),
            ),
          }
        : null,
    );
    setChatOpen(true);
  };

  const openReport = (): void => {
    if (selectedReady.length === 0) {
      setNote({
        tone: "danger",
        message:
          "None of the selected posts has its complete text cached yet. Fetch the selected posts first.",
      });
      return;
    }
    setReportOnOpen(true);
    setChatOpen(true);
  };

  const loadOlderAvailable = !state?.exhausted;

  if (tweets.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
        <p className="max-w-md text-balance text-sm text-muted-foreground">
          Nothing cached yet. Use{" "}
          <span className="font-medium text-foreground">Fetch recent tweets</span> to pull this
          account&apos;s newest posts into your local cache.
        </p>
        <Button
          onClick={() => void runRefresh("recent")}
          disabled={job !== null}
          aria-busy={job === "recent"}
        >
          {job === "recent" ? <Spinner /> : null}
          Fetch recent tweets
        </Button>
        {toastElement}
      </div>
    );
  }

  const truncatedLocalWindow = totalCount > tweets.length;

  return (
    <div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative lg:max-w-xs lg:flex-1">
            <Search
              aria-hidden="true"
              className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              aria-label="Search cached posts"
              placeholder="Search cached posts…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background pr-8 pl-9 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear post search"
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FilterToggle
              active={includeReplies}
              onClick={() => setIncludeReplies((value) => !value)}
              label="Replies"
            />
            <FilterToggle
              active={includeReposts}
              onClick={() => setIncludeReposts((value) => !value)}
              label="Reposts"
            />
            <Button variant="outline" size="sm" onClick={selectVisible}>
              <ListChecks aria-hidden="true" />
              Select visible
            </Button>
          </div>
          <p role="status" className="text-xs text-muted-foreground lg:ml-auto">
            Showing {filtered.length} of {totalCount} cached {totalCount === 1 ? "post" : "posts"}
            {truncatedLocalWindow ? " · local window" : ""}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          Filters apply to the cached window only; they never query all historical posts.
          {state?.lastRefreshedAt
            ? ` Last updated ${formatRelativeTime(state.lastRefreshedAt) ?? "recently"}.`
            : " Never refreshed."}
        </p>
      </div>

      {filtered.length === 0 ? (
        <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
          <p className="text-sm text-muted-foreground">No cached posts match these filters.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setQuery("");
              setIncludeReplies(true);
              setIncludeReposts(true);
            }}
          >
            Reset filters
          </Button>
        </div>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {filtered.map((tweet) => (
            <TweetCard
              key={tweet.id}
              tweet={tweet}
              selecting
              selected={selectedIds.has(tweet.id)}
              onToggle={() => toggleTweet(tweet.id)}
              onOpenDetail={() => setDetailId(tweet.id)}
            />
          ))}
        </ul>
      )}

      <div className="mt-6 flex flex-col items-center gap-1.5">
        {hasMoreCached ? (
          <Button variant="outline" onClick={() => void loadCached()} disabled={job !== null}>
            {job === "cached" ? <Spinner /> : <ChevronDown aria-hidden="true" />}
            Load more cached tweets
          </Button>
        ) : loadOlderAvailable ? (
          <Button
            variant="outline"
            onClick={() => void runRefresh("older")}
            disabled={job !== null}
            aria-busy={job === "older"}
          >
            {job === "older" ? <Spinner /> : <ChevronDown aria-hidden="true" />}
            {job === "older" ? "Loading older posts…" : "Load older tweets"}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">
            That is the end of this account&apos;s remote timeline.
          </p>
        )}
      </div>

      {selectedIds.size > 0 ? (
        <div className="pointer-events-none sticky bottom-4 z-20 mt-6 flex justify-center">
          <ScopeSelectionBar
            className="pointer-events-auto"
            count={selectedIds.size}
            noun="tweet"
            skippedCount={selectedMissing.length}
            skippedLabel="without cached text"
            onChat={openChat}
            onReport={openReport}
            onFetch={() => void fetchSelected()}
            fetchDisabled={job !== null}
            fetchBusy={job === "fetch"}
            onClear={clearSelection}
            note={note}
            disabledHint={
              hiddenSelectedCount > 0
                ? `${hiddenSelectedCount} selected ${hiddenSelectedCount === 1 ? "post is" : "posts are"} hidden by the current filters.`
                : null
            }
          />
        </div>
      ) : null}

      <TweetDetailDialog
        tweet={detailTweet}
        open={detailTweet !== null}
        onClose={() => setDetailId(null)}
      />

      <ChatPanel
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        scope={[]}
        scopeSources={scopeSources}
        sources={chatSources}
        initialReportDialogOpen={reportOnOpen}
        description={
          selectedReady.length > 0
            ? `${selectedReady.length} cached ${selectedReady.length === 1 ? "post" : "posts"} from ${creatorName}.`
            : undefined
        }
      />

      {toastElement}
    </div>
  );
}

function FilterToggle({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        active
          ? "border-ring bg-accent text-accent-foreground"
          : "bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {label}: {active ? "on" : "off"}
    </button>
  );
}
