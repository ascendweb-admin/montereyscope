# X Research Stage 2 verification — 2026-10-01

This is **offline fixture evidence**, separate from the live Stage 1 retrieval
validation. No real X timelines were fetched for Stage 2 verification.

The isolated development server used a disposable SQLite database at
`/tmp/scope-stage2-browser.db`, port 3102 and `SCOPE_X_FAKE_PROVIDER=1`.
The archive contained 68 canonical fictional posts, including 67 dated posts,
an undated post, a long body, a quote, a reply, summary/unavailable statuses,
and two posts shared between timelines. An unselected older creator also held
the first post, exercising the scoped-deduplication regression.

## Automated checks

```sh
npm run typecheck
npx vitest run tests/unit/x-research.test.ts tests/unit/migrations.test.ts \
  tests/unit/x-service.test.ts tests/unit/x-mapper.test.ts \
  tests/unit/category-repository.test.ts tests/unit/creator-repository.test.ts \
  tests/unit/x-retrieval-validation.test.ts
SCOPE_NEXT_DIST_DIR=.next-stage2-build npm run build -- --webpack
```

- 88 tests passed across seven files. Research-specific checks cover archive,
  membership and checkpoint preservation across database reopen; atomic input
  rejection; list rename-only updates; creator deletion cascade; scoped
  deduplication and sharer attribution; all four post types; missing repost
  dates; incomplete text; 30/30/7 pagination; empty selections; calendar dates,
  spring/fall DST and a nonexistent calendar day; stale-list and invalid API
  requests. The provider boundary throws if called during dashboard route tests.
- Targeted ESLint passed for all Stage 2 source and test files.
- Webpack production build passed and registered the new page and three API
  route paths. The default Turbopack build encountered environment restrictions
  on font fetching and subprocess port binding; webpack was used to verify the
  production bundle without changing the repository's build script.

## agent-browser checks

The named `scope-stage2` session drove the real development UI:

- Created a list from the shared-library category snapshot; renamed it, edited
  its description and membership, and filtered the creator picker.
- Created a second list sharing the archive. Both showed 67 unique dated posts.
  Removed membership and deleted the second list; the archive stayed at 68
  canonical posts and the shared creators remained saved.
- Browsed pages of 30, 30 and 7 posts and returned to page one. Ad hoc selection
  of the archived creator also exposed all 67 dated posts.
- Filtered originals, quotes, replies and opt-in reposts. Repost-only browsing
  showed two posts with separate original-author and sharer attribution.
  Reply-only and quote-only browsing each showed one post. Selecting no types
  displayed the qualified empty state.
- Expanded the long post and opened cached source details. Quote text was
  inspectable; the reply disclosed that its parent was cached without claiming
  a complete thread. Escape dismissed the dialog and restored focus to Details.
- Changed native calendar controls with the keyboard, exercised an inverted
  date range, and recovered using the period selector. Checked 7-day, 30-day
  and rolling 24-hour presets, disabled calendar inputs in 24-hour mode, and
  invalid/valid timezone application.
- Aborted the cached-feed request using browser network interception; the UI
  displayed its error and Retry recovered after interception was removed.
- Tried an invalid creator link, exercised the fake connection prompt, resolved
  a new creator, reviewed its identity and saved it into the active list.
  Saved the same creator again from ad hoc selection without duplication.
  Saving after the final revalidation change preserved the custom date scope.
  The newly saved profile had zero archived posts: no timeline was auto-fetched.
- Inspected the library deletion confirmation and cancelled it. It named the
  affected research list and disclosed preservation of shared posts and saved
  chat/report snapshots.
- Stopped and restarted the dev server against the same database. The renamed
  list, three memberships, 67 dated posts and exact long cached text reopened
  with the fake X session disconnected.
- Checked 1440×1000 and 390×844 layouts; no horizontal document overflow.
  New-list keyboard dismissal restored focus. No renderer errors were reported.

A [sanitized network summary](cached-read-requests.json) records 81 browser
requests during reopening, ad hoc/list switching and filter changes: ten local
research-feed reads, zero X timeline/detail requests and zero X connection
requests. Only methods, paths and counts are retained; the raw HAR stays in
`/tmp` and is not included. Existing global AI metadata/report polling is
separately visible in the summary.

Final screenshots use only fictional fixture data:

- [Desktop](desktop.png)
- [Narrow list picker](narrow.png)
- [Narrow feed](narrow-feed.png)

Manual retrieval, durable retrieval jobs, historical fetching, search and
research execution remain subsequent stages. Cached date bounds and legacy
refresh timestamps do not establish exhaustive history or complete reply
coverage.
