import type { ReactNode } from "react";

import { SourceCitation, type ChatSource } from "@/components/ai/citation";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/**
 * Tiny markdown renderer for assistant answers: paragraphs, lists, bold,
 * italic, inline code, headings, quotes, and horizontal rules. Deliberately
 * not a full CommonMark engine and no external dependency — everything is
 * rendered as plain React children (never dangerouslySetInnerHTML), so
 * streamed text can never inject markup.
 *
 * Transcript citations: the model names sources by their file path
 * (`transcripts/<videoId>.txt`). When a `sources` index is provided, the
 * first resolvable mention — backticked, bare, or wrapped in parentheses —
 * renders as a SourceCitation chip naming the video; later mentions of the
 * same source render as nothing, with their hanging punctuation tidied, so
 * one chip per source carries the whole answer. Parentheses hugging a
 * citation are absorbed (the chip is the citation mark), so the model's
 * `(transcripts/….txt)` style never doubles up as brackets around the chip.
 * Anything unresolvable keeps the plain rendering.
 */

/** The scope videos' id → source index handed to the renderer. */
type SourceIndex = ReadonlyMap<string, ChatSource>;

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "ul"; items: string[][] }
  | { kind: "ol"; items: string[][] }
  | { kind: "quote"; lines: string[] }
  | { kind: "hr" };

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const HR_PATTERN = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const UL_PATTERN = /^\s*[-*+]\s+(.*)$/;
const OL_PATTERN = /^\s*\d{1,9}[.)]\s+(.*)$/;
const QUOTE_PATTERN = /^>\s?(.*)$/;
/**
 * Bold first so `**x**` is never read as italic; backticks stay verbatim.
 * The transcript-path alternatives catch citations the model writes without
 * backticks — parenthesized ones first, so `(transcripts/….txt)` is captured
 * whole (and rendered as one chip) instead of leaving stranded brackets.
 */
const INLINE_PATTERN =
  /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|\((?:\/|[\w@.-]+\/)*(?:transcripts|tweets)\/[\w-]+\.txt\)|\b(?:\/|[\w@.-]+\/)*(?:transcripts|tweets)\/[\w-]+\.txt\b)/g;
/** A whole token that is one source reference; group 1 is the folder. */
const CITATION_PATTERN = /^(?:\/|[\w@.-]+\/)*(transcripts|tweets)\/([A-Za-z0-9_-]+)\.txt$/;

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  // Whether the previous line was content: plain lines continue the block
  // above them, blank lines break that continuity.
  let appendToLast = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0) {
      appendToLast = false;
      continue;
    }

    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      appendToLast = false;
      continue;
    }

    if (HR_PATTERN.test(line)) {
      blocks.push({ kind: "hr" });
      appendToLast = false;
      continue;
    }

    const unordered = UL_PATTERN.exec(line);
    const ordered = OL_PATTERN.exec(line);
    if (unordered || ordered) {
      const isUnordered = unordered !== null;
      const kind: "ul" | "ol" = isUnordered ? "ul" : "ol";
      const itemText = (unordered ?? ordered)![1];
      const lastBlock = blocks.at(-1);
      if (appendToLast && lastBlock?.kind === kind) {
        lastBlock.items.push([itemText]);
      } else {
        blocks.push(
          isUnordered ? { kind: "ul", items: [[itemText]] } : { kind: "ol", items: [[itemText]] },
        );
      }
      appendToLast = true;
      continue;
    }

    const quote = QUOTE_PATTERN.exec(line);
    if (quote) {
      const lastBlock = blocks.at(-1);
      if (appendToLast && lastBlock?.kind === "quote") {
        lastBlock.lines.push(quote[1].trim());
      } else {
        blocks.push({ kind: "quote", lines: [quote[1].trim()] });
      }
      appendToLast = true;
      continue;
    }

    // A plain line continues the block above it: a list item's text, a
    // quote's lazy continuation, or the current paragraph.
    const lastBlock = blocks.at(-1);
    if (appendToLast && lastBlock) {
      if (lastBlock.kind === "p") {
        lastBlock.lines.push(line.trim());
        continue;
      }
      if (lastBlock.kind === "quote") {
        lastBlock.lines.push(line.trim());
        continue;
      }
      if (lastBlock.kind === "ul" || lastBlock.kind === "ol") {
        lastBlock.items.at(-1)?.push(line.trim());
        continue;
      }
    }
    blocks.push({ kind: "p", lines: [line.trim()] });
    appendToLast = true;
  }
  return blocks;
}

/**
 * Resolves a token to a scope source when it is a source-file reference.
 * Parentheses captured around the reference count as citation punctuation,
 * not prose — `(transcripts/….txt)` cites exactly like the bare path. Tweet
 * references (`tweets/….txt`) resolve through the namespaced index key so a
 * numeric post id can never collide with a video id.
 */
function citationSource(token: string, sources: SourceIndex | undefined): ChatSource | null {
  if (!sources) {
    return null;
  }
  const inner = token.startsWith("(") && token.endsWith(")") ? token.slice(1, -1) : token;
  const match = CITATION_PATTERN.exec(inner);
  if (!match) {
    return null;
  }
  const folder = match[1];
  const id = match[2];
  if (folder === "tweets") {
    return sources.get(`tweet:${id}`) ?? null;
  }
  return sources.get(id) ?? sources.get(`video:${id}`) ?? null;
}

