# X Research Stage 1: retrieval validation

Stage 1 completed on 2026-10-01 using a real, restored X login in the Scope
development desktop and the requested public creator `@blknoiz06` (stable id
`973261472`). The workspace itself remains unimplemented. This record defines
the measured retrieval behavior that later stages must respect.

## Live evidence

The [sanitized report](evidence/x-retrieval-2026-10-01.json) records every
returned entry's id, publication/event timestamps, type, content status,
text length and SHA-256. It contains no credentials, broker tokens, raw cursors
or post text. All four automated live checks passed through the real desktop
broker and bundled worker. No fake provider or mocked network was used.

| Observation             | Result                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Run                     | 2026-10-01; 10 timeline reads plus 2 individual post reads                                                             |
| Requested range         | `[2026-09-24T00:00:00Z, 2026-10-01T19:23:26.111Z)`                                                                     |
| Budget                  | 10 pages, 100 requested entries per page, 180-second deadline                                                          |
| Returned                | 206 entries; 197 unique post ids                                                                                       |
| Page sizes              | 21, 21, 20, 21, 20, 21, 20, 21, 21, 20                                                                                 |
| Unpinned observed dates | 2026-09-20T23:16:32Z through 2026-10-01T19:14:58Z                                                                      |
| Pinned post             | `2077815810458870267`, published 2026-07-16T18:01:07Z; returned on every page                                          |
| Cursor behavior         | All ten pages supplied advancing continuation cursors; later pages added new ids                                       |
| Stop                    | Page budget; a continuation was still available, with no provider error                                                |
| Reply sample            | `2105721660737310727`; returned in the timeline and individual read with a parent id                                   |
| Full-text samples       | Reply: 3,441 UTF-16 code units; parent `2105721654546424087`: 3,948; both complete with identical timeline/detail text |

An initial five-page run exposed an unsafe validation condition: counting the
old pinned post as evidence that the requested lower date boundary was reached.
The probe now excludes the resolved pinned id from boundary validation and
records both overall and unpinned bounds. The corrected ten-page run crossed
the boundary with ordinary posts. Neither the original five-page result nor
offline fixtures were used to mark Stage 1 complete.

The worker binary used for this development run matched the checked-in worker
source. Its executable SHA-256 was
`917195b012b3a915893052fefbcfbeb27da948fc919c8742cc52ed374952cf3b`;
worker source SHA-256 was
`258dc01098a1291ef9e789fbb31a11cd6d626d6e3deccceab34caf6c62fc69b8`.
The client was the pinned twitter-cli 0.8.6 commit
`7c634e0d396b1e7af9f63315b414925fe4f29ae7`.

## Coverage and ordering decisions

- **Supported bounded target:** This account supplied posts spanning the
  requested September 24–October 1 window within ten pages. That is an observed
  account-specific span, not a universal seven-day or thirty-day guarantee.
  A thirty-day initial-import target remains configurable and unvalidated.
- **Ordering:** Each page began with the same old pin. A newer reply appeared
  beside its parent, producing another ordering inversion. No consumer may
  stop at the first old or already-seen post. Later retrieval needs deduplication
  and validated overlap across the ordinary timeline, with gaps disclosed.
- **Dates:** The worker supplies no date-bounded timeline endpoint. The probe
  walks its fixed page budget and classifies dates locally using inclusive
  start/exclusive end. Authored posts use publication time; reposts use the
  wrapper's event time. Missing timestamps remain unknown. Reaching an older
  unpinned post is evidence of crossing a boundary, not evidence of complete
  coverage between the bounds.
- **Replies:** A thread reply was visible and read successfully. `UserTweets`
  supplied it inside timeline content; this does not validate a complete
  standalone replies feed. The adapter exposes no separate replies operation.
  Later UI must qualify reply coverage rather than imply that all replies were
  retrieved.
- **Text:** Long parent/reply text was available in both timeline and detail
  reads. Matching text proves consistency of these adapter paths. It does not
  independently verify fidelity against X's rendered post, complete threads,
  linked pages, media or Articles. Truncated/restricted payloads remain summaries
  and are not eligible for full-text analysis.
- **Access:** This run encountered no challenge, rate limit, expired cursor,
  protected-account failure or provider end. Those cases remain unobserved
  live; deterministic fault tests cannot establish their live behavior.
  A missing cursor would mean only that no further page was supplied.

## Optional search assessment

The pinned client's `fetch_search` uses `SearchTimeline` through GraphQL POST
and supports product selection such as `Latest`. Its implementation aggregates
results internally rather than exposing the page/checkpoint contract required
by durable historical retrieval. See the pinned
[client source](https://github.com/public-clis/twitter-cli/blob/7c634e0d396b1e7af9f63315b414925fe4f29ae7/twitter_cli/client.py).

Scope's `ReadClient` permits GET only and allowlists profile, timeline and
individual-post operations. The desktop broker and normalized provider contract
also have no search operation. Remote search is therefore **deferred**, with no
live search claim. Any future extension needs a specific read-only POST
allowlist, validated cursor/date behavior, normalized provenance, and broker
tests; it must not broadly enable the client's mutation methods. It would
supplement the archive and could not establish exhaustive history.

## Reproduce the probe

Start the development desktop with `npm run desktop:dev`, connect X in Settings,
and identify its **Next backend PID** (not the Electron main PID). On Linux:

```sh
npm run x:validate-retrieval -- \
  --desktop-pid BACKEND_PID \
  --handle blknoiz06 \
  --since 2026-09-24T00:00:00Z \
  --until 2026-10-01T19:23:26.111Z \
  --pages 10 \
  --output /tmp/scope-x-retrieval-validation.json
```

The PID option privately imports only the two broker environment entries from
the running backend. It never decrypts session files or reads browser cookies.
Other platforms can run the command from a maintainer environment already
supplied with `SCOPE_X_BROKER_ORIGIN` and `SCOPE_X_BROKER_TOKEN`; keep those
credentials out of command arguments and logs.

Omit dates for a rolling seven-day target. Use timezone-qualified ISO instants.
The default is five pages with a 180-second deadline; `--pages` accepts 2–20.
`--reply-id` and `--long-post-id` select known samples instead of discovered
ones. `--help` lists options. The report defaults to `/tmp`, and should be
reviewed before copying into repository evidence.

The command fails if connection, pagination, boundary, reply or complete
long-text checks are unmet. A failed provider read retains successful page
observations and a typed error; it does not retry or resume automatically. No
archive, creator, list or cursor state is written. No UI, job scheduler or
automatic refresh is installed by this stage.

## Verification

- Deterministic probe tests cover pinned/reordered entries, duplicate ids,
  cyclic cursors, missing dates, bounded traversal, absent timeline replies,
  connection failure and partial results after a rate limit. They are explicitly
  labeled fixture evidence, including fixtures whose provider id is `worker`.
- The live probe passed all four checks against the requested account.
- Existing mapper and worker regression tests passed with the probe tests
  outside the restricted sandbox (sandboxed fixture subprocesses returned
  empty stdout). TypeScript and targeted ESLint checks passed.
- `agent-browser` drove the running development desktop through Settings,
  Creator library and the cached `@blknoiz06` feed, expanded an authored post,
  toggled replies, and checked for renderer errors; none were reported.

Stage 2 can build the cached dashboard with these qualifications. Stage 3 must
not treat the observed ordering or bounded span as proof of exhaustive history.
