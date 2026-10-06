# X Research Stage 4 verification — 2026-10-02

Stage 4 adds local lexical search to the persistent archive. Related-topic
classification, durable research scope/evidence snapshots and answer execution
remain Stages 5–6. No remote search was added: Stage 1 deferred that capability.

## Implementation

- Migration `018` creates an external-content SQLite FTS5 index over canonical
  post text and separately attributable quoted text. Insert, changed-text update
  and delete triggers maintain it in the archive write transaction. A one-time
  rebuild indexes existing archived posts. The local bundled SQLite is 3.53.4,
  with `ENABLE_FTS5` enabled. The trigger/rebuild design follows the
  [SQLite FTS5 external-content documentation](https://www.sqlite.org/fts5.html#external_content_tables).
- Exact search uses only the post-text column. Every required line is a literal
  word/phrase, every alias line belongs to an explicit OR group, and any matched
  exclusion line removes the post. Case-insensitive Unicode token matching keeps
  `$` in tickers, preserves diacritics, and treats other punctuation as word
  separators. User text is both quoted/escaped for FTS and bound as SQL parameters;
  operators, column selectors and wildcards cannot become caller-supplied syntax.
- Creator membership, publication/repost event dates and post types are resolved
  before deduplication. Count and page reads share a SQLite snapshot; results
  remain chronological and paginated at 30 posts. If text updates shrink the
  result set beneath an open page, the server returns the last available page
  and the UI uses that resolved page for navigation. Explanations identify the matched
  required terms and actual aliases in the original author's text/commentary.
  Quoted-only matches never count as creator mentions.
- Search reports scoped corpus size, incomplete/missing text and coverage limits.
  Old requested dates retain their bounds, including inclusive timezone/DST dates.
- Ask actions deliberately prepare a question-scope draft for the list/creator
  scope, all exact results, or explicit selected tweet IDs across pages. List and
  selected-post scopes do not inherit a browsing topic query. Drafts show their
  creator/date/type scope and stay unchanged when browsing filters change.
  They are visit-local preparation, not executed analyses, saved conversations
  or immutable evidence snapshots. There is no legacy 25-source truncation.

## Automated checks

- `npm test`: **1,043 passed, 7 skipped, 93 suites passed**. The skipped tests
  include opt-in live integration cases. Full-suite execution required local
  subprocess access for existing fake CLI/provider fixtures.
- Targeted tests: **106 passed across eight suites**, covering search, cached
  research, durable retrieval, retrieval routes/validation, X service, migrations
  and database durability.
- Eleven new search tests verify upgrade/backfill and reopen, exact phrase/alias/
  exclusion semantics, quoted-text attribution, SQL/FTS escaping, all 77 matches
  across three pages, scoped deduplication, old dates, missing dates/text,
  membership validation, route errors, text hydration/preservation/replacement,
  deletions, rollback and recovery when text changes remove the open page. FTS integrity checks compare the index with canonical
  archive content.
- Durable retrieval tests additionally check index consistency after the actual
  2,000-plus-15 catch-up fixture and an interrupted initial import followed by
  close/reopen/manual resume. The initial import's recurring historical pin stays
  indexed but excluded from the requested date window.
- Clean-database gate now enumerates migrations `015`–`018` and all research,
  retrieval and FTS tables, and checks FTS integrity.
- TypeScript, targeted ESLint, `npm run check:migration`, the isolated Webpack
  production build and `git diff --check`: passed.

## Browser checks

Used agent-browser with the default Turbopack development server on
`http://127.0.0.1:3104`, a temporary SQLite database, and fictional fixture data.
The checked-in [seed script](seed-browser.cjs) refuses a nonempty library. It
inserts 85 canonical posts, two selected list creators, an outside creator,
quoted-only text, missing/truncated text, old posts, a reply and a repost event.
This is local-search evidence, not live X retrieval evidence.

1. Search for required phrase `lower fees`, aliases `ETH`, `Ethereum`, `$ETH`,
   excluding `speculation`: **61 local matches in 80 scoped posts**. Two scoped
   posts have incomplete/missing text. Outside-creator and quoted-only text are
   excluded.
2. Pages show **1–30**, **31–60**, and **61–61**. The last page disables Next;
   Previous returns to the preceding page. All 61 results remain accessible.
3. Pick post `1076` on page one and `1038` on page two: the selected scope contains
   two posts across pages. The all-results scope contains 61 posts. Ask about
   the list switches explicitly to all 80 scoped posts without inheriting the
   search. Draft-question text remains editable and no analysis is dispatched.
4. Excluding replies yields **60 matches** and resets pagination. Selecting only
   Beta yields the one shared match with correct scoped provenance. An empty
   creator selection produces the qualified selection state. Opting into reposts
   yields **62 matches**, including an old original shared in the current period.
5. Use native date-field keyboard events to request only **2026-03-29** in
   **Europe/Amsterdam**: exactly the historical post `2000` at 20:00 UTC matches.
   Post `2001` at 22:00 UTC is outside the inclusive calendar day. Recent cached
   posts are not substituted.
6. A nonexistent phrase gives a qualified empty result. Punctuation-only input
   gives a validation error. Correcting the query recovers normally. Clearing
   search returns to the 80-post feed without changing creator/date/type filters.
7. Keyboard Tab moves from exclusions to Search archive, and Enter submits,
   returning pagination to page one. Opening Details for the shortened exact
   match offers explicit full-text retrieval; Escape closes the dialog and
   restores the Details trigger without starting retrieval.
8. Desktop (1440 × 1000) and narrow (390 × 844) layouts were inspected. Narrow
   document width is **375px** with no horizontal overflow. Search fields stack,
   actions wrap, and pagination remains operable. See [desktop](desktop.png),
   [narrow search](narrow.png) and [narrow scope](narrow-scope.png) screenshots.
9. Fresh final-session [browser error evidence](browser-errors.json) reports no
   renderer errors. The temporary database remains **85 posts, zero retrieval
   jobs** after search, filtering, paging, question preparation and reopening.

10. While requesting page three, simulate a failed local read and revise 30
    matching fixture bodies in an archive transaction. Retry cached read returns
    **page 2 of 2, showing 31–31 of 31**, rather than a false empty state. Previous
    reaches all earlier results. Restoring the fixture recovers all 61 matches
    and all three pages; index integrity passes throughout. See the
    [shrinking-page evidence](shrinking-page.json). No retrieval job is created.

The first optional Webpack development-server attempt hit an existing Node-only
instrumentation bundling error. The default Turbopack development server and
Webpack production build both passed. Final checks used a fresh browser session
so prior development-start errors were not mixed with successful UI evidence.

## Remaining scope

Exact matching operates on available cached text; incomplete or unretrieved
text can contain additional matches. Explicit aliases are lexical alternatives,
not contextual classification or endorsement. Related-topic judgments and saved,
server-resolved question/evidence scopes require the research engine and research
experience in Stages 5–6. No network retrieval, remote search or automatic resume
was introduced by search.
