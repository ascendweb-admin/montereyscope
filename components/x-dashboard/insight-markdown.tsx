"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ExternalLink } from "lucide-react";

import { CITATION_OPEN_DELAY_MS, CITATION_PILL } from "@/components/ai/citation";
import { CreatorAvatar } from "@/components/x-dashboard/avatars";
import { RichText, shortTime } from "@/components/x-dashboard/post-card";
import { parseInline, parseMarkdown, type Block, type Inline } from "@/lib/x/dashboard/markdown";
import { CITATION_PATTERN, type InsightSource } from "@/lib/x/dashboard/model";
import { cn } from "@/lib/utils";

type Sources = Record<string, InsightSource>;

const CARD_WIDTH = 320;
const CARD_GAP = 6;
const VIEWPORT_MARGIN = 8;
/** Room below the pill that still allows the card under it. */
const CARD_MIN_BELOW = 260;
const CLOSE_DELAY_MS = 120;

interface CardPosition {
  left: number;
  top?: number;
  bottom?: number;
}

/** Cited posts in first-cited order, grouped by creator. */
export function groupCitations(ids: readonly string[], sources: Sources): InsightSource[][] {
  const groups = new Map<number, InsightSource[]>();
  for (const id of new Set(ids)) {
    const source = sources[id];
    if (!source) continue;
    const group = groups.get(source.creatorId);
    if (group) group.push(source);
    else groups.set(source.creatorId, [source]);
  }
  return [...groups.values()];
}

/**
 * One citation run (`[post:1][post:2]…`) as a single pill: the first
 * creator's avatar and handle, "+N" for other creators or "· N" for several
 * posts by one. Hover or click opens a card with every cited post. The card
 * is portaled and fixed to the viewport, so it never widens or gets clipped
 * by the panel's scroller.
 */
