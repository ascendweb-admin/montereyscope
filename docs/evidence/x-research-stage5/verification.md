# X Research Stage 5 verification — 2026-10-02

Stage 5 implements the research engine and its guarded APIs. Ask & compare,
related-topic browsing, activity UI, conversations and saved Reports are Stage 6.

## Delivered

- Migrations `019`–`020`: immutable corpus revisions and original post snapshots,
  normalized frozen author/sharer memberships, durable jobs, batch manifests,
  long-post segment checkpoints, post dispositions and evidence. Scope/job links
  are available on existing chat/report records without changing their legacy
  execution paths. Snapshot rows have no live creator/tweet foreign key: library
  deletion cannot erase answer-time source text. Migration 020 also backfills
  memberships from existing 019 snapshots.
- `lib/x/research/corpus.ts` resolves the list/creator/calendar/timezone/type
  request locally, scopes memberships before deduplication and freezes source
  text, quotes, sharing-event provenance, parent context, versions and retrieval
  coverage in one SQLite transaction. Exact/selected question scopes are explicit;
  unavailable/truncated text and unknown dates remain counted exclusions. There
  is no X retrieval or legacy 25-source/4 MB materialization path.
- `analysis-planner.ts`, `analysis-prompts.ts`, `analysis-validation.ts`: conservative
  token/output-aware planning, whole-corpus question-specific relevance/extraction,
  labeled Unicode-safe long-post segmentation, per-unit schema/source/excerpt/
  attribution validation, reduction coverage manifests, cross-creator evidence
  retention, grounded synthesis and separate original-source support checking.
  Parent context is labeled and cannot become in-range claim evidence.
- `analysis.ts` and `analysis-store.ts`: one server-owned AI call at a time,
  independent of X's queue; transactional evidence/checkpoint commits; bounded
  context/malformed-output splitting and retries; configurable attempt token/call/
  time and payload budgets; conservative vs reported usage; Cancel, manual Resume,
  provider error isolation and startup recovery to paused. Completed checkpoints
  survive restart. Segmented posts count only when all segments validate. Validated
  findings and separately paginated relevant/uncertain posts survive answer failure.
- Compatible results require exact question/content-version/strategy/backend/model/
  effort/mode/prompt/context/output manifests. Cached outputs are revalidated.
  Synthesis/verification reuse requires a complete verified originating job. A
  rejected answer is withheld and manually resumable, without repeating Full scan.
- Guarded submit/estimate, status/result/source, Cancel and Resume routes in
  `app/api/x-research/analysis/`. Instrumentation performs recovery without starting
  inference. API details and Stage 6 integration contract are in [api.md](api.md).
- The process-global scheduler exposed a Next module-graph error identity issue
  in browser testing. Research input errors now use a Symbol.for brand, preserving
  correct 400/404 responses across instrumentation/routes/HMR. A regression test
  covers this. Provider verification initially confused global candidate indexes
  with local array indexes; internal indexes are now hidden from provider input
  and the prompt defines the local zero-based schema explicitly.

## Automated checks

- Final `npm test`: **1,063 passed, 8 skipped, 96 suites passed, 5 skipped**.
  This includes the deterministic 10,000-post benchmark and all prior stages.
  Existing CLI/socket fixtures require normal local subprocess access: the first
  sandboxed attempt failed in 33 existing subprocess tests; the unrestricted
  retest passed, and the final unrestricted suite passed after the fixes.
- `npm run typecheck`, targeted ESLint with no warnings,
  `npm run check:migration`, `git diff --check`, and the isolated production
  `SCOPE_NEXT_DIST_DIR=.next-stage5-build npm run build -- --webpack`: passed.
- New tests cover immutable source/context/quote snapshots through live cache
  changes, creator/list deletion and close/reopen; old requested dates and DST;
  exact/selected scope validation; shared memberships; disk rollback; input/output
  and Unicode segmentation; missing/duplicate/unknown dispositions; invented
  excerpts and wrong attribution; reduction manifest validation; uncited synthesis;
  withheld unsupported answers; context-limit shrink/retry; malformed singleton
  exhaustion; cancellation/late output; serialized jobs; interrupted/manual-only
  recovery; token/call budgets; reported usage; quota failures; estimates;
  qualified empty/uncertain results; complete related pagination; and exact cache
  compatibility across scope, question and model changes. Route tests cover the
  real mutation guard, body size/type/origin, controls, pages and source rejection.

## Large-corpus benchmark

The deterministic fixture has **10,000 eligible tweets across 20 creators** and
**7,505,550 bytes of original text** (over 4 MB). Two creators have five posts each;
the other eighteen have 555 each. Every creator has early bullish and late bearish
conditional arguments. The injected adapter preserves each distinct argument and
representative original evidence; it tests the pipeline, not model semantics.

