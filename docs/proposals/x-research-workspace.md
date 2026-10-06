# X Research workspace proposal

Status: Stages 1–6 are implemented and verified. The X Research workspace
includes cached browsing, durable retrieval, search, research conversations
and saved briefs with immutable evidence snapshots.
Prepared 2026-10-01 against the current Scope codebase.
Updated with manual-only feed refresh and large-corpus analysis requirements.
Persistent tweet storage and incremental catch-up are explicit requirements.

## Recommendation

Add a dedicated **X Research** destination. Its central object is a saved,
local creator list, with a shared research scope consisting of creator
identities, an explicit date range, and included post types. That scope powers
a chronological feed, topic search, and an evidence-backed research conversation.

This is useful because market research often starts with a recurring group
of sources and a changing question. Saved lists remove repeated setup; the
archive preserves previously retrieved material; cited comparisons make
the result inspectable. The difficult part is establishing what was retrieved
and reviewed, rather than generating a fluent summary.

## Product boundaries

- Lists belong to Scope. Creating or editing one does not create a public X
  List, follow anyone, or change the connected X account.
- Creators have one shared library record keyed by stable X user identity.
  A creator can belong to several lists without duplicating cached posts.
- Retrieved tweets form a persistent local archive in the desktop profile's
  SQLite database. Closing Scope, restarting it, switching lists, or disconnecting
  X does not clear the archive. Display filters never act as retention limits.
- Lists are collections of creators; existing categories remain labels for
  organizing the broader library. Offer “Create list from X creators in this
  category,” taking a membership snapshot, rather than implicitly coupling
  category changes and research-list membership.
- Adding a creator from this workspace uses the existing resolved preview
  and saves to the shared library. Removing list membership keeps the creator.
  Deleting a list keeps creators and cached posts. Library deletion must disclose
  affected lists and preserve saved research source snapshots according to the
  existing report/chat deletion policy.
- The research measures what the selected creators said. It does not establish
  that their market claims are true or represent the whole market. Mention
  counts and reposts must not become implied market consensus or endorsements.
- Initial analysis uses available post text. Attached charts, videos, Articles,
  and linked pages are marked “not analyzed” unless a separate supported
  ingestion path actually processes them. Full post text is distinct from
  complete conversation or historical coverage.

## Interface

Add `/x-research` beside AI Research in the existing application sidebar.
Keep AI Research for the existing mixed video/tweet workflow.

The X workspace has a narrow list rail and a main content area. The rail shows
named lists, a New list action, and selectable creators for the current list.
The main area shows the list name, number of selected creators, date controls,
post-type controls, a **Refresh feed** button at the top, and a concise
freshness/coverage line. At small widths
the list picker moves above the main area and evidence stacks below the answer.

Use the existing quiet monochrome appearance and shared components. Keep
coverage details available through a disclosure, rather than putting technical
worker state in the ordinary research flow.

### Feed & search

- Selecting a list opens its chronological feed immediately from local cache.
- Support an ad hoc selection of saved X creators without requiring a list.
- Default to a requested last-seven-days window, with 24 hours, 30 days and
  custom inclusive calendar dates available. Display the user's timezone.
- Include authored originals, quote posts with the creator's own commentary,
  and replies by default. Reposts are opt-in and visibly attributed to the
  original author and the creator who shared them.
- Date filtering for authored research uses the post's publication time.
  Repost-inclusive browsing uses the repost event time and labels both dates
  when known. Missing event/publication timestamps cannot be assumed in range.
- Show a reverse chronological feed with full text expansion, thread-context
  availability, author, date, post type, and an Open on X link.
- Show exact-term results as a paginated collection, never as an AI-selected
  handful. Support literal phrases, ticker aliases and exclusions through
  clear controls; parameterize queries and escape search syntax.
- Separate **Exact terms** from **Related topic**. ETH, Ethereum and $ETH
  can be an explicit alias group. Indirect discussions of fees or settlement
  require contextual relevance judgment, not an assertion that every use of
  “gas” or “stablecoin” is about Ethereum. Show the match explanation.
- Provide “Ask about these results” and “Ask about selected tweets.” Both
  explicitly change the question scope. A topic field used for browsing does
  not silently constrain “Ask about this list.”
- Refresh is manual and incremental through the top **Refresh feed** button.
  There is no automatic refresh on app launch, list selection, window focus,
  or a timer. Cached content remains readable during network or session failure.

### Manual refresh behavior

**Refresh feed** fetches the newest available posts for all creators in the
active list, even when the user has narrowed the research selection. Label the
scope clearly, for example “Refresh Ethereum feed · 20 creators.” For an ad hoc
creator selection, the button refreshes those selected creators instead.

1. Immediately show the cached feed and the last refresh status. Opening or
   switching a list does not initiate timeline reads.
2. On click, snapshot the refresh membership and create a background job.
   Disable/coalesce duplicate clicks for that job; creators shared by concurrent
   list jobs reuse the same in-flight creator refresh.
3. Fetch each creator's newest timeline pages through the existing serialized X
   service. Continue through a validated overlap with previously retrieved head
   material rather than assuming a single page or first familiar post is enough.
   A creator without an initialized archive first gets a bounded initial-history
   fetch; later refreshes use its persisted catch-up checkpoint. Both expose their
   actual retrieval coverage, as described below.
4. Atomically merge each successful page into the shared cache and update the
   local search index. Count newly cached unique posts separately from refreshed
   post content and metrics. Do not reset or consume the older-history cursor.
5. Show progress such as “Refreshed 12 of 20 creators · 184 new posts.” Update
   each creator's successful checkpoint independently. A list with failed or
   unfinished creators remains partially refreshed even when other creators succeed.
6. Finish with a concrete result: newly cached posts, successfully refreshed
   creators, completion time, and any failures. Offer manual Retry/Resume and
   Cancel. Cached content stays usable throughout the operation.

Retries/backoff within a user-started job are bounded and respect provider
limits. They are not a recurring refresh schedule. After application restart,
interrupted jobs remain available to resume manually; startup does not silently
restart X retrieval. One creator failure does not discard another's results.

Refreshing the feed and fetching an older research period are separate actions.
The former checks the head of each timeline; **Fetch requested period** starts
a bounded historical retrieval for the selected creators and dates. Merely
changing the dates or asking an AI question does not trigger hidden X reads.
Show cached coverage and offer the explicit historical-fetch action when needed.

A refresh can cache newer posts outside the displayed date window. Keep those
date filters unchanged and offer a clear way to view the newly retrieved dates.
Existing research answers stay pinned to their evidence snapshot. The user can
start a new scope revision to analyze the refreshed material.

### Persistent archive and incremental catch-up

**Fetch once, keep the archive, and catch up on subsequent refreshes.** The
initial import may take substantially longer than later refreshes. Scope should
not redownload a creator's complete saved history just because the app was
closed for a few hours.

#### First fetch for a new creator

- The first manually started fetch builds an initial archive for a documented
  configurable history window, for example a last-30-days target. This target
  is separate from the feed's default last-seven-days display filter and is
  subject to validated provider access and per-attempt limits.
