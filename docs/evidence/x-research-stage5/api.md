# Stage 5 research engine API

These Node routes use the existing loopback/same-origin JSON mutation guard.
They read the shared archive locally; none retrieves from X. Stage 6 connects
these APIs to Ask & compare, related-topic browsing, chat and Reports.

## Prepare or submit a Full scan

`POST /api/x-research/analysis` accepts:

```json
{
  "listId": 1,
  "creatorIds": [1, 2],
  "start": "2026-09-01",
  "end": "2026-09-30",
  "timezone": "Europe/Amsterdam",
  "types": ["original", "quote", "reply"],
  "question": "Compare their Ethereum theses and conditions.",
  "strategy": "full_scan",
  "mode": "quick",
  "execute": false,
  "selection": { "kind": "all" },
  "limits": { "maxCalls": 200, "maxTokens": 2000000 }
}
```

Dates are inclusive local calendar dates. `period: "24h"` instead resolves the
requested rolling window. Omit creatorIds to use the list's current membership;
omit listId for ad hoc creators. A supplied subset must belong to the list.
Post types default to originals, quotes and replies. Reposts use sharing-event
dates. Unknown dates remain explicit exclusions.

Selection alternatives:

- `{"kind":"exact","search":{"terms":"lower fees","aliases":"ETH\nEthereum\n$ETH","exclusions":"speculation"}}`
  freezes all matching cached authored-text results, independent of pagination.
- `{"kind":"selected","tweetIds":["123","456"]}` validates every selected
  ID against the same creator/date/type scope. The bounded request body and
  selected-ID limit apply to this manual selection, never to a Full scan.

The server resolves and snapshots canonical text, quote/sharer attribution,
publication/event dates, available parent context, versions, creators and
retrieval/coverage metadata in one transaction. It freezes before inference;
there is no client-supplied source text or filesystem path. Every eligible post
is planned, including segmented overlong text. Incomplete, missing and
unknown-dated text is counted separately. Media and linked pages are not analyzed.

The response is HTTP 202, `{job}`. With `execute:false`, it is paused and exposes
`estimatedBatches` and `estimatedTokens` for screening, with zero calls. Reduction,
synthesis and verification require additional calls. The default executes
immediately. The normal backend/mode settings apply; optional backend, model
and reasoningEffort are validated against the local provider catalog. Resolution
is frozen for the job. Coverage remains Full scan in every reasoning mode.

A follow-up can create a new question-specific job using
`{"scopeId":"saved-revision-id","question":"How do their conditions differ?","execute":false}`.
It uses that exact saved archive. To change creators/dates/types/search or use
refreshed text, submit a new scope revision instead. Chat/report UI and execution
routing remain Stage 6; schema links are available on ai_threads and ai_reports.

## Observe and inspect

- `GET /api/x-research/analysis`: recent jobs and persisted progress.
- `GET /api/x-research/analysis/{id}`: `{job,results}`. Results default to all
  relevant and uncertain **posts**, independent of the concise answer's citations.
- `?page=2`: 30 posts per page, chronological, clamped to the last available page.
- `?collection=all`: every frozen post, including exclusions and unreviewed posts.
- `?collection=unfinished`: eligible posts still lacking a validated disposition.
- `?tweetId=123`: includes the exact original frozen source; out-of-scope IDs
  return 404. It never hydrates or rematerializes from the current archive.

Job progress counts validated post records, not model prose. Segmented posts
count only after all their leaf segments have completed. A failed response,
missing disposition or process exit cannot increase reviewed counts. Per-creator
counts include every selected author/sharer membership and may overlap; the
corpus and reviewed totals deduplicate posts.

The complete result contains rendered, verified evidence-bearing claims plus
citations `[tweet:123]`, conditions, horizons, interpretation flags and a scope
note. Free-form model prose cannot add uncited claims outside the validated
schema. Every cited excerpt is mechanically checked against the immutable
source and its authored/quoted role. Separate model verification reviews original
source text (all segments for long originals) for meaning and attribution.
Unsupported synthesis is withheld and remains partial; Resume regenerates it.
No partial answer is fabricated when a batch or reduction fails. Validated
post-level findings remain inspectable while the job is partial.

## Cancel, resume and limits

`POST /api/x-research/analysis/{id}`:

```json
{ "action": "cancel" }
```

```json
{ "action": "resume", "limits": { "maxCalls": 1000, "maxTokens": 20000000 } }
```

Cancel aborts the active provider call, rejects late output and retains completed
checkpoints. Resume is manual, starts a new bounded execution attempt and keeps
all validated work. While a cancelled provider call is still stopping, Resume
returns 409; it cannot start a concurrent replacement. No application startup,
GET/poll, list change or refresh automatically resumes inference.

Configurable limits: contextTokens, inputTokens, outputTokens, maxCalls, maxTokens,
timeoutMs, maxRunMs, maxSnapshotBytes and retries. Defaults are defined in
`lib/x/research/analysis-model.ts`; all request values are bounded and validated.
Call/token/time ceilings apply per execution attempt. Job token/call counters
remain cumulative; reported provider usage is separate from conservative charged
estimates. Unknown usage remains an estimate. No monetary estimate is invented.
The disk ceiling covers logical snapshot and analysis payloads, not a promise
about the SQLite file's filesystem allocation or the existing archive size.

The current catalog does not advertise model context/output capacities. Defaults
are conservative execution ceilings, not provider-capacity claims. Input uses a
conservative UTF-8 estimate; planning reserves instructions, structured per-post
output and context headroom. Context/output failures split and retry bounded
batches. A malformed singleton receives bounded retries and remains unfinished
on failure. Provider quota/auth/transport failures require manual Resume. A
reduction that cannot fit or safely condense remains visibly partial rather than
sampling. No 25-source, 4 MB or per-creator cap applies to this corpus path.

Input/context/output limits are fixed for a job's manifests. Changing these or
the model/question/prompt requires a new job against the saved scope. Work limits
can increase on Resume. Reuse requires identical content/version manifests,
question, strategy, backend/model, reasoning mode/effort, prompt version and
context/output settings. Synthesis/verification cache entries are reusable only
from a completed, verified job; failed candidate answers cannot poison that cache.

Only one analysis call runs at a time in the desktop server process, independent
of X's serialized retrieval queue. Queued/running/waiting jobs are recovered as
paused after restart, and running batches return to pending. Snapshots, segments,
batch results and post dispositions persist in SQLite. Empty read-only temporary
provider directories are removed after each call; credentials are never persisted
in research rows or returned through these APIs.
