/**
 * Reading a finished report document without rendering it: the section
 * outline the Reports page lists beside the reader (and the anchors that
 * outline jumps to), the plain text full-text search indexes, and the word
 * count behind the reading-time estimate. Pure string work — no DOM, no
 * database — shared by the reading index and the file route, so the anchors
 * the outline names are exactly the ones the served document carries.
 */

/** One heading of a report: a section (h2) or a subsection (h3). */
export interface ReportOutlineEntry {
  /** The heading's element id in the served document; the reader jumps to it. */
  id: string;
  text: string;
  level: 2 | 3;
}

/** Longest outline entry kept, in characters. */
const OUTLINE_TEXT_MAX_LENGTH = 140;
/** Outline entries kept per report; anything past this is a wall, not a map. */
const OUTLINE_MAX_ENTRIES = 80;
/** Reading speed behind the estimate, in words per minute. */
const WORDS_PER_MINUTE = 230;
/** Prefix of the ids given to headings the document left unnamed. */
const GENERATED_ID_PREFIX = "scope-section-";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

/** Decodes the named and numeric character references reports may contain. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body.length > 1 && (body[1] === "x" || body[1] === "X");
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Strips tags, decodes entities, and collapses whitespace to one line. */
export function toPlainText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function clampOutlineText(text: string): string {
  return text.length <= OUTLINE_TEXT_MAX_LENGTH
    ? text
    : `${text.slice(0, OUTLINE_TEXT_MAX_LENGTH - 1).trimEnd()}…`;
}

/** An h2/h3 element, or a comment to step over (headings in it are not real). */
const HEADING_PATTERN = /<!--[\s\S]*?-->|<h([23])\b([^>]*)>([\s\S]*?)<\/h\1\s*>/gi;
const ID_ATTRIBUTE = /(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * Gives every h2 and h3 an id — keeping the ones the document already has —
 * and lists them in document order. The returned html is the document the
 * reader should load for the outline's ids to resolve; it differs from the
 * input only by the added id attributes. An h3 before the first h2 is a
 * section of its own (briefs written from Markdown start at h3), not a
 * subsection of nothing.
 */
export function anchorReportHeadings(html: string): {
  html: string;
  outline: ReportOutlineEntry[];
} {
  const outline: ReportOutlineEntry[] = [];
  let generated = 0;
  let seenSection = false;
  const anchored = html.replace(
    HEADING_PATTERN,
    (match, level: string | undefined, attributes: string, inner: string) => {
      if (level === undefined) {
        return match;
      }
      const existing = ID_ATTRIBUTE.exec(attributes);
      const existingId = existing ? (existing[1] ?? existing[2] ?? existing[3] ?? "").trim() : "";
      let id = existingId ? decodeHtmlEntities(existingId) : "";
      let tag = match;
      if (!id) {
        generated += 1;
        id = `${GENERATED_ID_PREFIX}${generated}`;
        const cleaned = existing ? attributes.replace(ID_ATTRIBUTE, "") : attributes;
        tag = `<h${level} id="${id}"${cleaned}>${inner}</h${level}>`;
      }
      const text = toPlainText(inner);
      seenSection ||= level === "2";
      if (text && outline.length < OUTLINE_MAX_ENTRIES) {
        outline.push({
          id,
          text: clampOutlineText(text),
          level: seenSection && level === "3" ? 3 : 2,
        });
      }
      return tag;
    },
  );
  return { html: anchored, outline };
}

/** Removes everything that is document furniture rather than prose. */
function withoutFurniture(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ")
    .replace(/<(title|style|script|template|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, " ");
}

/**
 * Drops the source appendices the app's own briefs append after the prose:
 * an X Dashboard brief's `<div class="sources">` list and a research brief's
 * archive of `<details>` posts. AI-written reports use neither (their markup
 * brief has no such element), so for them this is a no-op.
 */
function withoutAppendices(html: string): string {
  const withoutDetails = html.replace(/<details\b[\s\S]*?<\/details\s*>/gi, " ");
  const appendix = /<div\b[^>]*\bclass\s*=\s*["']sources["'][^>]*>/i.exec(withoutDetails);
  return appendix ? withoutDetails.slice(0, appendix.index) : withoutDetails;
}

function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.,-]*/gu)?.length ?? 0;
}

/**
 * Drops the headline and standfirst, which the search index keeps in their
 * own columns: left in the body they would make every snippet for a title
 * match open on the title the rail already shows.
 */
function withoutIdentity(html: string): string {
  return html
    .replace(/<h1\b[\s\S]*?<\/h1\s*>/gi, " ")
    .replace(
      /<p\b[^>]*class\s*=\s*(?:"[^"]*\bdek\b[^"]*"|'[^']*\bdek\b[^']*')[^>]*>[\s\S]*?<\/p\s*>/gi,
      " ",
    );
}

export interface ReportDocumentSummary {
  /** The visible words below the headline and standfirst, for full-text search. */
  text: string;
  /** Words of the prose itself (appendices excluded), for reading time. */
  wordCount: number;
  outline: ReportOutlineEntry[];
}

/** Everything the Reports page reads from a document: text, length, outline. */
export function summarizeReportDocument(html: string): ReportDocumentSummary {
  const { outline } = anchorReportHeadings(html);
  const visible = withoutFurniture(html);
  return {
    text: toPlainText(withoutIdentity(visible)),
    wordCount: countWords(toPlainText(withoutAppendices(visible))),
    outline,
  };
}

/** Minutes a read of `wordCount` words takes, never less than one. */
export function readingMinutes(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));
}