- Retrieve multiple pages rather than treating the first page as initialization.
  Show creator and post progress; save successful pages as they arrive so the
  user can browse available posts before the whole import finishes.
- Commit normalized post data, timeline memberships, search-index updates,
  retrieval progress and the page's next checkpoint together. A process exit
  between pages cannot lose committed work or mark an unsaved page completed.
- Persist separate initialization, refresh-head/catch-up, and older-history
  state. An interrupted initial import is labeled incomplete and offers manual
  Resume after reopening; it does not force a fresh complete import.
- A creator already archived elsewhere in the library reuses that archive
  when added to another list. Fetching any genuinely missing requested history
  is an explicit extension of coverage, not another duplicate creator import.

#### Subsequent refreshes

1. Load the creator's saved checkpoint and fetch from the current timeline head.
   X need not expose a perfect “only new posts” endpoint: a small overlapping
   re-read is expected to discover where the new timeline meets saved coverage.
2. Continue paging until the newly retrieved span reaches the previously
   established catch-up boundary under the validated provider ordering rules.
   An old pinned post, an already cached post imported individually, or a familiar
   repost must not cause an early stop that misses the intervening new posts.
3. Upsert canonical tweets by stable tweet id and retain creator/sharer
   memberships. Existing ids do not create duplicate posts. A newer full-text
   payload can improve an existing record; weaker or unavailable payloads do
   not erase its previously retrieved text.
4. Preserve all older cached posts. Routine refresh stops at the overlap instead
   of walking through the rest of the saved archive. Opening a list and analysis
   of stored posts use local data without another X fetch.
5. Advance the successfully caught-up boundary only after the intervening span
   has been retrieved according to the provider's validated behavior. Track
   newest-observed posts separately: fetching the newest page alone must not
   hide an unfilled gap between it and the previous successful refresh.

Persist checkpoint scope with stable creator identity and provider/filter
configuration, plus successful coverage boundary metadata, overlap anchors,
last fully successful refresh, and any pending catch-up interval/cursor. If a
cursor expires or a configuration changes, invalidate the affected cursor and
restart the relevant bounded traversal with deduplication; keep the archive and
its prior coverage evidence intact.

A few hours away normally means fetching a few new pages plus overlap, rather
than thousands of stored posts. A longer absence or a prolific creator can
require more pages to catch up. If a job reaches its page/time/provider budget
before connecting to prior coverage, persist the outstanding gap, show
**Partially caught up**, and offer manual Resume. Do not claim freshness merely
because the latest post was retrieved. All coverage statements remain qualified
by the provider's access and ordering behavior.

For a hypothetical creator with 2,000 archived posts and 15 new posts during
an absence, the desired result is 2,015 stored posts after catch-up. The refresh
retrieves the new span and a small overlap; it does not redownload all 2,000 old
posts. Page size, pinned/reordered entries and visibility changes can mean more
than exactly 15 posts are read from X, and that is acceptable.

#### Retention and reopening

- Persist archive rows, search indexes, list membership and retrieval checkpoints
  in the normal desktop database, not browser state, temporary AI job folders,
  or an in-memory cache. Existing `tweets` and `creator_tweets` tables are the
  base; extend their durable retrieval metadata where necessary.
- On reopening, show saved feeds immediately and wait for **Refresh feed**.
  Offline use and an expired X session do not prevent reading or analyzing
  previously stored eligible text with an available AI backend.
- Do not apply an automatic TTL or prune posts to the latest display window.
  Removing a creator from a list, refreshing, or an upstream post disappearing
  does not silently delete archived text. Any future archive-clearing control
  must be a deliberate user action with explicit scope.
- Separately track current availability and last observed/fetched time when
  verified. Archived evidence remains timestamped rather than being represented
  as a fresh confirmation that the original post is still available on X.

This architecture saves X retrieval work across sessions. AI work is separate:
a new research question can still require scanning the stored archive again,
while compatible completed analysis batches can be reused under the cache rules
specified below.

### Ask & compare

The research view has conversation space and an adjacent evidence panel.
The first question uses the selected creators and dates without forcing the
user to manually select every post. Suggested prompts can populate the input:

- Who discussed ETH during this period, and what did they say?
- Compare their ETH theses: reasoning, time horizon, conditions and disagreements.
- How did Alex's view change between these two periods?
- Find posts about ETH versus BTC, then compare the arguments.

Treat “XYZ” according to context. A named creator compares sources; a named
asset compares arguments in the selected corpus; a pasted thesis becomes
user-supplied comparison material, visibly distinguished from creator claims.
Ask a short clarification when materially ambiguous. Outside market facts
require a separately enabled source path; the X corpus cannot answer them alone.

Answer structure should adapt to the question, usually:

1. A direct answer to the question.
2. Per-creator findings with supporting post citations.
3. Shared points, disagreements and stated conditions, where evidenced.
4. Time horizon, changes over time, and what the posts leave unresolved.
5. A compact scope note: creators, dates, cached/searched/reviewed counts,
   exclusions and coverage limitations.

Use a comparison table when it clarifies the analysis: creator, claim,
rationale, horizon, condition or invalidation, and evidence. Leave unspecified
dimensions explicitly unspecified. Label inferred theses as interpretation.
Do not infer a changed view from differently worded posts without enough
comparable evidence, or interpret sarcasm, quotes or reposts as stated belief.

Clicking a citation opens the exact full post in the evidence panel and offers
the original X link. Quote/context material is labeled separately. Saving a
brief uses the existing reports system and preserves an answer-time source
snapshot, not a live list reference alone.

## Example end-to-end flow

1. Open X Research and create **Ethereum**.
2. Add handles or select existing X creators; review resolved identities.
3. Read the cached list feed and click **Refresh feed** to fetch the newest
   available posts. No automatic feed refresh runs.
4. Choose September 1–30. Scope shows which creators have retrieved material
   for that interval and whether older retrieval stopped early. Click
   **Fetch requested period** if additional historical retrieval is needed.
5. Search ETH aliases to obtain the matching post collection; optionally switch
   to related-topic matching and inspect its reasoning.
6. Open Ask & compare and ask, “What is their thesis, and where do they disagree?”
7. Read a cited comparison and inspect source posts without leaving the workspace.
8. Ask follow-ups against the same source snapshot. To compare another period
   or refresh with new material, create a clearly marked new scope revision.
9. Save the comparison as a research brief with evidence and scope metadata.

## Coverage is part of the product

“All tweets related to XYZ” has two independent uncertainties: availability of
posts and the judgment of relatedness. Never use an unqualified “all” for X
history. Prefer “All exact matches in the retrieved scope” for deterministic
matches and “Related posts found in the retrieved scope” for relevance search.

Store retrieval attempts and observed intervals per creator, provider/filter
configuration and date request. Keep refresh-head state separate from older
backfill state. Min/max timestamps are observations, not proof of gap-free
coverage. Pinned posts, reposts and non-monotonic pages make “oldest post seen”
an unsafe completeness test. A missing cursor means the provider returned no
more pages, not that X has supplied a complete account archive.

