/**
 * A small, dependency-free Markdown parser for AI insights: headings,
 * paragraphs, nested lists, quotes, tables, code blocks, rules, and inline
 * bold/italic/code/links plus [post:<id>] citations. The React view and the
 * saved-report HTML share it; neither ever injects raw HTML from the model.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "cite"; ids: string[] };

export interface ListItem {
  text: string;
  children: ListBlock | null;
}
export interface ListBlock {
  kind: "list";
  ordered: boolean;
  start: number;
  items: ListItem[];
}
export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | ListBlock
  | { kind: "quote"; text: string }
  | { kind: "table"; header: string[]; align: Array<"left" | "center" | "right">; rows: string[][] }
  | { kind: "code"; text: string }
  | { kind: "rule" };

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function parseList(lines: string[], start: number): { block: ListBlock; next: number } {
  const first = LIST_ITEM.exec(lines[start])!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const block: ListBlock = {
    kind: "list",
    ordered,
    start: ordered ? Number.parseInt(first[2], 10) : 1,
    items: [],
  };
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends the list unless the next line continues it.
      const ahead = lines[i + 1];
      const match = ahead ? LIST_ITEM.exec(ahead) : null;
      if (match && match[1].length >= indent) {
        i++;
        continue;
      }
      break;
    }
    const match = LIST_ITEM.exec(line);
    if (match && match[1].length === indent) {
      block.items.push({ text: match[3], children: null });
      i++;
    } else if (match && match[1].length > indent && block.items.length) {
      const nested = parseList(lines, i);
      block.items.at(-1)!.children = nested.block;
      i = nested.next;
    } else if (!match && /^\s+\S/.test(line) && block.items.length) {
      block.items.at(-1)!.text += ` ${line.trim()}`;
      i++;
    } else break;
  }
  return { block, next: i };
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const header = cells(line);
      const align = cells(lines[i + 1]).map((cell) =>
        cell.startsWith(":") && cell.endsWith(":")
          ? ("center" as const)
          : cell.endsWith(":")
            ? ("right" as const)
            : ("left" as const),
      );
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        const row = cells(lines[i++]);
        rows.push(header.map((_, column) => row[column] ?? ""));
      }
      blocks.push({ kind: "table", header, align: header.map((_, c) => align[c] ?? "left"), rows });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        body.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    const body: string[] = [line.trim()];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !LIST_ITEM.test(lines[i]) &&
      !/^\s*(>|```)/.test(lines[i]) &&
      !(lines[i].includes("|") && TABLE_DIVIDER.test(lines[i + 1] ?? ""))
    )
      body.push(lines[i++].trim());
    blocks.push({ kind: "paragraph", text: body.join("\n") });
  }
  return blocks;
}

// Underscore emphasis only counts at word edges, so handles like @solana_sam stay intact.
const INLINE =
  /(\[post:\d{1,20}\](?:[\s,;]*\[post:\d{1,20}\])*)|(`[^`\n]+`)|(\*\*[^*\n]+\*\*|(?<![\p{L}\p{N}_@])__[^_\n]+__(?![\p{L}\p{N}_]))|(\*[^*\s][^*\n]*\*|(?<![\p{L}\p{N}_@])_[^_\s][^_\n]*_(?![\p{L}\p{N}_]))|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))/gu;

export function parseInline(text: string): Inline[] {
  const result: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) result.push({ kind: "text", text: text.slice(last, index) });
    const [whole, cite, code, strong, em, link, href] = match;
    if (cite) {
      result.push({ kind: "cite", ids: [...cite.matchAll(/\d{1,20}/g)].map((m) => m[0]) });
    } else if (code) result.push({ kind: "code", text: code.slice(1, -1) });
    else if (strong) result.push({ kind: "strong", children: parseInline(strong.slice(2, -2)) });
    else if (em) result.push({ kind: "em", children: parseInline(em.slice(1, -1)) });
    else if (link && href)
      result.push({
        kind: "link",
        href,
        children: parseInline(whole.slice(1, whole.indexOf("]("))),
      });
    last = index + whole.length;
  }
  if (last < text.length) result.push({ kind: "text", text: text.slice(last) });
  return result;
}

/** Plain text without Markdown or citations, for titles and previews. */
export function markdownPreview(source: string, length = 160): string {
  const text = source
    .replace(/\[post:\d+\]/g, "")
    .replace(/[#>*_`|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}
