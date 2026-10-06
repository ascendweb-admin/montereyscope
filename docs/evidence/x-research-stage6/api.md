# Research experience integration

`POST /api/x-research/conversation` accepts the same creator/date/type/selection,
question, model and budget fields as the analysis API. `execute:false` prepares
an estimate and saves the question to an existing `ai_threads` conversation.
Explicit Resume starts the durable job. The saved scope is authoritative;
`selected_sources` does not become an array of final citations.

A follow-up sends `threadId`, `question`, settings and `execute:false`. Optional
`parentJobId` must belong to that conversation. It scans the same immutable
corpus, resolving conversational references from that prior turn. Prior context
has a conservative token bound and an explicit `abridged` flag; full prior
answers and the full original source scope remain saved. Question/context/model
settings participate in analysis cache identity. Mutable scope fields cannot be
combined with a saved conversation/scope; changing them creates a new revision.
Only one turn in a conversation can execute at once, including manual Resume.

`GET /api/x-research/conversation?jobId=...` returns the immutable scope and
conversation turn navigation metadata. Existing analysis status/source/result
and Cancel/Resume routes remain the progress and paginated evidence endpoints.
The status route also resolves citation-author labels from frozen sources.
Completed verified answers append one assistant message transactionally;
resuming/observing a completed job cannot append duplicate answers.

`POST /api/ai/chat` with `scopeId`, or with a research `threadId`, returns HTTP
202 `{job,threadId}` for durable corpus execution. Legacy manual mixed-source
requests keep their SSE protocol and existing source/materialization limits.
The AI Chat history links research conversations to the X Research experience.

`POST /api/ai/reports` with `researchJobId` (or a research `threadId`) saves the
completed, verified turn as a brief. An unfinished/unverified turn returns 409;
mixed scope requests return 400. Saving does not initiate inference or X reads.
Repeated saves of the same job reuse its report. Reports carry both the job and
scope references. The brief's HTML answer is persisted in SQLite; its source
appendix reads only the linked immutable corpus, including uncited and excluded
posts, with separately labeled quoted/context text. No legacy 25-source/4 MB
materialization path applies. The public list returns the full frozen source
count without loading every post into a client component. The existing report
file route serves the HTML with its script/network-restricting CSP. Library,
list, conversation and mutable-cache changes do not rewrite saved evidence.