Suggested user-visible states: **Cached only**, **Fetching requested period**,
**Requested boundary reached; upstream completeness unverified**, **Partial**,
and **Failed**. Show actual cached date bounds, last successful refresh,
creator-specific failures and a reason when work stopped. A result with no
evidence says “No mentions found in the retrieved posts,” with coverage attached.

Use bounded, cancellable retrieval with deduplication, persisted checkpoints,
stall detection, rate-limit backoff, and an explicit resume action. Large
backfills show progress and resource limits. Continue analyzing available
cached data when useful, preserving the partial status in the answer.

## Existing foundations and required changes

Confirmed in the repository:

- `lib/x/model.ts` and `lib/x/providers/worker.ts` define the provider boundary.
  The shipping worker exposes identity, creator timeline and individual post
  reads; it does not currently expose keyword search or X List management.
- `lib/x/service.ts` serializes X network operations and coalesces creator work.
  Preserve those constraints and feed new jobs through the same boundary.
- `lib/x/repository.ts` stores canonical posts, creator timeline memberships,
  cursor state and additive updates. Reuse these instead of maintaining a
  parallel research cache.
- Existing categories and creator records already support reusable source
  organization, but do not yet represent research lists.
- `app/research/page.tsx` builds a cached mixed-source selection, while
  `lib/ai/materialize.ts`, `lib/ai/chat.ts`, and the citation UI already support
  tweet text, quote attribution, grounded answers and provider-backed AI runs.
- `lib/ai/scope-selection.ts` caps manual analyses at 25 sources. This is
  unsuitable for researching an entire active list and should not silently
  truncate the new research corpus. The chat and report API routes also enforce
  this limit; changing only the selection UI would still reject larger jobs.
- `lib/ai/materialize.ts` currently applies a default 4,000,000-byte total
  materialization budget. A large-corpus pipeline needs separate bounded batch
  materialization; lifting the source-count limit does not remove this ceiling
  or a model's context and output limits.
- The current background task store is client-memory state. It can display
  research progress, but durable jobs/checkpoints must be stored server-side
  so navigation, disconnection, or application exit do not lose completed work.
- `listFeedTweets()` globally assigns duplicate timeline posts to the oldest
  creator record. The X Research query must scope memberships first, then
  deduplicate by tweet id, retaining all relevant author/sharer provenance.
  Otherwise a selected list can lose a post credited to a creator outside it.

### Proposed data model

- `x_research_lists`: id, name, description, timestamps.
- `x_research_list_members`: list id, creator id, timestamps; unique membership.
- `x_retrieval_jobs` and creator attempt/checkpoint records: request range,
  identity, provider/filter key, state, cursor, progress, observed bounds,
  last successful page, initial-import completion, established catch-up boundary,
  newest-observed metadata, pending gaps, stop reason and failures. Keep head
  catch-up and older-history cursors distinct. Credentials never enter these.
- A local tweet-text search index linked to canonical tweet ids, updated
  transactionally when cached text changes. Keep quoted text independently
  attributable; an exact authored-text search must not count quoted-only text
  as the creator mentioning a topic.
- `x_research_scopes`: immutable revisions describing selected creator ids,
  timezone and range, post types, origin list, retrieval state, and resolved
  tweet ids/version metadata. Saved materialized text captures what the answer
  actually saw even if a later refresh changes cached text.
- Link scope revisions to the existing chat/report records rather than create
  another disconnected conversation or reporting system. Store per-turn
  searched/reviewed counts and evidence manifests when corpus queries vary.
- `x_analysis_jobs`: scope revision, question, analysis strategy, backend/model,
  prompt version, stage/status, aggregate progress, token usage when available,
  configured budgets, cancellation state, and timestamps.
- `x_analysis_batches`: job id, stable batch key, ordered source/version
  manifest, status, retry/checkpoint metadata, validated structured findings,
  and individual post dispositions. Enforce unique job/batch identity so retries
  replace a batch result instead of double-counting findings.
- A persisted result-to-post relation enumerates related posts independently
  of the final answer length and the number of citations shown in that answer.

SQLite FTS5 is a suitable candidate for local lexical indexing, subject to
checking the bundled SQLite build. It supplies full-text matching and ranking;
it does not establish semantic relevance. Citation:
https://www.sqlite.org/fts5.html

### Retrieval strategy

Use creator-timeline retrieval to build a reusable local archive, and existing
detail reads to hydrate truncated candidate posts when possible. Validate live
pagination, boundary behavior, full text, and reply visibility before promising
a supported backfill window. Accounts may be protected, unavailable or very active.

The pinned upstream twitter-cli documents keyword search with author and date
filters, plus list timelines. Scope's current broker/worker intentionally does
not expose those operations. A bounded read-only `search_posts` extension is a
candidate for finding older topic matches without crawling an entire timeline;
validate cursor/date/filter behavior against the actual pinned client before
including it. Results from remote search supplement the archive and carry
their retrieval provenance; they do not prove exhaustive historical coverage.
Do not add upstream write operations or browser-cookie extraction.
Source: https://github.com/public-clis/twitter-cli/tree/7c634e0d396b1e7af9f63315b414925fe4f29ae7

### AI strategy for a large corpus

**Large tweet collections are a first-release requirement, not a later
optimization.** The workspace must analyze thousands of tweets across many
creators without making the user select small groups manually. The complete
research scope is independent of how many posts fit on one feed page, in one
model call, or in one answer.

Separate search from answer generation. Resolve and validate the creator/date
scope server-side, search locally, retrieve context where available, then analyze
the relevant text and produce citations to canonical ids in that scope.

Exact-term searches enumerate matching local posts directly. AI research uses
Full scan by default: narrow questions classify topic relevance across the whole
eligible cached scope; broad questions such as “What are their theses?” extract
claims from that scope. Preserve per-post evidence and contradictory findings.
Retrieved context outside the date window must be labeled as context, not counted
as in-range evidence. Contextual relevance remains model judgment and upstream
coverage remains bounded even when every eligible cached post is processed.
Materialized byte limits, context limits and timeouts require batching or a
visible partial result; raising the 25-source constant alone is insufficient.
Display all resulting relevant post records separately from a concise answer.

### Concrete large-corpus execution plan

Use **Full scan** as the initial AI research strategy: every eligible complete
text post in the selected scope is submitted to a question-specific screening
or extraction batch. This meets the requirement to go through many tweets and
avoids losing indirect references before analysis begins. Exact-term search
can enumerate local matches without an AI call. An optional **Focused search**
strategy can come later for faster answers from retrieved candidates; if added,
it must be labeled clearly and never claim that the remaining corpus was reviewed.
Research coverage strategy is separate from existing Quick/Balanced/Deep
reasoning settings: choosing a faster model must not silently sample sources.

The execution stages are:

