# X Research Stage 3 verification — 2026-10-02

Stage 3 implements durable, manually initiated retrieval. Search and corpus
analysis remain Stages 4–6. Browser fixture checks and live X checks below are
separate evidence sources.

## Automated checks

- `npm run typecheck`: passed.
- Targeted ESLint on `lib/x/research`, `app/x-research`, `app/api/x-research`,
  the new retrieval tests, and modified database/X modules: passed.
- `SCOPE_NEXT_DIST_DIR=.next-stage3-build npm run build -- --webpack`: passed,
  including production TypeScript checking and all X Research routes.
- `git diff --check`: passed.
- 109 tests passed across nine suites:

```sh
npx vitest run \
  tests/unit/x-durable-retrieval.test.ts \
  tests/unit/x-retrieval-routes.test.ts \
  tests/unit/x-research.test.ts \
  tests/unit/x-service.test.ts \
  tests/unit/x-http.test.ts \
  tests/unit/x-mapper.test.ts \
  tests/unit/x-retrieval-validation.test.ts \
  tests/unit/migrations.test.ts \
  tests/integration/db-durability.integration.test.ts
```

The durable fixtures cover 2,000 canonical archived posts plus 15 new posts
across an actual SQLite close/reopen. Catch-up reads three pages instead of
the entire archive, produces 2,015 unique posts, preserves every original
body and the legacy older-history cursor, and never treats a recurring old
pin, individual import or familiar repost as sufficient overlap.

Additional cases cover interrupted initialization, multi-page catch-up gaps,
independent historical checkpoints, inclusive DST date bounds, missing dates,
reordered entries, expired/cyclic/stalled cursors, configuration changes,
skipped entries, bounded transient retries, rate-limit delays, time budgets,
expired sessions, protected-account failures, shared jobs, cancellation,
and immediate retry while cancellation is still settling. A failed SQLite
page commit cannot persist its unsaved cursor or progress. Weaker duplicates
within a page cannot erase complete text; text retrieval timestamps remain
separate from availability observations. Unfinished jobs remain discoverable
beyond the recent-job window. Separate service module loads share one mutex.

## Fixture browser checks

Started Next development mode on loopback with `SCOPE_X_FAKE_PROVIDER=1` and a
temporary SQLite database. Used the named agent-browser session
`scope-x-stage3` to connect X, resolve/preview/save a creator, create a list,
read the existing archive, refresh, fetch requested history, change date/type
filters and selections, inspect coverage and saved job progress, and show jobs
from other scopes.

- An empty research selection disables historical fetch but still permits a
  clearly labeled refresh of the entire active list.
- A first explicit refresh caches 24 fixture posts. Adding the same creator
  to a list reuses them; another refresh reports zero new posts.
- Refresh and historical fetch preserve the selected date preset/window.
- Opening a shortened cached post leaves its text/status unchanged. Only
  clicking **Fetch full text** retrieves the body; the dialog then shows
  complete text. Escape closes the dialog and restores the Details trigger.
- Desktop and 390px narrow layouts were checked. The measured document width
  was 375px against a 390px viewport, with no horizontal overflow.
- No renderer errors were reported by agent-browser.

See the [narrow screenshot](narrow.png). The development directories and
Next-generated TypeScript configuration additions were removed after testing.

## Live desktop checks

Started the development Electron app using the existing saved X login and a
temporary database. Attached agent-browser to the app's local debug port and
used the normal UI. No process-environment authentication token attachment,
browser-cookie extraction or fake provider was used for these live reads.
The creator was `@blknoiz06`, as in Stage 1.

1. Saving the resolved creator left the temporary database with zero posts
   and zero retrieval jobs until **Refresh feed** was clicked.
2. A configurable one-day initial target with a two-page attempt budget
   committed 41 unique posts and paused. Manual Resume reached the qualified
   boundary at three total pages and 60 unique posts.
3. A real desktop restart preserved every archived text hash, list membership
   and checkpoint. Opening the saved feed started no retrieval job.
4. The next manual refresh stopped at saved overlap after two pages: zero
   new canonical posts and eight updated existing posts. The archive remained
   60 rows and the display dates stayed unchanged.
5. A one-page historical attempt paused, was cancelled through the UI, and
   resumed manually to two cumulative pages. Its head checkpoint stayed
   byte-for-byte unchanged.
6. A separate 30-day calendar request was interrupted by closing the desktop
   while running. Six committed pages and 119 canonical posts survived with
   exact text, text-observation metadata and checkpoint hashes. After reopening,
   the UI showed **interrupted** and offered Resume; no automatic retrieval
   resumed. See the [interrupted desktop screenshot](interrupted-desktop.png).
7. Clicking Resume continued from the saved traversal for ten more pages,
   stopping at the next explicit page budget with 16 cumulative pages and
   312 unique archived posts. Historical work still left the head checkpoint
   unchanged. A DOM marker on a cached Details button survived the progress
   updates, verifying that cached cards remained mounted. The final source
   dialog displayed separate text/availability timestamps, and Escape restored
   focus to Details. No renderer errors were reported.

The [sanitized live record](live-retrieval.json) contains counts, bounds,
statuses, public post IDs and text hashes, without post bodies, credentials,
raw provider cursors or account-session data.

## Limits and reproduction

The default initial target is 30 days, with ten pages and a three-minute bound
per creator attempt; actual provider page sizes/access vary. Resume retains
the original task's bounds and limits. Provider ordering is qualified: overlap
requires the saved ordinary-post anchor set from two pages, excluding the
resolved pin and reposts. A date boundary requires two consecutive dated
ordinary pages beyond the requested start. Neither rule proves exhaustive X
history. Missing dates/skipped entries and unrecovered anchors prevent false
completion. Protected accounts, rate limits and expired cursors were tested
in fixtures; they were not independently observed live during this run.

To reproduce live checks, launch the development desktop with a temporary
`SCOPE_DB_PATH` and `--remote-debugging-port`, attach a named agent-browser
session, and use the saved X connection through Settings/X Research. Refresh,
history, hydration and Resume each require an explicit UI action. Do not
substitute fake-provider browser checks for live retrieval evidence.
