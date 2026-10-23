import { ResearchInputError } from "./input";
import type { ExactSearch } from "./model";

/** Each line is a literal word/phrase, never caller-supplied FTS syntax. */
export function parseExactSearch(input: {
  terms?: unknown;
  aliases?: unknown;
  exclusions?: unknown;
}): ExactSearch {
  function lines(value: unknown): string[] {
    if (value === undefined || value === null || value === "") return [];
    if (typeof value !== "string" || value.length > 2000)
      throw new ResearchInputError("Use up to 12 search phrases per field, one per line.");
    const result = [
      ...new Set(
        value
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    if (result.length > 12 || result.some((s) => s.length > 150 || /\p{Cc}/u.test(s)))
      throw new ResearchInputError("Use up to 12 phrases per field and 150 characters per phrase.");
    // Punctuation-only input has no searchable tokens in the Unicode tokenizer.
    if (result.some((s) => !/[\p{L}\p{N}]/u.test(s)))
      throw new ResearchInputError("Each search phrase needs a word or ticker.");
    return result;
  }
  const search = {
    terms: lines(input.terms),
    aliases: lines(input.aliases),
    exclusions: lines(input.exclusions),
  };
  if (!search.terms.length && !search.aliases.length)
    throw new ResearchInputError("Enter an exact term, phrase, or alias to search the archive.");
  return search;
}

export function literalPhrase(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function exactSearchExpression(search: ExactSearch): string {
  const required = search.terms.map(literalPhrase);
  if (search.aliases.length) required.push(`(${search.aliases.map(literalPhrase).join(" OR ")})`);
  const positive = `(${required.join(" AND ")})`;
  const expression = search.exclusions.length
    ? `${positive} NOT (${search.exclusions.map(literalPhrase).join(" OR ")})`
    : positive;
  // Quoted speech stays separately indexed and cannot count as authored mentions.
  return `text : (${expression})`;
}

/** Unicode61 does not segment CJK text into words. Match its literal phrases
 * within authored text, while keeping word boundaries/FTS behavior elsewhere. */
export function exactSearchFilter(search: ExactSearch): {
  sql: string;
  params: Record<string, string>;
} {
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  if (![...search.terms, ...search.aliases, ...search.exclusions].some((term) => cjk.test(term))) {
    return {
      sql: "text_rowid IN (SELECT rowid FROM x_tweet_text WHERE x_tweet_text MATCH @match)",
      params: { match: exactSearchExpression(search) },
    };
  }
  const params: Record<string, string> = {};
  let index = 0;
  const phrase = (term: string): string => {
    const key = `phrase${index++}`;
    params[key] = cjk.test(term) ? term : `text : ${literalPhrase(term)}`;
    return cjk.test(term)
      ? `instr(lower(text), lower(@${key})) > 0`
      : `text_rowid IN (SELECT rowid FROM x_tweet_text WHERE x_tweet_text MATCH @${key})`;
  };
  const required = search.terms.map(phrase);
  if (search.aliases.length) required.push(`(${search.aliases.map(phrase).join(" OR ")})`);
  const excluded = search.exclusions.map(phrase);
  return {
    sql: `(${required.join(" AND ")})${excluded.length ? ` AND NOT (${excluded.join(" OR ")})` : ""}`,
    params,
  };
}