1. **Freeze the corpus.** Resolve list membership or selected creators, dates,
   timezone and post types on the server. Persist a scope revision containing
   deduplicated tweet identities and content versions. Separate complete eligible
   text, truncated/unavailable text and missing metadata; expose all exclusions.
   Copy the analyzed text into an immutable snapshot. Use a consistent SQLite
   read snapshot or pin immutable content-version records before paginating;
   querying mutable cached rows page by page would mix versions during a refresh.
   Finish snapshot creation before AI execution and hold no database transaction
   open while waiting for the model.
   Candidate hydration requires an explicitly authorized retrieval action and
   occurs before freezing the analysis corpus.
2. **Plan token-sized batches.** Group by creator and chronology where practical,
   preserving available thread context and quote attribution. Split by estimated
   model tokens, not a fixed tweet count. Start with a configurable target around
   8,000 input tokens per batch, constrained by the selected model's actual
   supported context and reserved instruction/output space. This is a tuning
   proposal, not a capacity guarantee. Size batches against expected structured
   output as well: many short posts can fit the input budget but exceed the output
   budget when every post requires a disposition. Use conservative estimation when exact
   tokenization is unavailable; shrink and retry a batch on a context-limit error.
   Split exceptionally long posts into labeled segments rather than cutting
   their text silently, and only mark the post processed when all segments finish.
3. **Screen/extract every batch.** Submit the user question with each batch to
   the existing AI backend adapter. Require structured output accounting for
   every source id: relevant, not relevant, or uncertain, with source-backed
   claims, supporting excerpts, attribution and dates for relevant findings.
   Broad questions extract claims rather than narrow topic matches. Preserve
   conditions, conflicting statements and unclear context rather than force
   a position. Validate schema and source membership; retry missing or malformed
   dispositions in smaller batches. A successful process exit alone is not proof
   that every supplied post was accounted for.
4. **Persist evidence before summarizing.** Store post-level dispositions and
   findings as each batch completes. Retain the immutable original text and
   stable post ids. Intermediate results can condense findings, but cannot replace
   original evidence with an uncited prose summary. Keep all relevant and uncertain
   records queryable, including those not mentioned in the final answer.
5. **Compare across creators and time.** Reduce findings into creator-level
   arguments, then synthesize the comparison. If the findings exceed a model's
   context, use additional bounded reduction passes that carry evidence ids,
   disagreements and conditions forward. Compare the same dimensions across
   creators; do not let high posting volume drown out a less active creator.
   Distinguish repeated posts from independent claims and distinct creators.
6. **Verify and present.** Reopen the original posts supporting proposed claims
   to check attribution and support, and validate citation ids mechanically.
   Return the readable answer plus the separately paginated related-post
   collection. Report corpus size, successfully accounted-for posts, exclusions,
   uncertain matches and unfinished batches. “Processed every post” describes
   pipeline coverage, not a guarantee of perfect semantic recall or correctness.

For example, a hypothetical 20-creator scope with 300 eligible cached tweets
per creator contains **6,000 tweets**. If the token planner averages 100 tweets
per batch, screening takes roughly 60 batches, followed by creator-level
reduction, synthesis and verification. Actual batch sizes and runtime depend
on text length, question, model, and provider limits. The answer can stay short
while the underlying research covers all 6,000 posts.

### Durable jobs, progress and limits

Run this pipeline as a server-owned background job rather than one long HTTP
chat request or one enormous model prompt. A browser request submits the job;
polling or streaming observes it. The activity UI shows, for example,
“Reviewed 3,200 of 6,000 tweets · 20 creators,” followed by “Comparing findings”
and “Checking sources.” Counts come from validated batch/post records, not model
prose. Show incomplete upstream retrieval separately from AI processing progress.

Persist `queued`, `running`, `waiting_for_provider`, `paused`, `partial`, `failed`,
`cancelled`, and `complete` states with stage and checkpoints. Navigation or a
closed browser view does not cancel work. Application exit ends local execution;
on restart reconstruct interrupted jobs and offer explicit Resume. Persisted
post results prevent restarting completed batches. Cancel stops active execution
and leaves completed checkpoints available for an explicit resume.

Start with one active AI batch at a time, independently from the serialized X
network queue. Add limited AI concurrency only after backend quota behavior and
desktop resource usage have been tested. Reuse identical completed batch results
only when content versions, question/strategy, backend/model, prompt version
and relevant settings match. A changed question may require a new full scan;
a prior summary or narrow ETH result is insufficient for a new BTC question.

The first implementation should be benchmarked against **10,000 eligible tweets
across 20 creators**, including scopes exceeding the legacy 4 MB materialization
budget. This is a proposed acceptance target, not an already measured capacity.
No 25-tweet or arbitrary per-creator selection cap applies to X Research.
Resource ceilings still exist, but they control work per batch and the amount
of work allowed in one execution attempt; they must not quietly remove sources
from the requested corpus.

Keep model context/output limits, per-call timeout, total token/call budget,
disk budget and bounded retries configurable. Provide estimated batch count
and token usage before a large run; show monetary estimates only when reliable
pricing applies to the selected backend. Larger full scans cost more time and
provider usage. When a budget or provider limit prevents completion, checkpoint
and offer Resume/Continue or an explicitly narrowed scope. An optional partial
answer must state the exact processed subset and gaps; it cannot claim the
whole corpus was reviewed. Never replace budget exhaustion with silent sampling.

Materialize each batch using the existing source format and grounded backend
runner where useful, but add a corpus snapshot/manifest layer instead of passing
the entire archive through the existing capped `materializeSources()` call.
Do not load every tweet into a client component or require a giant client-submitted
source-id array. Feed/result browsing remains server-paginated, independent of
analysis throughput.

### Proposed code and API changes

- Add a server-side X research scope resolver, corpus snapshot service, batch
  planner, structured-result validator and persistent job runner. Suggested
  modules belong under `lib/x/research/`, reusing `lib/x/service.ts` for X reads
  and `lib/ai/backend.ts` for model execution.
- Add a research-job submission API accepting creators/list, dates, post types,
  question and model/settings; return a job id. Add status/result, Cancel and
  Resume operations. Resolve the corpus server-side rather than trust client
  paths or client-supplied tweet text. The route names can follow repository
  conventions during implementation.
- Extend existing chat/report records with a corpus scope revision or research
  job reference. Follow-ups use that immutable archive and can submit new
  question-specific batches. A report generated from research uses the original
  scope and validated findings; its route must not reject it through the legacy
  25-source guard or silently rematerialize just a few cited posts.
- Keep the existing small manual mixed-source workflow intact. Add explicit
  corpus-aware validation/execution branches on both client and server; do not
  globally remove source limits from unrelated video or manual chat requests.
- Integrate persisted job state with the existing activity UI, evidence panel,
  source citation rendering and Reports destination. Avoid using the client
  task store as the durable scheduler.

### Evidence quality and future retrieval improvements

Embeddings can improve indirect-topic retrieval later, but should be added only
after evaluation shows a concrete recall benefit. Start with explicit aliases,
local text indexing, contextual verification and chunked analysis.

