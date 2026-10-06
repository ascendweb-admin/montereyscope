/**
 * Pure WebVTT → plain-text conversion for scope transcripts.
 * No filesystem, network, process, or time access — trivially testable.
 *
 * Guarantees:
 * - Removes the WEBVTT header/metadata, STYLE/REGION/NOTE blocks, cue
 *   identifiers, timing lines, and cue positioning settings
 *   ("align:start position:0%").
 * - Removes inline markup (<c>, </c>, <i>, styled/classed tags, word-level
 *   timestamps like <00:00:04.880>, <rt> ruby pronunciation guides) while
 *   keeping the visible caption text.
 * - Preserves meaningful speaker labels: a leading <v Name …> voice tag
 *   becomes "Name: ".
 * - Collapses YouTube-style rolling captions: when consecutive cues are
 *   temporally contiguous, leading lines that exactly repeat the tail of
 *   what was already emitted are dropped, along with the short
 *   confirmation-only cues YouTube interleaves. The temporal gate keeps
 *   legitimate repeated speech intact whenever there is any real pause,
 *   and repetition inside a single cue is never touched.
 * - Decodes HTML entities (named and numeric) so Unicode survives intact;
 *   &nbsp; becomes a regular space. Punctuation is never altered.
 * - Joins cue lines into flowing paragraphs; a new paragraph starts on a
 *   speaker change, a temporal gap, or an oversized paragraph.
 *
 * Known limits (deliberate):
 * - Mid-cue voice tags other than a leading one lose their label text.
 * - Ruby base text is kept inline; only <rt> phonetic hints are removed.
 *
 * Never throws for odd-but-valid content: anything structurally unusable
 * raises VttParseError with a stable code instead of returning markup.
 */

export type VttParseErrorCode = "empty" | "not_webvtt" | "malformed";

export class VttParseError extends Error {
  readonly code: VttParseErrorCode;

  constructor(code: VttParseErrorCode, message: string) {
    super(message);
    this.name = "VttParseError";
    this.code = code;
  }
}

interface Cue {
  /** Start time in milliseconds. */
  startMs: number;
  /** End time in milliseconds. */
  endMs: number;
  /** Speaker label from a leading voice tag, or null. */
  speaker: string | null;
  /** Visible text lines after markup removal and entity decoding. */
  lines: string[];
}

/** Cues within this slack of the previously kept cue count as rolling. */
const CONTIGUITY_SLACK_MS = 120;
/** A silence longer than this starts a fresh paragraph. */
const PARAGRAPH_GAP_MS = 2_500;
/** Hard cap so one long monologue cannot become a single mega-paragraph. */
const MAX_PARAGRAPH_CHARACTERS = 1_200;
/** How many recently emitted lines the rolling matcher remembers. */
const ROLLING_WINDOW_LINES = 16;

const TIMESTAMP_PATTERN = /(?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;

function parseTimestamp(raw: string): number {
  const normalized = raw.replace(",", ".");
  const [timePart, millisRaw = "0"] = normalized.split(".");
  const chunks = timePart.split(":");
  const seconds = Number.parseInt(chunks[chunks.length - 1] ?? "0", 10);
  const minutes = chunks.length >= 2 ? Number.parseInt(chunks[chunks.length - 2], 10) : 0;
  const hours = chunks.length >= 3 ? Number.parseInt(chunks[chunks.length - 3], 10) : 0;
  const millis = Number.parseInt((millisRaw + "000").slice(0, 3), 10);
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + millis;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  lrm: "\u200e",
  rlm: "\u200f",
};

/** Decodes WebVTT character references; unknown entities pass through untouched. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const codePoint = Number.parseInt(body.slice(2), 16);
      return Number.isInteger(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (body.startsWith("#")) {
      const codePoint = Number.parseInt(body.slice(1), 10);
      return Number.isInteger(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/**
 * Extracts a speaker label from a leading <v Name> voice tag.
 * Returns the label (or null) plus the cue text without that opening tag.
 */
function extractLeadingSpeaker(cueText: string): { speaker: string | null; rest: string } {
  const match = cueText.match(/^\s*<v(?:\.[^\s>]*)?\s+([^>]*?)>/);
  if (!match) {
    return { speaker: null, rest: cueText };
  }
  const label = (match[1] ?? "").trim();
  return {
    speaker: label.length > 0 ? label : null,
    rest: cueText.slice((match.index ?? 0) + match[0].length),
  };
}

/** Strips <rt>…</rt> phonetic hints, then every remaining inline tag. */
function stripInlineMarkup(text: string): string {
  return text.replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, "").replace(/<[^>]*>/g, "");
}