Final measurements in [benchmark.json](benchmark.json): snapshot **16,479,385 bytes**,
freeze/planning about **1.5 s**, full deterministic engine about **87.7 s** while
running with the complete test suite. **1,128 batches/calls**: 920 screening,
167 bounded reductions, one synthesis and 40 source checks. All **10,000** posts
have validated dispositions, **zero** are unfinished, all 10,000 related records
remain accessible across 334 pages, and 40 distinct findings retain both views
from every creator, including the quiet creators. These are not live AI latency
or provider-cost measurements. Explicit larger attempt budgets were used; the
conservative defaults can checkpoint a large run as partial and require Continue.

## Real-provider relevance and grounding check

`SCOPE_X_ANALYSIS_LIVE=1 SCOPE_ANALYSIS_EVIDENCE_DIR=docs/evidence/x-research-stage5
npx vitest run tests/integration/x-analysis-live.test.ts` passed using the existing
Codex adapter, **gpt-5.6-luna**, quick mode/low effort, and only fictional fixtures.
No user archive or X network reads were used. The entire freeze/scan/reduce/
synthesize/verify path completed in approximately 137 s, with 14 calls and
225,290 reported tokens. This tiny evaluation is evidence of integration and
specific fixture behavior, not a general semantic accuracy or pricing guarantee.

[Fixtures and observed findings](live-relevance.json) cover ETH/$ETH/Ethereum,
indirect EIP-4844/blob/L1 value-accrual discussion, ordinary car gas, generic
stablecoin settlement, ETH Zurich, contradictory/conditional claims, an explicitly
reported changed view, quoted speech vs creator belief, sarcasm, BTC-only text,
and an embedded instruction attempting to invent sources. All 13 classifications
match the fixture expectations; measured fixture precision/recall/accuracy are
**1.0**. An out-of-range fourteenth post is excluded. The answer distinguishes
quoted predictions from creator positions, marks the sarcastic target as
interpretation, carries conditions/horizons and cites only original in-scope posts.
No embeddings or remote search were introduced.

## Browser verification

Agent-browser used isolated sessions and the default Turbopack dev server at
`http://127.0.0.1:3105/x-research` with `/tmp/scope-stage5-browser.sqlite`, seeded
from Stage 4's fictional browser fixture. This changed no real desktop archive.

- Submitted an estimate through the real browser: HTTP 202, paused, 78 eligible
  posts, 81 frozen records (one incomplete, one missing text, one missing date),
  seven estimated screening batches and zero inference calls.
- Inspected all-record page three (21 records) and unfinished page three
  (18 records); totals stay independent of feed pagination. Cancel returns
  cancelled. Manual Resume with a deliberately insufficient token budget returns
  to paused with zero calls and 78 explicitly unfinished posts. Empty questions
  return 400; an outside-creator source returns 404. See [browser-api.json](browser-api.json).
- Restarted the server on the same database and verified exact scope, source,
  counts and paused status survive without inference. Final startup exercises
  membership backfill and retains both selected creators' progress records.
- Changed cached fictional post 1001 after freezing; source inspection still
  returns its original `ETH lower fees fixture 1` and original version.
  See [browser-immutability.json](browser-immutability.json). Restored the mutable
  fixture after the check. No retrieval jobs were created.
- Clicked the real exact-search form, entered required phrase `lower fees`, aliases
  ETH/Ethereum/$ETH and exclusion `speculation`, and paged the 61 matching results.
  Checked creator filters, keyboard submission, desktop and narrow layouts,
  source details and renderer errors after the implementation fixes. Saved
  [Desktop](desktop.png), [narrow controls](narrow.png), [narrow search](narrow-search.png),
  [layout measurement](browser-layout.json) and [renderer errors](browser-errors.json)
  accompany this record. The final browser session had no renderer errors and
  the narrow document width was 375 px inside a 390 px viewport, with no overflow.
  [Database evidence](browser-storage.json) records 85 cached posts, zero retrieval
  jobs and one manually paused analysis job after the checks.

## Remaining boundaries

The backend makes corpus processing and evidence inspectable; Stage 6 still
connects it to Ask & compare/related-topic controls, activity progress, citations,
coherent saved conversations and corpus-aware report execution. Those controls
retain their Stage 4 availability until that integration is implemented. Existing
small mixed-source chat/report limits remain intact.

Provider context/output capabilities are not reported by the catalog, so the
planner uses conservative configurable ceilings and durable split/partial states,
not a universal capacity guarantee. Logical payload limits do not measure total
filesystem allocation. Reductions may condense findings but retain original
post evidence and reduction manifests; uncondensable findings remain partial.
Full scan proves processing coverage in the frozen eligible cache, not exhaustive
X history or perfect contextual relevance. Only the Codex provider was newly
live-tested; the other backends reuse the existing tested adapter boundary.