Reuse the existing AI backend/model picker, sandbox, activity system and
grounding instruction. Treat tweet instructions as untrusted source content.
Validate citation membership and existence mechanically; assess whether the
text supports the claim through analysis and a grounded-output evaluation.
These are different checks. Keep corpus summaries and answer caches keyed to
scope, content versions, question, model and prompt version so list edits or
fresh tweets cannot reuse stale results accidentally.

## Implementation sequence

Implement the same requirements defined above in the following six stages.
These stages organize the work; they do not reduce scope, change product
behavior, or replace the detailed requirements and acceptance checks in this
document. Complete and verify each stage before marking it complete.

### Stage 1 — Validate retrieval

**Status:** Complete on 2026-10-01 for the observed provider capabilities and
limitations. Live validation used the connected desktop account and
`@blknoiz06`; see [the validation record](../x-retrieval-validation.md) and
[sanitized live evidence](../evidence/x-retrieval-2026-10-01.json). Remote
search is deferred. This validates bounded retrieval, not exhaustive history
or complete reply coverage.

**Scope:** Verify live timeline pagination, date-boundary behavior, full-text
availability and reply visibility using a connected test account. Assess the
optional read-only search extension against the pinned client. Keep supported
coverage promises tied to observed provider behavior; remote search remains
optional and cannot establish exhaustive history.

**Completion checks:** Record the observed ordering, cursor and boundary
behavior, access limitations, and supported bounded retrieval window. Clearly
distinguish live integration evidence from deterministic fixtures. If live
validation is unavailable, record the blocker and leave this stage incomplete.

### Stage 2 — Lists and cached dashboard