function parseCueBlock(blockLines: string[]): Cue | null {
  const timingIndex = blockLines.findIndex((line) => line.includes("-->"));
  if (timingIndex === -1) {
    return null;
  }
  const timingLine = blockLines[timingIndex];
  const times = timingLine.match(new RegExp(TIMESTAMP_PATTERN.source, "g"));
  if (!times || times.length < 2) {
    throw new VttParseError("malformed", "Cue timing line could not be parsed.");
  }
  // Everything after the end timestamp on the timing line is cue settings
  // (positioning/alignment) — intentionally discarded.
  const rawPayload = blockLines.slice(timingIndex + 1).join("\n");
  const { speaker, rest } = extractLeadingSpeaker(rawPayload);
  const cleaned = decodeEntities(stripInlineMarkup(rest));
  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return {
    startMs: parseTimestamp(times[0]),
    endMs: parseTimestamp(times[1]),
    speaker: lines.length > 0 ? speaker : null,
    lines,
  };
}

/**
 * Largest k such that lines[0..k) equals the tail of `recent` — the amount
 * of rolling duplication at the front of this cue. Exact matches only, so
 * near-miss repeats stay visible.
 */
function rollingOverlapCount(lines: string[], recent: readonly string[]): number {
  const maxK = Math.min(lines.length, recent.length);
  for (let k = maxK; k > 0; k -= 1) {
    let matched = true;
    for (let i = 0; i < k; i += 1) {
      if (recent[recent.length - k + i] !== lines[i]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return k;
    }
  }
  return 0;
}

/**
 * Converts a WebVTT subtitle document into clean plain text.
 * Throws VttParseError for empty input, non-WebVTT content, or malformed
 * structure — callers must treat those as extraction failures, never store
 * partial output.
 */
export function vttToPlainText(input: string): string {
  const withoutBom = input.replace(/^\uFEFF/, "");
  const normalized = withoutBom.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) {
    throw new VttParseError("empty", "The caption file is empty.");
  }

  const blocks = normalized.split(/\n{2,}/);
  const header = (blocks[0]?.split("\n")[0] ?? "").trim();
  if (!header.startsWith("WEBVTT")) {
    throw new VttParseError("not_webvtt", "The caption file is not in WebVTT format.");
  }

  const cues: Cue[] = [];
  for (let blockIndex = 1; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const blockLines = block.split("\n");
    const first = blockLines[0].trim();
    if (
      first.length === 0 ||
      first.startsWith("NOTE") ||
      first.startsWith("STYLE") ||
      first.startsWith("REGION")
    ) {
      continue;
    }
    const cue = parseCueBlock(blockLines);
    if (cue) {
      cues.push(cue);
    } else {
      throw new VttParseError(
        "malformed",
        "The caption file contains a block that is neither metadata nor a timed cue.",
      );
    }
  }

  if (cues.length === 0) {
    throw new VttParseError("empty", "The caption file contains no readable cues.");
  }

  // Collapse rolling duplication across temporally contiguous cues.
  const kept: Cue[] = [];
  let recentLines: string[] = [];
  let previousEndMs: number | null = null;

  for (const cue of cues) {
    const contiguous = previousEndMs !== null && cue.startMs <= previousEndMs + CONTIGUITY_SLACK_MS;
    let lines = cue.lines;
    if (contiguous && recentLines.length > 0) {
      const overlap = rollingOverlapCount(lines, recentLines);
      if (overlap > 0) {
        lines = lines.slice(overlap);
      }
    }
    if (lines.length > 0) {
      kept.push({ ...cue, lines });
      recentLines = recentLines.concat(lines);
      if (recentLines.length > ROLLING_WINDOW_LINES) {
        recentLines = recentLines.slice(recentLines.length - ROLLING_WINDOW_LINES);
      }
    }
    // Even fully-duplicated cues advance the rolling timeline.
    previousEndMs = Math.max(previousEndMs ?? cue.endMs, cue.endMs);
  }

  if (kept.length === 0) {
    throw new VttParseError("empty", "The caption file contained only duplicated filler.");
  }

  // Assemble paragraphs: break on speaker change, temporal gap, or size cap.
  const paragraphs: string[] = [];
  let currentParagraph = "";
  let previousSpeaker: string | null = null;
  let previousKeptEndMs: number | null = null;

  for (const cue of kept) {
    const speakerChanged = cue.speaker !== null && cue.speaker !== previousSpeaker;
    const segment = speakerChanged ? `${cue.speaker}: ${cue.lines.join(" ")}` : cue.lines.join(" ");
    const startsNewParagraph =
      currentParagraph.length === 0 ||
      speakerChanged ||
      (previousKeptEndMs !== null && cue.startMs - previousKeptEndMs > PARAGRAPH_GAP_MS) ||
      currentParagraph.length + segment.length + 1 > MAX_PARAGRAPH_CHARACTERS;

    if (startsNewParagraph) {
      if (currentParagraph.length > 0) {
        paragraphs.push(currentParagraph);
      }
      currentParagraph = segment;
    } else {
      currentParagraph = `${currentParagraph} ${segment}`;
    }

    previousSpeaker = cue.speaker ?? previousSpeaker;
    previousKeptEndMs = cue.endMs;
  }
  if (currentParagraph.length > 0) {
    paragraphs.push(currentParagraph);
  }

  return paragraphs.join("\n\n").trim();
}