export function PostCitation({ ids, sources }: { ids: readonly string[]; sources: Sources }) {
  const [card, setCard] = useState<CardPosition | null>(null);
  const [pinned, setPinned] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);
  const groups = groupCitations(ids, sources);
  const posts = groups.flat();

  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const close = useCallback(() => {
    clearTimer();
    setCard(null);
    setPinned(false);
  }, [clearTimer]);
  const open = () => {
    clearTimer();
    const rect = pillRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - CARD_WIDTH / 2, VIEWPORT_MARGIN),
      Math.max(window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN, VIEWPORT_MARGIN),
    );
    setCard(
      window.innerHeight - rect.bottom >= CARD_MIN_BELOW
        ? { left, top: rect.bottom + CARD_GAP }
        : { left, bottom: window.innerHeight - rect.top + CARD_GAP },
    );
  };
  const hoverOpen = () => {
    clearTimer();
    if (!card) timer.current = window.setTimeout(open, CITATION_OPEN_DELAY_MS);
  };
  const hoverClose = () => {
    clearTimer();
    if (!pinned) timer.current = window.setTimeout(() => setCard(null), CLOSE_DELAY_MS);
  };

  useEffect(() => clearTimer, [clearTimer]);
  useEffect(() => {
    if (!card) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      return !pillRef.current?.contains(target) && !cardRef.current?.contains(target);
    };
    const onPointer = (event: PointerEvent) => {
      if (outside(event)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    // The card is fixed to the viewport: scrolling anything else would strand it.
    const onScroll = (event: Event) => {
      if (outside(event)) close();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [card, close]);

  if (!posts.length)
    return (
      <span className="mx-0.5 inline-flex rounded-full bg-muted px-1.5 align-middle text-[0.85em] leading-5 text-muted-foreground">
        post
      </span>
    );
  const first = posts[0];
  const handles = groups.map((group) => `@${group[0].authorHandle}`);
  return (
    <>
      <button
        ref={pillRef}
        type="button"
        aria-expanded={Boolean(card)}
        aria-haspopup="dialog"
        aria-label={`Sources: ${posts.length} post${posts.length === 1 ? "" : "s"} by ${handles.join(", ")}`}
        onMouseEnter={hoverOpen}
        onMouseLeave={hoverClose}
        onClick={() => {
          if (card && pinned) close();
          else {
            open();
            setPinned(true);
          }
        }}
        className={cn(
          CITATION_PILL,
          "mx-0.5 cursor-pointer pl-0.5 transition-colors hover:border-primary/40 hover:bg-primary/[0.12] motion-reduce:transition-none",
          card && "border-primary/40 bg-primary/[0.12]",
        )}
      >
        <span aria-hidden="true" className="flex shrink-0 items-center">
          {groups.slice(0, 3).map((group, index) => (
            <CreatorAvatar
              key={group[0].creatorId}
              creator={{ id: group[0].creatorId, displayName: group[0].authorName, avatarUrl: group[0].authorAvatarUrl }}
              className={cn("size-4 text-[7px]", index > 0 && "-ml-1.5 ring-1 ring-background")}
            />
          ))}
        </span>
        <span className="min-w-0 truncate text-foreground">{first.authorHandle}</span>
        {groups.length > 1 ? (
          <span className="text-muted-foreground tabular-nums">+{groups.length - 1}</span>
        ) : posts.length > 1 ? (
          <span className="text-muted-foreground tabular-nums">· {posts.length}</span>
        ) : null}
      </button>
      {card
        ? createPortal(
            <span
              ref={cardRef}
              role="dialog"
              aria-label={`Cited post${posts.length === 1 ? "" : "s"}`}
              onMouseEnter={clearTimer}
              onMouseLeave={hoverClose}
              style={{ left: card.left, top: card.top, bottom: card.bottom, width: CARD_WIDTH }}
              className="fixed z-50 block max-h-[min(26rem,60vh)] overflow-y-auto overscroll-contain rounded-xl border bg-popover text-left text-sm text-popover-foreground shadow-lg"
            >
              {posts.length > 1 ? (
                <span className="block border-b px-3.5 py-2 text-xs font-medium text-muted-foreground">
                  {posts.length} cited posts
                </span>
              ) : null}
              {posts.map((source) => (
                <span key={source.id} className="block border-b px-3.5 py-3 last:border-b-0">
                  <span className="flex items-center gap-2">
                    <CreatorAvatar
                      creator={{ id: source.creatorId, displayName: source.authorName, avatarUrl: source.authorAvatarUrl }}
                      className="size-6 text-[9px]"
                    />
                    <span className="min-w-0 flex-1 truncate leading-tight">
                      <span className="font-semibold">{source.authorName}</span>{" "}
                      <span className="text-xs text-muted-foreground">
                        @{source.authorHandle}
                        {source.publishedAt ? ` · ${shortTime(source.publishedAt)}` : ""}
                      </span>
                    </span>
                  </span>
                  <span
                    className={cn(
                      "mt-1.5 block leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]",
                      posts.length > 1 ? "line-clamp-4" : "line-clamp-[10]",
                    )}
                  >
                    <RichText text={source.text} />
                  </span>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:underline"
                  >
                    <ExternalLink aria-hidden="true" className="size-3" />
                    Open on X
                  </a>
                </span>
              ))}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}


function renderInline(nodes: Inline[], sources: Sources, key = "i"): ReactNode[] {
  return nodes.map((node, index) => {
    const k = `${key}-${index}`;
    switch (node.kind) {
      case "text":
        return node.text;
      case "strong":
        return (
          <strong key={k} className="font-semibold text-foreground">
            {renderInline(node.children, sources, k)}
          </strong>
        );
      case "em":
        return <em key={k}>{renderInline(node.children, sources, k)}</em>;
      case "code":
        return (
          <code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
            {node.text}
          </code>
        );
      case "link":
        return (
          <a
            key={k}
            href={node.href}
            target="_blank"
            rel="noreferrer"
            className="text-sky-600 underline-offset-2 hover:underline dark:text-sky-400"
          >
            {renderInline(node.children, sources, k)}
          </a>
        );
      case "cite":
        return <PostCitation key={k} ids={node.ids} sources={sources} />;
    }
  });
}

/** A table cell longer than this (citations aside) is prose, not data. */
const PROSE_CELL = 60;

/** Drops citation runs (recursively), collecting their post ids into `into`. */
function withoutCitations(nodes: Inline[], into: string[]): Inline[] {
  return nodes.flatMap((node): Inline[] => {
    if (node.kind === "cite") {
      into.push(...node.ids);
      return [];
    }
    if (node.kind === "strong" || node.kind === "em" || node.kind === "link")
      return [{ ...node, children: withoutCitations(node.children, into) }];
    return [node];
  });
}

const inline = (text: string, sources: Sources, key: string) =>
  renderInline(parseInline(text), sources, key);

function renderBlock(block: Block, sources: Sources, key: string): ReactNode {
  switch (block.kind) {
    case "heading":
      return block.level <= 2 ? (
        <h3 key={key} className="mt-5 mb-2 text-[15px] font-semibold tracking-tight first:mt-0">
          {inline(block.text, sources, key)}
        </h3>
      ) : (
        <h4 key={key} className="mt-4 mb-1.5 text-sm font-semibold first:mt-0">
          {inline(block.text, sources, key)}
        </h4>
      );
    case "paragraph":
      return (
        <p key={key} className="my-2 whitespace-pre-line">
          {inline(block.text, sources, key)}
        </p>
      );
    case "quote":
      return (
        <blockquote key={key} className="my-3 border-l-2 pl-3 text-muted-foreground">
          {inline(block.text, sources, key)}
        </blockquote>
      );
    case "code":
      return (
        <pre key={key} className="my-3 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">
          {block.text}
        </pre>
      );
    case "rule":
      return <hr key={key} className="my-4" />;
    case "table":
      // Wide or prose-heavy tables don't fit the side panel: one card per
      // first-column value, with follow-on rows (blank or repeated first cell)
      // grouped underneath. Each field's label sits above its value, and the
      // card's citations gather into one Sources row instead of trailing
      // whichever cell is last. Short data tables stay tables.
      if (
        block.header.length > 3 ||
        (block.header.length === 3 &&
          block.rows.some((row) => row.some((cell) => cell.replace(CITATION_PATTERN, "").length > PROSE_CELL)))
      ) {
        const groups: Array<{ title: string; rows: string[][] }> = [];
        for (const row of block.rows) {
          const title = row[0].trim();
          const last = groups.at(-1);
          if (last && (!title || title === last.title)) last.rows.push(row);
          else groups.push({ title, rows: [row] });
        }
        return (
          <div key={key} className="my-3 space-y-2">
            {groups.map((group, g) => {
              const cited: string[] = [];
              const cell = (text: string, k: string) =>
                renderInline(withoutCitations(parseInline(text), cited), sources, k);
              const title = group.title ? cell(group.title, `${key}-${g}-t`) : null;
              const rows = group.rows.map((row, r) => (
                <dl key={r} className={cn("space-y-2", (group.title || r) && "mt-2.5", r && "border-t pt-2.5")}>
                  {row.slice(1).map((value, c) =>
                    value.trim() ? (
                      <div key={c} className="min-w-0">
                        <dt className="text-xs font-medium text-muted-foreground">
                          {cell(block.header[c + 1], `${key}-${g}-${r}-h${c}`)}
                        </dt>
                        <dd className="mt-0.5 text-[13px] leading-relaxed">
                          {cell(value, `${key}-${g}-${r}-${c}`)}
                        </dd>
                      </div>
                    ) : null,
                  )}
                </dl>
              ));
              const creators = groupCitations(cited, sources);
              return (
                <div key={g} className="rounded-xl border bg-background px-3.5 py-3">
                  {title ? <p className="text-sm leading-snug font-semibold">{title}</p> : null}
                  {rows}
                  {cited.length ? (
                    <p className="mt-2.5 flex flex-wrap items-center gap-y-1 border-t pt-2.5 text-xs text-muted-foreground">
                      <span className="mr-1">Sources</span>
                      {creators.length ? (
                        creators.map((posts) => (
                          <PostCitation key={posts[0].creatorId} ids={posts.map((post) => post.id)} sources={sources} />
                        ))
                      ) : (
                        <PostCitation ids={cited} sources={sources} />
                      )}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      }
      return (
        <div key={key} className="my-3 overflow-x-auto rounded-lg border">
          <table className="w-full border-collapse text-[13px]">
            <thead className="bg-muted/50">
              <tr>
                {block.header.map((cell, i) => (
                  <th
                    key={i}
                    style={{ textAlign: block.align[i] }}
                    className="border-b px-2.5 py-2 font-semibold whitespace-nowrap"
                  >
                    {inline(cell, sources, `${key}-h${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="align-top even:bg-muted/20">
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      style={{ textAlign: block.align[c] }}
                      className="border-b px-2.5 py-2 last:border-b-0"
                    >
                      {inline(cell, sources, `${key}-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          key={key}
          start={block.ordered && block.start !== 1 ? block.start : undefined}
          className={cn(
            "my-2 space-y-1.5 pl-5",
            block.ordered ? "list-decimal" : "list-disc marker:text-muted-foreground",
          )}
        >
          {block.items.map((item, i) => (
            <li key={i} className="pl-0.5">
              {inline(item.text, sources, `${key}-${i}`)}
              {item.children ? renderBlock(item.children, sources, `${key}-${i}-c`) : null}
            </li>
          ))}
        </Tag>
      );
    }
  }
}

/** An AI answer: Markdown with tables and post citations rendered as chips. */
export function InsightMarkdown({
  text,
  sources,
  streaming = false,
}: {
  text: string;
  sources: Sources;
  streaming?: boolean;
}) {
  return (
    <div className="min-w-0 text-sm leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">
      {parseMarkdown(streaming ? text.replace(/\[(p(o(s(t(:\d*)?)?)?)?)?$/, "") : text).map(
        (block, index) => renderBlock(block, sources, `b${index}`),
      )}
      {streaming ? (
        <span
          aria-hidden="true"
          className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-foreground/60 motion-reduce:animate-none"
        />
      ) : null}
    </div>
  );
}