**Status:** Complete on 2026-10-01. See the [completion record](#stage-2-completion--2026-10-01)
and [browser/automated evidence](../evidence/x-research-stage2/verification.md).

**Scope:** Add the database migration, persistent list CRUD, shared-library
creator picker and resolved creator-add flow, ad hoc creator selection, and
the `/x-research` destination. Implement the scoped, server-paginated cached
feed, date/timezone and post-type filters, source inspection, and cached
freshness/coverage display using the proposed layout and shared components.
Removing membership or deleting a list must preserve shared creators and
cached posts. Reading or switching lists must not trigger X retrieval.

**Completion checks:** Verify shared-cache reuse across lists, persistence
after reopening, membership/deletion behavior, scoped deduplication, date/type
filtering and pagination. Browser-test the affected list/feed flows, desktop
and narrow layouts, keyboard navigation, and empty/error states. Manual
retrieval controls are completed in Stage 3; the cached dashboard alone is not
the finished feature.

### Stage 3 — Durable retrieval

**Status:** Complete on 2026-10-02. See the [completion record](#stage-3-completion--2026-10-02)
and [browser/live verification](../evidence/x-research-stage3/verification.md).

**Scope:** Implement the manual **Refresh feed** button and refresh jobs,
persistent bounded initial imports, incremental catch-up checkpoints, and
the separate **Fetch requested period** action for resumable bounded historical
backfill. Include transactional page/checkpoint commits, shared-creator job
coalescing, progress, cancellation, bounded retries/backoff, explicit
Retry/Resume, creator-specific failures, partial-state UX, and visible
coverage. Preserve separate initialization, catch-up and older-history state.
Detail hydration requires an explicit retrieval action. No automatic refresh
or automatic retrieval resume is permitted.

**Completion checks:** Exercise the retrieval acceptance cases below, including
the 2,000 archived posts plus 15 new posts fixture, interrupted import/catch-up,
restart recovery, pinned/reordered posts, expired cursors, outstanding gaps,
rate limits and partial creator failures. Verify archive preservation,
unchanged display filters and evidence snapshots, and no hidden X reads.
Browser-test refresh, historical fetch, cancellation and recovery. Validate
live retrieval separately from mocked browser flows.

### Stage 4 — Search

**Status:** Complete on 2026-10-02. See the [completion record](#stage-4-completion--2026-10-02)
and [browser/automated verification](../evidence/x-research-stage4/verification.md).

**Scope:** Add the transactional local text index and scoped, paginated
exact-term/phrase, alias and exclusion results. Keep the index consistent with
the page merges implemented in Stage 3. Preserve the distinction between
**Exact terms** and **Related topic**, clear match explanations, and explicit
question-scope changes for asking about results or selected posts. Related-topic
classification is completed by the research engine in Stage 5 and exposed in
Stage 6. Add remote search only if validated in Stage 1; supplemental results
retain provenance and the same coverage limitations. An old requested period
must not silently become a recent-tweet selection.

**Completion checks:** Verify every exact match in the retrieved scope is
accessible through pagination, query parameterization/search-syntax escaping,
aliases and exclusions, index consistency after retrieval/resume, and qualified
empty/partial results. Browser-test search controls, filters and pagination.

### Stage 5 — Research engine

**Status:** Complete on 2026-10-02. See the [completion record](#stage-5-completion--2026-10-02)
and [engine, benchmark, live-provider and browser evidence](../evidence/x-research-stage5/verification.md).

**Scope:** Implement server-resolved immutable corpus scope revisions and text
snapshots, token-sized batch planning, question-specific Full scan screening
or extraction, structured-result validation, and persistent batch jobs.
Persist post-level dispositions and evidence before creator/time reductions,
grounded comparison, synthesis and source verification. Include the separately
paginated relevant/uncertain post collection, full-scan coverage accounting,
progress/status/result APIs, Cancel/Resume, configurable resource limits and
compatible-result reuse. Reuse the existing backend boundary without routing
the entire corpus through the legacy capped materialization path or removing
limits from the existing small mixed-source workflow.

**Completion checks:** Benchmark the deterministic 10,000-tweet, 20-creator
corpus exceeding 4 MB before claiming support. Every eligible post must have a
validated disposition or an explicit unfinished status; no silent sampling.
Exercise malformed/missing output, overlong posts, context/output limits,
contradictions, budget exhaustion, cancellation and restart/resume. Validate
citation membership, evidence support, immutable snapshots and cache
compatibility. Related-topic evaluation must include indirect and ambiguous
references, sarcasm and attribution cases described below.

### Stage 6 — Research experience

**Status:** Complete on 2026-10-02. See the [completion record](#stage-6-completion--2026-10-02)
and [browser/automated verification](../evidence/x-research-stage6/verification.md).

**Scope:** Connect **Ask & compare** and related-topic browsing to the research
engine. Integrate the existing model/settings picker and activity UI, progress,
coverage/exclusion notes, grounded comparisons, citations, evidence panel and
related-post collection. Implement explicit scope revisions, coherent
question-specific follow-ups against the saved corpus, and saving to Reports
with answer-time evidence snapshots. Add corpus-aware chat/report validation
and execution so large-corpus follow-ups and reports do not hit the legacy
25-source guard or shrink the corpus to the answer's final citations.

**Completion checks:** Browser-test the complete example flow, including
research, progress, cancel/resume, related results, citation inspection,
follow-ups, scope changes and report saving. Verify that refresh/list edits
cannot change evidence beneath an existing answer and that saved reports
retain their original scope and source text. Check desktop/narrow layouts,
keyboard navigation, empty/error/partial states and page errors; fix and retest
any failures. Complete all applicable acceptance checks below before declaring
the feature finished.

Stages 2–6 together constitute the useful first release requested here; a
list/feed-only stage is a milestone, not the finished research feature.

### Required agent updates

Any agent implementing this proposal must maintain this Markdown file as the
implementation record. Before starting work, read the detailed requirements,
the stage definitions and the current progress below.

- When starting a stage, change its status to **In progress** in the table.
- Every time a stage is completed, update this file **in the same change as
  the implementation, before handing off or starting the next stage**. Mark
  it **Complete**, enter the completion date, and append a completion record.
- Each completion record must identify the implemented scope and relevant
  files, the verification commands/results and browser or live integration
  evidence where applicable, and any remaining limitations or follow-up work.
  Link the record from the stage's progress row.
- Mark a stage complete only after its scope and applicable acceptance checks
  pass. Missing required functionality or validation keeps the stage
  **In progress** or **Blocked**; record the exact remaining work or blocker.
  Passing fixtures does not replace required live retrieval validation or
  browser testing.
- Update progress and remaining work when handing off an incomplete stage.
  Preserve the requirements and prior completion records so the next agent
  can continue from the actual implementation state.
- After Stage 6 passes the complete acceptance checks, update the proposal's
  status at the top to reflect the completed implementation. Until then, keep
  the distinction between this concept and implemented behavior explicit.

### Implementation progress

This tracker records implemented stages and links their verification evidence.
The six stages are implemented. Verification records distinguish deterministic
capacity/browser fixtures from the observed live X and AI provider checks.

| Stage                          | Status   | Completed on | Completion record / remaining work                   |
| ------------------------------ | -------- | ------------ | ---------------------------------------------------- |
| 1 — Validate retrieval         | Complete | 2026-10-01   | [Validation record](../x-retrieval-validation.md)    |
| 2 — Lists and cached dashboard | Complete | 2026-10-01   | [Completion record](#stage-2-completion--2026-10-01) |
| 3 — Durable retrieval          | Complete | 2026-10-02   | [Completion record](#stage-3-completion--2026-10-02) |
| 4 — Search                     | Complete | 2026-10-02   | [Completion record](#stage-4-completion--2026-10-02) |
| 5 — Research engine            | Complete | 2026-10-02   | [Completion record](#stage-5-completion--2026-10-02) |
| 6 — Research experience        | Complete | 2026-10-02   | [Completion record](#stage-6-completion--2026-10-02) |

### Stage completion records

#### Stage 1 completion — 2026-10-01

- Implemented and verified before Stage 2: bounded live retrieval validation.
  See the existing [Stage 1 record](../x-retrieval-validation.md) and
  [sanitized live evidence](../evidence/x-retrieval-2026-10-01.json).
- Limitations: remote search deferred; observed bounded retrieval does not
  prove exhaustive historical or reply coverage.

#### Stage 2 completion — 2026-10-01

- Implemented: migration `015` in `lib/db/migrations.ts`; persistent local
  list CRUD and transactional membership updates in
  `lib/x/research/repository.ts`; list/feed routes in `app/api/x-research/`;
  `/x-research` page and responsive list rail, shared-library creator picker,
  category snapshots, ad hoc selection, inclusive calendar/timezone and
  post-type controls, local freshness/coverage disclosure, source inspection
  and server pagination in `app/x-research/`.
- Shared integration: added the sidebar/mobile destination; reused the
  creator resolve/preview/save dialog with automatic fetching disabled;
  preserved full quote text in cached details; added affected research-list
  names to library deletion confirmation and research-page revalidation to
  creator save/delete actions. Missing repost event dates now stay unknown in
  `lib/x/mapper.ts`; the canonical publication date is never substituted.
- Verification: `npm run typecheck` and targeted ESLint passed; 88 tests passed
  across research, migrations, X service/mapper/validation and creator/category
  repositories; `SCOPE_NEXT_DIST_DIR=.next-stage2-build npm run build -- --webpack`
  passed. Default Turbopack build was limited by the test environment's font
  fetch/port-binding restrictions, with no build-script changes made.
- Browser evidence: agent-browser drove list creation/edit/deletion, shared
  membership/cache reuse, category snapshot creation, creator lookup/preview/save,
  duplicate creator reuse, ad hoc browsing, 30/30/7 pagination, dates/timezones,
  all post types, full text/quote/reply inspection, coverage, error/retry,
  keyboard dismissal/focus restoration and desktop/narrow layouts. Lists,
  membership and cached text survived a server restart. No renderer errors
  or horizontal overflow were found. See the
  [verification record and screenshots](../evidence/x-research-stage2/verification.md)
  and [sanitized cached-read trace](../evidence/x-research-stage2/cached-read-requests.json).
- Limitations and follow-ups: this stage reads the existing shared archive.
  Legacy refresh timestamps and observed cached date bounds do not prove
  complete coverage; missing dates are excluded and disclosed. Parent-context
  availability is shown without claiming a complete conversation. Stage 3
  must add explicit refresh/historical retrieval, durable jobs/checkpoints,
  retries/cancellation and per-creator coverage. Search and corpus research
  remain Stages 4–6. No new live retrieval claim is made by Stage 2.

#### Stage 3 completion — 2026-10-02

- Implemented: migrations `016`–`017` in `lib/db/migrations.ts`; durable
  snapshot jobs, shared creator tasks, independent head/history checkpoints,
  page/checkpoint transactions, bounded initial imports, validated overlap
  catch-up, historical traversal, retries/backoff, cancellation and manual
  recovery in `lib/x/research/retrieval.ts` and `retrieval-model.ts`. The
  process-wide X mutex now spans Next route/action bundles in `lib/x/service.ts`.
  Existing shared archive writes remain additive; text retrieval provenance
  and availability observations are separate in `lib/x/repository.ts` and
  `lib/x/view-model.ts`.
- API/UI: guarded start/control/progress and explicit detail-hydration routes
  under `app/api/x-research/`; manual Refresh feed and Fetch requested period,
  resource controls, creator failures, partial/interrupted coverage,
  Cancel/Retry/Resume, saved-scope dates and access to other/deleted-list jobs
  in `app/x-research/retrieval-controls.tsx`. The cached feed stays mounted
  during progress; display filters and open source snapshots stay fixed.
  No opening, selection, date change, timer or application restart starts or
  resumes X retrieval. Progress polling reads SQLite only.
- Verification: TypeScript, targeted ESLint and the isolated Webpack production
  build passed. 109 tests across nine suites passed, including the exact
  2,000-plus-15 archive fixture, restart/resume, rollback, pins/reordering,
  cursor expiry/stalls, outstanding gaps, budgets, rate limits and partial
  creator failures. Browser testing passed on desktop/narrow layouts,
  explicit full-text retrieval, scope labeling, filters, keyboard focus,
  cancellation, recovery and cached-card continuity. Real Electron/X reads
  verified a 60-post initial archive, two-page incremental overlap, historical
  interruption at six committed pages/119 posts, exact persistence after
  restart and manual continuation to 16 pages/312 posts. See the
  [verification and sanitized evidence](../evidence/x-research-stage3/verification.md).
- Limitations and follow-ups: all coverage is bounded by provider access and
  observed ordering. The default 30-day target is configurable, not a universal
  historical-access guarantee. Historical live validation deliberately ended
  partial at its attempt budget. Provider failure cases were exercised in
  deterministic fixtures rather than newly observed live. Legacy archived
  text/availability timestamps remain unknown until observed again; no
  provenance is invented. Local search/indexing and corpus research remain
  Stages 4–6. No remote search or automatic retrieval was introduced.

#### Stage 4 completion — 2026-10-02

- Implemented: transactional FTS5 index/backfill and archive insert/update/delete
  triggers in migration `018` (`lib/db/migrations.ts`); bounded, literal-safe
  exact terms/phrases, explicit aliases and exclusions in `lib/x/research/search.ts`.
  Scoped, chronological 30-post pagination, per-post match explanations,
  independently attributable quoted text, incomplete-text counts, recovery when
  updated text removes a later result page, and consistent read snapshots extend `lib/x/research/repository.ts` and the cached feed API.
  Requested date/type/creator bounds are preserved, including old periods and
  repost event dates. No remote search or implicit X reads were introduced.
- UI: exact-search controls and qualified results in `app/x-research/`;
  cross-page tweet selection and deliberate question-scope drafts for all list
  posts, all exact results, or selected tweets. Browsing topics do not silently
  constrain list or selected-post questions. Related-topic browsing and answer
  generation remain visibly unavailable until Stages 5–6.
- Verification: 1,043 tests passed (7 skipped), including eleven new search tests
  and FTS integrity checks after the durable 2,000-plus-15 catch-up and interrupted
  import/reopen/resume fixtures. TypeScript, targeted ESLint, clean-database
  migration gate and isolated Webpack production build passed. Agent-browser
  passed desktop/narrow search controls, all three result pages, creator/type/
  date filtering, the March 29 DST historical window, explicit scope switching,
  keyboard submission, empty/error recovery and zero hidden retrieval jobs.
  See the [verification and screenshots](../evidence/x-research-stage4/verification.md).
- Limitations and follow-ups: lexical search measures available cached text, not
  exhaustive historical or contextual relevance. `$` tickers are distinct tokens
  unless included in an explicit alias group; other punctuation separates words.
  Question drafts are visit-local preparation with explicit scope descriptors;
  immutable corpus/evidence snapshots, execution and saved conversations remain
  Stages 5–6. Remote search remains deferred as established in Stage 1.

#### Stage 5 completion — 2026-10-02

- Implemented: migrations `019`–`020` in `lib/db/migrations.ts`; immutable
  server-resolved corpus/source/coverage snapshots and normalized author/sharer
  memberships in `lib/x/research/corpus.ts`; token/output-aware planning,
  Unicode-safe long-post segmentation and grounded structured prompts in
  `analysis-planner.ts`/`analysis-prompts.ts`; schema, source/excerpt/attribution,
  reduction-manifest and semantic-verdict validation in `analysis-validation.ts`.
  Shared membership/date/type SQL remains the feed and corpus scope boundary.
- Durable execution: `analysis.ts`/`analysis-store.ts` persist jobs, batch and
  segment checkpoints, every eligible post's disposition and original evidence;
  bounded creator/time reductions, cross-creator synthesis and original-source
  verification; compatible-result reuse; call/token/time/payload budgets,
  reported usage, cancellation/late-result rejection, bounded splitting/retries,
  manual Resume and startup recovery to paused. Related/uncertain and unfinished
  sources are separately paginated rather than reduced to final citations.
- API/integration: guarded submit/estimate, status/result/source and Cancel/Resume
  routes under `app/api/x-research/analysis/`; startup recovery in instrumentation;
  scope/job links on existing chat/report records. Saved-scope jobs support
  question-specific engine follow-ups without re-reading mutable cache. Next
  module-graph validation errors use a shared brand so 400/404 responses survive
  route/instrumentation/HMR boundaries. No X retrieval or legacy cap removal.
- Verification: final full suite **1,063 passed, 8 skipped**; TypeScript,
  warning-free targeted ESLint, clean-database migration gate and isolated
  Webpack production build passed. The deterministic 10,000-post/20-creator
  benchmark processed **7,505,550 bytes** of original text with **zero unfinished
  posts**, 334 related-result pages, early/late contradictory arguments and quiet
  creator evidence retained. It used 1,128 bounded calls including reductions and
  verification; this is pipeline capacity evidence with an injected adapter.
  A separate real Codex/gpt-5.6-luna run completed the full engine on 13 fictional
  relevance/attribution/contradiction/sarcasm fixtures with measured fixture
  precision/recall/accuracy **1.0** and verified in-scope citations.
- Browser evidence: agent-browser verified real API estimates, explicit
  exclusions, result/unfinished pagination, Cancel/Resume, zero-call budget pause,
  source membership rejection, typed error recovery, restart persistence and
  source immutability after cache edits. Existing exact search, pagination,
  filtering, keyboard controls, source inspection and desktop/narrow layouts
  passed after fixes. See the [verification record and artifacts](../evidence/x-research-stage5/verification.md)
  and [Stage 6 API integration contract](../evidence/x-research-stage5/api.md).
- Limitations and follow-ups: coverage describes eligible cached text, not
  exhaustive X history or guaranteed semantic recall. Context/output capabilities
  are not supplied by the catalog; conservative estimates and configurable
  budgets can leave large runs visibly partial and manually continuable.
  Uncondensable findings or unsupported synthesis remain partial with evidence
  intact. The large benchmark does not measure real provider speed or cost; the
  small live fixture is not a broad relevance guarantee. Other backends reuse
  the existing adapter boundary but were not newly live-evaluated. Stage 6 still
  connects Ask & compare, related browsing, activity progress, evidence/citations,
  saved conversations and corpus-aware chat/report validation/execution; existing
  dashboard question controls retain their Stage 4 availability.

#### Stage 6 completion — 2026-10-02

- Implemented: Ask & compare and Related topic Full scan entry points; existing
  model picker and reasoning settings; estimates, configurable limits, durable
  progress/activity, Cancel/Resume, exclusions/coverage, grounded comparison
  tables, original citations, frozen evidence inspection and paginated
  relevant/uncertain/unfinished/all-source collections in `app/x-research/`.
- Conversations: migration `021`, `lib/x/research/experience.ts`, per-turn links
  to existing chat records, transactional assistant persistence, prior-turn
  reference context, question/context-sensitive cache identity, one executing
  turn per conversation and explicit new scope revisions. Saved questions and
  answers reopen from AI Chat; list/cache changes do not mutate their scope.
  Prior conversational context is explicitly marked if abridged; follow-ups
  still scan the entire frozen corpus, including uncited source records.
- Reports: corpus-aware branches in the existing chat/report APIs; saving a
  verified brief uses the original answer and scope without another inference.
  HTML answer and immutable corpus references persist in SQLite, including a
  full-source appendix, quote/context attribution and scope/coverage notes.
  Existing Reports lists/file actions work; report execution bypasses legacy
  materialization without removing small manual mixed-source limits.
- Verification: final full suite **1,068 passed, 8 skipped**; TypeScript,
  warning-free targeted ESLint, clean-database migration and isolated Webpack
  production build passed. New regressions cover >25-source follow-ups despite
  one final citation, >4 MB scan/export, immutable reports after cache and
  library/thread deletion, source escaping, validation, idempotence and
  conversation serialization. Stage 5's 10,000-post benchmark remains passing.
- Browser evidence: agent-browser exercised model/keyboard question controls,
  estimates, shared activity, cancellation/manual recovery, all three related
  result pages, citation inspection, follow-ups, related/exact/selected scopes,
  list edits, report saving/reopening, desktop/narrow layouts and qualified empty
  periods. Restart at 13/78 reviewed reopened paused without new calls; manual
  Resume completed 78/78. Cache/list edits left original text, two creators and
  all 81 report source snapshots intact. Renderer errors were absent and narrow
  layout had no document overflow. See the [verification and artifacts](../evidence/x-research-stage6/verification.md)
  and [integration API contract](../evidence/x-research-stage6/api.md).
- Boundaries: browser AI execution used fictional fixtures through a deterministic
  CLI, not a new live relevance evaluation. Existing live retrieval/provider
  evidence remains in prior stages. Full scan covers eligible cached text, not
  exhaustive X history or perfect semantic recall; bounded partial runs remain
  explicit. Media/linked pages remain unprocessed. Saved briefs preserve verified
  findings rather than initiating an additional model run. No remaining Stage 6
  work; deferred product features below remain outside this release.

Append future stage records using this format:

```markdown
#### Stage N completion — YYYY-MM-DD

- Implemented: delivered requirements and relevant file paths.
- Verification: commands/checks, outcomes, and browser/live integration evidence.
- Limitations and follow-ups: specific remaining limitations or “None”.
```

### Deferred work

Defer scheduled monitoring, alerts, suggested creators, global trend detection,
sentiment dashboards, native X List sync, multimodal chart analysis and
automatic trading recommendations. Later priorities should come from observed
research friction. No live price feed is required to compare creator arguments.

## Acceptance and verification

- One creator belongs to multiple lists with one cache; list deletion and
  membership changes preserve shared creator data.
- Opening the app, selecting a list, focusing the window, changing dates and
  waiting do not refresh X timelines. **Refresh feed** fetches the newest
  available posts for the labeled creator scope only after a click. Historical
  retrieval likewise requires an explicit action.
- Refresh coalesces duplicate clicks/shared creator jobs, keeps older-history
  cursors intact, reports partial creator failures and preserves the user's
  selected date range and existing research evidence snapshots.
- Import a creator's history, close Scope, reopen the same desktop profile and
  verify the exact archived text, list membership and checkpoints survive.
  Opening the saved feed must make no X timeline request.
- In deterministic pagination fixtures, append 15 new posts to a 2,000-post
  archive and refresh after restart. Verify the merged archive has 2,015 unique
  posts, all original text remains, and request logs show only the catch-up span
  plus overlap rather than traversal through the full saved history.
- Interrupt an initial import and a multi-page catch-up; resume from durable
  checkpoints without lost or duplicate posts. A partial latest-page fetch
  cannot advance the established catch-up boundary past an outstanding gap.
- Exercise pinned old posts, individually imported overlap posts, long absences,
  invalid/expired cursors and changed provider filters. Preserve the archive
  while resuming/restarting only the necessary traversal and exposing uncertainty.
- Switching the feed to seven days or removing list membership does not prune
  older posts. Adding an archived creator to a second list reuses saved history
  instead of triggering another full import.
- Scoped deduplication retains a post that appears in a selected timeline even
  if an unselected creator also has it. Original author and sharers stay distinct.
- Calendar dates are inclusive in the shown timezone, including DST boundaries;
  queries use half-open UTC bounds internally. Replies, quotes, reposts,
  missing timestamps and unavailable/truncated text are handled explicitly.
- Multi-page sync can pause and resume without duplicate text or false complete
  status. Handle pinned/non-monotonic pages, cursor stalls, rate limits,
  cancellation, expired sessions, protected users and a failed creator among
  successful creators. Failures never erase previously cached content.
- Exact results enumerate all local matches in scope with pagination. Related
  results label their strategy and cannot imply exhaustive X history.
- An answer cites actual in-scope sources and differentiates explicit claims
  from interpretation, quoted speakers and reposts. Empty/partial evidence
  produces qualified findings, not confident absence claims.
- More than 25 tweets and a corpus exceeding materialization/context budgets
  are processed in bounded batches or reported partial, never silently sampled.
- Benchmark a deterministic 10,000-tweet, 20-creator corpus with enough text to
  exceed the existing 4 MB limit. Every eligible post has a validated disposition
  in Full scan; sources distributed across early/late batches and quiet/busy
  creators survive into the findings. All relevant matches remain paginated
  in the result collection even when the final answer cites only a subset.
- Exercise malformed AI output, missing post dispositions, overlong posts,
  context-limit errors, exhausted output budgets and contradictory findings.
  Failed batches cannot inflate reviewed counts or mark a run complete.
- Cancel and resume an interrupted large job, including after app restart.
  Completed batches are reused without duplicate findings. Reaching a run budget
  yields checkpointed partial/paused status and visible gaps, never a fabricated
  all-source result. A changed question cannot reuse incompatible classifications.
- Large-corpus follow-ups and report generation use the saved corpus scope
  instead of failing the existing 25-source guard or reducing to final citations.
- Editing the scope creates an explicit new revision; a running manual refresh and
  list edits cannot alter evidence beneath an existing answer.
- Evaluate ETH/$ETH/Ethereum, indirect references, ambiguous ticker uses,
  sarcasm, conflicting claims, changed views and out-of-scope comparison requests
  with source-grounded fixtures. Compare relevance precision/recall before
  introducing embeddings or claiming better coverage.
- Start the development server and use agent-browser to test list creation,
  membership editing, creator addition, dates, types, search pagination,
  backfill recovery, research, citations, follow-ups and saving. Check desktop
  and narrow layouts, keyboard navigation, empty/error states, page errors,
  and retest all affected flows after fixes. Live X retrieval remains a separate
  integration check; mock browser testing cannot establish its reliability.

## Concept preview scope

The accompanying interface concept uses visibly fictional creators and posts.
It demonstrates list creation, creator selection, dates, post-type controls,
topic matching, the research view and source inspection. The ETH example is
prewritten, not an AI or live X result. It changes no application runtime behavior.
Real refresh, comprehensive relevance analysis, persistent lists, AI follow-ups,
X links and report saving remain implementation work described above.