/** Sentinel marking a dropped repeat citation, tidied away before render. */
const DROP = Symbol("repeat citation");

/**
 * A repeat citation of an already-cited source renders as nothing — one chip
 * per source per answer carries the attribution, and the model's per-claim
 * citations collapse into the prose. The punctuation the model hung on the
 * citation is tidied so the sentence survives: "x `cite`, y" reads "x y" and
 * "x (cite)." reads "x.".
 */
function tidyDroppedCitations(parts: (ReactNode | typeof DROP)[]): ReactNode[] {
  const out: ReactNode[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part !== DROP) {
      out.push(part);
      continue;
    }
    // "drawdown " → "drawdown", so an attached "." or "," reads naturally.
    const prev = out.at(-1);
    if (typeof prev === "string") {
      const trimmed = prev.replace(/[ \t]+$/, "");
      if (trimmed.length > 0) {
        out[out.length - 1] = trimmed;
      } else {
        out.pop();
      }
    }
    const joined = out.length > 0;
    const next = parts[index + 1];
    if (typeof next === "string" && next.length > 0) {
      if (next.startsWith(",")) {
        // ", and the show's…" → " and the show's…"
        parts[index + 1] = next.replace(/^,[ \t]*/, " ");
      } else if (!/^[.;:]/.test(next)) {
        // Sentence punctuation attaches to the previous word as-is; plain
        // continuation keeps exactly one joining space.
        parts[index + 1] = next.replace(/^[ \t]+/, joined ? " " : "");
      }
    }
  }
  // DROPs are never pushed, so out is already clean.
  return out;
}

/**
 * Renders one block's inline text. `cited` accumulates the source ids already
 * given a chip across the whole answer, in document order — the first
 * citation of a source renders the chip, repeats are tidied away.
 */
function renderInline(
  text: string,
  keyBase: string,
  sources: SourceIndex | undefined,
  cited: Set<string>,
): ReactNode[] {
  const parts: (ReactNode | typeof DROP)[] = text.split(INLINE_PATTERN).map((part, index) => {
    const key = `${keyBase}-${index}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("__") && part.endsWith("__") && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      const inner = part.slice(1, -1);
      const source = citationSource(inner, sources);
      if (source) {
        if (cited.has(source.id)) {
          return DROP;
        }
        cited.add(source.id);
        return <SourceCitation key={key} source={source} />;
      }
      return (
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {inner}
        </code>
      );
    }
    const source = citationSource(part, sources);
    if (source) {
      if (cited.has(source.id)) {
        return DROP;
      }
      cited.add(source.id);
      return <SourceCitation key={key} source={source} />;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
  return tidyDroppedCitations(parts);
}

interface MarkdownProps {
  text: string;
  /** Node appended inside the last block; the streaming caret rides here. */
  trailing?: ReactNode;
  /**
   * Scope videos' id → source index; transcript references resolve into
   * citation chips against it. Unresolvable ids keep the plain rendering.
   */
  sources?: ReadonlyMap<string, ChatSource>;
  className?: string;
}

export function Markdown({ text, trailing, sources, className }: MarkdownProps) {
  const blocks = parseBlocks(text);
  // Source ids already given the full pill in this answer; fresh every render,
  // so streaming stays stable (the first mention stays the first).
  const cited = new Set<string>();
  return (
    <div
      className={cn(
        "flex flex-col gap-2 text-sm leading-relaxed [overflow-wrap:anywhere] [text-wrap:pretty]",
        className,
      )}
    >
      {blocks.map((block, index) => {
        const tail = index === blocks.length - 1 ? trailing : null;
        switch (block.kind) {
          case "p":
            return (
              <p key={index}>
                {renderInline(block.lines.join(" "), `b${index}`, sources, cited)}
                {tail}
              </p>
            );
          case "heading":
            return (
              <p
                key={index}
                className={block.level <= 2 ? "text-base font-semibold" : "font-semibold"}
              >
                {renderInline(block.text, `b${index}`, sources, cited)}
                {tail}
              </p>
            );
          case "ul":
            return (
              <ul key={index} className="list-disc space-y-1 pl-5">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    {renderInline(item.join(" "), `b${index}-${itemIndex}`, sources, cited)}
                    {tail && itemIndex === block.items.length - 1 ? tail : null}
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={index} className="list-decimal space-y-1 pl-5">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    {renderInline(item.join(" "), `b${index}-${itemIndex}`, sources, cited)}
                    {tail && itemIndex === block.items.length - 1 ? tail : null}
                  </li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote
                key={index}
                className="border-l-2 border-border pl-3 text-muted-foreground"
              >
                {renderInline(block.lines.join(" "), `b${index}`, sources, cited)}
                {tail}
              </blockquote>
            );
          case "hr":
            return <Separator key={index} />;
        }
      })}
      {blocks.length === 0 ? trailing : null}
    </div>
  );
}
