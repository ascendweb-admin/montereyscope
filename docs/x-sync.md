# X sync: how Scope keeps the X Dashboard fresh

This is how Scope decides what to read from X and when, using the bundled
twitter-cli worker. Everything is designed around one hard limit.

## The constraint

- **X allows 50 profile-timeline reads per 15 minutes per account.** The
  worker sees it in X's headers (`x-rate-limit-limit: 50`). One read returns
  about 20 posts. Profile lookups, single-post lookups and people search have
  their own, separate quotas.
- **The quota belongs to the X account, not to Scope.** x.com in a browser, a
  second Scope (the dev build next to the installed app) and any other tool
  signed in as the same person all spend it. In a live test on 2026-10-14, X
  reported 3 of 50 reads left before Scope had read anything in that window.
- **Each read takes about 1–2 seconds** end to end (spawning the frozen worker
  takes ~0.36 s, the rest is X). Reads are strictly one at a time: the session
  is shared, so parallel reads would only trip X's limits sooner.

So: about 200 timeline reads an hour, ~4,000 posts an hour at most. Speed
comes from spending those reads on what you're looking at, never wasting one,
and showing every post the moment it is saved.

## What went wrong before

Measured from a real archive (14 accounts, two lists):

1. **New posts didn't appear until you changed the timeframe.** The feed only
   reloaded when a whole sync finished. Three accounts had a catch-up that
   never finished, so the list stayed "Checking for new posts…" forever and
   the feed never reloaded.
2. **Those catch-ups burned the quota on every launch.** Before `142c1e2`, one
   deleted post sent a catch-up through the account's whole history (97 pages
   each). Every later sync re-attached to the same unfinished task with its
   window frozen on Oct 8, so those accounts got no new posts for six days and
   used up the 50 reads within ~90 seconds of each launch.
3. **One 429 blocked everything for 15 minutes**, including searching for and
   adding accounts, although X limits each endpoint separately.
4. **Every catch-up looked the profile up again** (two requests per account
   per sync), only to learn the pinned post.
5. **The timeframe chips didn't fetch anything.** A first import read 7 days;
   30d/90d only showed whatever happened to be saved.
6. **Switching lists queued the new list behind the old one** (first come,
   first served).

## How it works now

### One queue, by priority, paced against the quota

Every X read goes through `lib/x/scheduler.ts`: one at a time, most urgent
first, re-ranked every time the connection frees up. Timeline reads also
check the quota. When X reports it (the worker now passes the headers along
with each page) Scope follows it exactly. Otherwise it counts its own reads.
Each priority leaves a reserve untouched for the ones above it:

| Priority | What | Stops when this many reads are left |
| --- | --- | --- |
| 0 | Interactive: searching, adding an account, connecting | never waits (own quota) |
| 5 | **Update now** for the accounts on screen | 0 |
| 10 | New posts for the accounts on screen | 2 |
| 20 | New posts for everyone else | 6 |
| 30 | Older posts for the timeframe on screen | 12, or enough for one Update now of the list on screen (up to 25) |
| 40 | Everything else older (first imports' history, research windows) | 20, or list size + 8 (up to 30) |

So a big import slows down long before it could delay new posts, and
"Update now" always has reads left for the list in view. A 429 holds only
timeline reads, until the time X gave (desktop and server side).

### When each account is checked

There is no "sync everyone every 30 minutes" job anymore. A scheduler pass
runs every 30 seconds (and immediately when you open a list or change the
timeframe) and checks the accounts that are **due**:

- **On screen:** as often as their share of the quota allows: every
  `max(3 min, accounts × 45 s)`, capped at the Settings interval. 2 accounts →
  every 3 min, 14 → every 10½ min, 40+ → the Settings interval. That uses at
  most ~20 of the 50 reads per window.
- **Not on screen:** the Settings interval (default 30 min).
- **Update now:** every account in view, right away, ahead of all automatic work.
- **Failures** wait one interval before retrying; protected or missing
  accounts wait four. Nothing automatic runs while X is disconnected.

"On screen" means the X Dashboard reported it in its status poll within the
last 45 seconds.

### What a check costs

- **One read** when fewer than ~20 posts arrived since the last check: the
  catch-up stops as soon as a page reaches back past the last sync and shows
  a post it already knew.
- A busy or long-unsynced account reads **at most 3 pages at "new posts"
  priority**. Those count as synced, and the rest of the gap back to the last
  sync continues as background history. No account can hold the list
  "syncing" again.
- A catch-up left from an earlier run (app closed mid-sync) is retired the
  same way instead of being continued: its pages become background history
  and a fresh check reads from the top.
- The profile lookup (for the pinned post) is reused for 24 hours, so a check
  is one request, not two.

### Timeframes

- **24h / 7d:** a new account's first import covers 7 days (Settings). Its
  newest 2 days (or 5 pages) come first, and the rest fills in behind.
- **30d / 90d:** picking one fills in the missing older posts for the
  accounts on screen, in the background, continuing exactly where each
  account's saved history ends (no re-reading). A line under the filters
  shows progress ("Filling in the last 30 days · 9 of 14 accounts done") and
  the end of the feed says older posts are still arriving.
- **All:** fills in automatically back to 90 days and shows everything saved.
  X's profile timeline only serves an account's last ~3,200 posts anyway.
- How far back each account is complete is remembered (`coveredSince` on the
  head checkpoint), and catch-ups keep it contiguous, so this happens once.

Only one older-posts import runs per account at a time. Choosing 90d while a
30d fill is running continues to 90d after it.

### Switching lists

Nothing is cancelled. Within a second the new list's accounts become "on
screen", so their reads move to the front of the queue at the next turn,
including their older posts for the timeframe. The previous list's remaining
work keeps going behind them, and its accounts go back to the normal
background interval.

### Feed updates

The status poll (every 8 s; 1.5–4 s while something is happening) returns a
revision that changes whenever a post is saved for the accounts in view.
When it changes:

- at the top of the feed, the new posts slide in;
- further down, an "N new posts" button appears without moving what you read;
- older posts that arrived are reachable by scrolling, and the AI panel's post
  count updates.

Posts appear as each account's read lands, not when the whole list finishes.

## Budget in practice

For 14 accounts while viewing "All accounts": checks cost ≈ 14 reads per 10½
minutes (≈ 20 per window), leaving ≈ 30 per window for older posts. A
30-day fill-in for accounts that post 10 times a day takes ~15 reads each.
For a very busy account (100+ posts a day) it is closer to 150, so it
finishes over an hour or two in the background while new posts keep arriving
on time.

## Where it lives

- `lib/x/scheduler.ts`: the queue, priorities, reserves and quota model.
- `lib/x/focus.ts`: what is on screen, and Update now boosts.
- `lib/x/research/retrieval.ts`: durable traversals; bounded catch-ups,
  retiring leftovers, backfills from the covered edge, per-account state.
- `lib/x/dashboard/sync.ts`: due checks, the 30-second pass, coverage and
  the feed revision.
- `desktop/x-worker/worker.py`: reports X's quota with each timeline page.
- `desktop/lib/x-connection.cjs`: holds a 429 per operation.
- Development: `SCOPE_X_FAKE_PROVIDER=1 SCOPE_X_FAKE_LIVE=1` makes the fake
  provider post on a real-time schedule with X-like latency and quota
  (`SCOPE_X_FAKE_LATENCY_MS`, `SCOPE_X_FAKE_QUOTA`, `SCOPE_X_FAKE_WINDOW_SEC`).

## Next levers (not built)

1. **Search as a cheap "anything new?" check.** One `SearchTimeline` request
   with `from:a OR from:b …` covers ~20 accounts and spends a *separate*
   quota, which roughly doubles the read budget. Trade-offs: search can miss
   posts (filtered or search-suppressed accounts, reposts excluded by
   default), and it needs a POST in the read-only worker. Profile timelines
   would stay the source of truth; search would only decide which accounts to
   read now.
2. **A long-lived worker process** instead of one per read: saves ~0.4 s per
   read (spawn plus re-parsing the x.com transaction seed). Matters most for
   bursts (first imports, Update now on long lists).
3. **Per-account cadence by posting rate:** check busy accounts more often
   than quiet ones within the same budget.
4. **"Load older posts"** past 90 days on All, and a Settings control for the
   background interval (API only today).
