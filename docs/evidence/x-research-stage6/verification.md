# Stage 6 verification — 2026-10-02

Implemented the research experience on the existing Stage 5 engine. No new X
provider capabilities, embeddings, retrieval schedules or sampling were added.

## Automated checks

- Final full suite: `npm test` — **1,068 passed, 8 skipped**, 97 passing files.
  CLI/socket fixtures require local process permissions; the sandbox-only run
  was interrupted after process-fixture refusals and rerun with those permissions.
- `npm run typecheck` and targeted ESLint covering X Research, corpus integration,
  chat/report routes, thread/report repositories and activity — pass, no warnings.
- `npm run check:migration` — pass, fresh database includes migration 021 and
  conversation turn links.
- `SCOPE_NEXT_DIST_DIR=.next-stage6-build npm run build -- --webpack` — pass.
- `tests/unit/x-research-experience.test.ts`: full-corpus follow-up and report
  routing with 45 posts despite one final citation; >4 MB original text fully
  scanned and exported without legacy materialization; frozen text after archive
  mutation and creator/thread deletion; idempotent saving/assistant persistence;
  unverified-report refusal; XSS escaping/CSP; origin and ambiguous-scope guards;
  one executing turn per conversation; explicit prior-context abridgement.
  Stage 5's unchanged 10,000-post/20-creator benchmark and relevance checks also
  pass in the full suite.

## Browser workflow

Used agent-browser with an isolated session, local dev server on port 3106,
`/tmp/scope-stage6-browser.sqlite`, Stage 4's fictional archive seed and the
[deterministic CLI fixture](codex-fixture.cjs). These are real UI and application
API executions with a simulated AI provider, not a new live-provider evaluation.
The actual provider integration and X pagination evidence remain in Stages 1,
3 and 5; no user archive or live X account was changed.

- Prepared a whole-list question, selected Quick and the existing searchable
  model picker by keyboard, submitted an estimate, and started the Full scan.
  Estimate showed 78 eligible/81 frozen records and explicit exclusions; no
  inference ran before Start. Verified failure state, Cancel and manual Resume.
- Shared activity showed phase, validated progress and a Stop action during the
  run. Scan produced 76 relevant and one uncertain result; all 77 remained
  accessible across three pages even though the answer cited two posts.
- Inspected both answer citations and related-post records in the adjacent
  frozen evidence panel. Full text, author, quote/context, timeline attribution,
  original X link and media exclusions remained explicit. Unspecified comparison
  dimensions stayed unspecified and interpretation was labeled.
- Saved the completed brief to Reports and verified its Open report action and
  full source count. Submitted a question-specific follow-up with Ctrl+Enter,
  then completed a new scan of the same scope. AI Chat history reopened that
  conversation in X Research with turn navigation and the saved answer.
- Related topic prepared an explicit new revision and contextual question; a
  separate estimate/job had its own Cancel/Resume state. Exact search and
  post-selection Ask actions preserve their own explicit scope boundaries.
- Updated fictional mutable post 1000 and removed Beta from the list through
  the list editor. Original answer/source still contained
  `Ethereum lower fees fixture 0 speculation`, two creators, and original scope
  `983f40de-d0fe-4c49-9576-3606104953eb`; the current list had one creator. Saved
  report retained all 81 frozen records and the original text, with no changed
  archive text. See [snapshot before mutation](snapshot-before.json) and
  [final storage verification](browser-storage.json).
- Interrupted an actual run just after its first committed batch: 13 reviewed,
  65 unfinished, two attempted calls. Reopened the same server/profile: paused,
  identical scope/counts/calls, no automatic inference. Manual Resume completed
  78/78 with zero unfinished and 13 cumulative calls. See
  [restart checkpoint](restart-before.json) and [restart result](restart-after.json).
- Checked desktop and 390 px narrow layouts, keyboard model/question controls,
  scrollable comparison/results, missing/partial/empty states and renderer errors.
  September 1–30 was entered through native keyboard date controls: zero eligible
  posts produced a qualified empty answer, one missing-date exclusion and zero
  inference calls. A manual refresh/cancel smoke check retrieved zero pages and
  changed no archive data; all other browsing/scope/analysis actions made no X reads.
  Narrow document width was 375 px within a 390 px viewport, evidence width
  309 px. [Desktop](desktop.png) and [narrow](narrow.png) captures show the research
  experience. Read-error recovery and final empty-period checks were retested.

## Boundaries

Full scan covers eligible frozen cached text, not exhaustive X history or
perfect relevance. Provider and work limits can leave visible partial runs.
Saved briefs render verified findings without a second inference step and keep
an immutable full-corpus source appendix; they do not claim unreviewed media or
linked pages were analyzed. Conversational reference context is bounded and
explicitly marked when abridged; each follow-up still scans the full saved
corpus. Existing small manual mixed-source chat/report limits remain intact.
