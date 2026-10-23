# Other videos: execution slices

Four slices that build phase 1 of [Other videos](../other-videos-import.md) (YouTube and Rumble).
Run them **in order, one per session**. Each slice file is self-contained: it says what to read, what
to build, what not to touch, and how to know it is done.

| Slice | File                                               | Outcome                                                                                      | Status |
| ----- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| 1     | [slice-1-foundation.md](slice-1-foundation.md)     | Hidden hosts, attribution table, cache-clearing guard. Nothing changes on screen.            | Done   |
| 2     | [slice-2-engine.md](slice-2-engine.md)             | Link parsing, resolve + English-caption gate, import service and server actions. No UI.      | Done   |
| 3     | [slice-3-first-usable.md](slice-3-first-usable.md) | "Add videos" dialog, "Other videos" tab, AI labelling, correct feed/picker labels and links. | Done   |
| 4     | [slice-4-polish.md](slice-4-polish.md)             | Add-dialog video branch, Follow channel, citations, Rumble alignment, docs, final test pass. | Done   |

Phase 1 is complete. Phases 2 (more sites) and 3 (paste in the source picker) are not sliced yet.
Decide after using phase 1 on real research.

## How to run a slice

Start a fresh session (`/clear`) and give it this prompt, changing only the file name:

```
Implement docs/proposals/other-videos-slices/slice-1-foundation.md.
First read AGENTS.md, docs/proposals/other-videos-slices/README.md and
docs/proposals/other-videos-import.md (the design). Stay inside the slice. Stop when its acceptance
checks pass, update the status table and slice log in the README, and report. Do not commit.
```

## Ground rules for every slice

- **Read first:** `AGENTS.md` (this Next.js has breaking changes: read the relevant guide in
  `node_modules/next/dist/docs/` before touching server actions, route handlers, pages or
  `searchParams`), the design sections the slice cites, then the slice file.
- **Baseline:** before changing anything, `git status` shows only earlier slices' work, and
  `npm run typecheck && npm run lint && npm test` pass. If the baseline is red, stop and report.
- **Stay in the slice.** Do not start the next slice's items. If you need something from a later
  slice, stub it minimally and note it in the slice log.
- **Tests:** vitest. Database tests use the in-memory/temp pattern in
  `tests/unit/creator-profiles.test.ts` (`new Database(...)`, `runMigrations(db, ALL_MIGRATIONS)`,
  `foreign_keys = ON`). Component tests use happy-dom and mock server actions, as in
  `tests/component/add-creator-dialog.test.tsx`. Network access in tests is only through injected
  runners or the fake yt-dlp; real-network checks are opt-in (see slice 2).
- **Browser testing (`AGENTS.md`):** for anything user-visible, copy the real library
  (`sqlite3 -readonly ~/.local/share/scope-desktop-dev/data/localtube.db ".backup <scratchpad>/localtube.db"`;
  the real desktop library is `~/.local/share/scope/data/localtube.db`), run
  `SCOPE_DB_PATH=<copy> SCOPE_AI_JOBS_ROOT=<scratchpad>/ai-jobs npx next dev -H 127.0.0.1 -p 3123`,
  and drive it with `agent-browser`. **Never point a dev server at a live database** (migrations
  would run on it). If a second dev server rewrites `tsconfig.json`, `git checkout -- tsconfig.json`
  afterwards. Do not spend AI quota on a real chat turn without asking the user.
- **Formatting:** run `npx prettier --check` on every file you touched and fix what it reports.
- **Finish:** all acceptance checks pass; update the status table above; add a slice-log entry; give
  the user a short report (what was built, anything deferred or changed, how to try it). Do not
  commit unless asked.

## Slice log

Record deviations from the slice file and decisions the next slice needs. Newest last.

**Slice 1 (foundation), done 2026-10-23.** Built as written. Deviations and hand-off notes:

- **Merging people carries attributions.** `mergeProfiles` and `moveAccountToProfile` delete the emptied
  profile by trigger, which would cascade away its `profile_videos` rows and strand a hidden host's
  videos. Both now copy the source's attributions (keeping `added_at`, so label order survives) to the
  target first. Not in the slice file; tested in `creator-profiles.test.ts`.
- **Promoting a hidden host keeps the avatar.** `addCreator` flipping a hidden duplicate to followed
  also fills `avatar_url` from the input when the host has none (hosts are saved without one). Slice 4's
  "Follow channel" still fetches the avatar itself.
- **`removeProfileAccounts` only removes followed accounts**, so a hidden host's profile id is "not
  found" for `removeProfileById` like everywhere else.
- **`resolveCreatorPageTarget`** lives in `lib/creators/page-target.ts` and returns
  `{ kind: "show" } | { kind: "redirect", profileId, accountId } | { kind: "notFound" }`. It redirects
  only for a **followed** requested account that lives in a different profile.
- **Settings.** `CacheCounts` gained `keptVideos`; `cachedVideos` is now the clearable count. When
  videos are kept, the form re-reads counts and sizes after clearing, via a new
  `getCacheSizesAction` (and the existing, previously unused `getCacheCountsAction`). The "Nothing to
  clear" toast reads "only videos you added to Other videos are cached" when `keptVideos > 0`.
- **Signatures slice 2 relies on, unchanged from the slice file:** `addCreator({ followed })`,
  `insertVideoIfMissing(db, creatorId, draft): boolean`, `attachVideoToProfile`, `profilesExist`
  (followed-only), `listCreators` / `listAllCreators`. Also exported: `setCreatorFollowed`,
  `listProfileVideos` (returns `ProfileVideo`: a `VideoRecord` plus `hostName`, `hostPlatform`),
  `countProfileVideos`, `listFeaturedProfiles`, `removeAttributedVideo`.
- **Known gap for slice 3:** until it fixes feed and picker labels, a hidden host's video still shows in
  `/feed` and the chat picker under the host's name, and `/channels/<hidden>/videos/<id>` works but its
  back link points at the (404) host. No UI can create hidden hosts before slice 3, so nothing visible
  changes today.
- **Migration 032 is final.** The desktop dev app hot-reloaded this tree and already applied it to its
  own dev library, so the SQL must not be edited; add a 033 for any change.

**Slice 2 (engine), done 2026-10-23.** Built as written. Deviations and hand-off notes:

- **Files.** `lib/videos/import/{links,errors,resolve,pool,preview-cache,service}.ts`,
  `app/actions/videos.ts`, and `app/actions/revalidate-library.ts` (the shared helper moved out of
  `creators.ts`; it already revalidated `/feed` and `/chat`, so no paths were added). Previews and
  imports both go through `resolveVideoLinkCached` (in `preview-cache.ts`), so a preview followed by an
  import resolves each link once.
- **Preview shape (what slice 3 reads).** `previewVideoLinkAction(url, profileId?)` returns
  `{ ok: true, preview } | { ok: false, code, message, retryable }`, where `preview` =
  `{ url, videoId, platform, title, thumbnailUrl, durationSeconds, publishedAt, liveStatus, hostName,
hostHandle, hostPlatform, captions, alreadyInLibrary, alreadyAttached }`. `url` is canonical;
  `hostHandle` has no `@`; `captions` is `"manual" | "automatic"`. `alreadyInLibrary` and
  `alreadyAttached` are read from the database on every call, even when the resolution is cached.
  The type is `VideoPreview` in `lib/videos/import/service.ts`.
- **Import result.** `importVideosAction(urls, { profileId, followHost })` returns
  `{ ok: true, results } | { ok: false, message }`. `ImportRowResult.url` is the **canonical** link for
  anything parseable (duplicates collapse into one row) and the trimmed input text otherwise, so match
  rows by running links through `extractVideoLinks` first. Statuses: `added`, `attached_existing`,
  `already_attached`, `rejected` (with `error: { code, message, retryable }`). Invalid whole-request
  input (no person without `followHost`, an invisible person id) rejects every row with
  `invalid_input` before any network work.
- **An already-cached video keeps its own host.** The slice file says to find or create the host with
  `addCreator` for every row. For a video that is already in `videos` the service skips that and uses
  the stored `creator_id` (only `followHost` can change it, by flipping that host to followed).
  Otherwise a preview resolved before a feed refresh cached the same video could leave a brand-new
  source-only host with no video, breaking the "every hidden host has an attributed video" rule.
  Covered by a test.
- **`followHost` with no person** (`profileId: null`) imports under a followed host and attributes
  nothing; slice 4's Rumble alignment can use it. A video that is already cached then reports
  `already_attached` (nothing to attach).
- **Known-video shortcut details.** A cached transcript only short-circuits when its language is
  English (same check `getCachedTranscript` makes). For a cached video without a transcript, a stored
  `is_live`/`upcoming` status turns "no English captions" into `live_or_upcoming`.
- **Verdict order** is metadata failure, then live/upcoming, then a caption-lookup failure, then "no
  English track". yt-dlp refuses scheduled streams and premieres outright ("This live event will
  begin in..."), so `classifyVideoJobFailure` maps that stderr to `live_or_upcoming` too.
- **Error codes.** `spawn_failed` maps to `ytdlp_missing` (retryable) and `output_limit` to
  `unexpected_response`. `unexpected_response` is a rejection, not retryable, as the slice file lists
  it. A Rumble video whose payload has no channel reports `unexpected_response` (the existing Rumble
  parser's wording) rather than `no_channel`; the old Rumble path was left untouched.
- **Fixture variants are derived, not stored.** Only `youtube-video-captions.fixture.json` (trimmed
  from a real `--dump-single-json` of `jNQXAC9IVRw`) and `video-caption-discovery.fixture.json` (the
  five compact discovery payloads) are files. The no-channel, `is_live` and `is_upcoming` variants are
  built from the base by `tests/helpers/video-import.ts`, so they cannot drift from it. That file also
  holds `fakeRunner` and `routedRunner` (per-link replies for multi-link tests).
- **Live tests.** `SCOPE_LIVE_VIDEO_IMPORT=1 npx vitest run tests/integration/video-import-live.test.ts`
  covers the positive case and an import into an in-memory database. There is **no negative live
  case**: every public video tried (including a Korean-language one) lists English automatic tracks,
  see the next note.
- **The English gate is only as strict as chat's discovery, and that is looser than its comments
  say.** With the installed yt-dlp (2026.08.19) `--extractor-args youtube:skip=translated_subs` no
  longer removes machine-translated tracks (157 languages listed with or without it), so a video in
  another language still shows an automatic `en` track and passes the gate. Chat would fetch the same
  translated track, so the two agree; tightening it (for example requiring `en-orig` when there is no
  human track) belongs in `lib/ytdlp/subtitles.ts` and affects transcripts too, so it was not changed
  here.
- **Rumble from this machine.** Plain `yt-dlp` gets `HTTP Error 403` from Rumble here, so a real Rumble
  import ends as `throttled` after the paced retry; Rumble is covered by the fixture-driven tests only.
- **Smoke on a copy of the real library.** Importing two YouTube links into an existing person added
  two hidden hosts (`followed = 0`, no avatar, no refresh stamp) and two attributed videos; the
  visible creator count and the people list were unchanged.

**Slice 3 (first usable), done 2026-10-23.** Built as written, in the order A, C/B, D. Deviations and
hand-off notes:

- **Labelling rule, one definition.** `lib/videos/attribution.ts` gained `listAllFeaturedProfiles`
  (one read for the library-wide surfaces) and `labelProfileOf(featured, hostProfileId)`: the first
  attached person **who does not own the hosting channel**. A person's own channel video attributed to
  them is just theirs, not an appearance, so it never reads "Luke on Luke". The feed, the source
  library, the video page and report sources all use it; `scope.ts` (`featuring`) lists every
  attached person.
- **Feed items.** `buildFeedItems(db, accounts, { featuredProfileId })` also takes a `featured: true`
  flag on `FeedVideoItemModel`. On a person's own Overview the label is **that person** even when
  someone attached earlier is also featured (links stay on the page being viewed); in the shared feed it
  is the first attached person. The default byline now shows "on {host}" next to the name for
  featured rows (the slice only changed `accountLabel`, which that byline never displayed).
- **Picker.** `PickerVideo` gained `platform` next to the three fields in the slice file: a hidden
  host has no creator row, so without it the platform mark was missing and the platform filter hid the
  appearance. `loadSourceLibrary` reads it from `listAllCreators`. `ChatWorkspaceVideo` carries the same
  fields and the chat page's citation index uses the featured person's avatar and the video's platform
  (small addition; the citation `channelName` stays in slice 4).
- **Reports.** `ReportSource` gained `featuredNames` **and `featuredProfileIds`** (counting needs
  ids); both are left off a channel's own videos. `describeReportPeople` still adds a hidden host's
  **platform** to the report's platforms (a YouTube appearance is a YouTube source) but never lists it
  as a person. The report detail's source row reads "{names} on {host}".
- **Single-account people.** The page lands on the account as before; their Overview needs an
  explicit `?view=overview` (the tab's address), multi-account people keep `/creators/<id>`.
  `?view=other` with no videos, or `?view=overview` without tabs, falls back to the default view.
  After removing a person's last Other video the page navigates to `/creators/<id>?notice=...`, which
  the header turns into the toast.
- **`removeVideosAction(profileId, videoIds)`** wraps a new `removeAttributedVideos` (one transaction;
  ids not attributed to that person are skipped, so a stale selection never deletes anything else) and
  returns `{ removed, deletedVideos, deletedHosts }`.
- **Extracted components (slice 4 reuse).** `components/creators/video-preview-card.tsx` exports
  `VideoPreviewSummary` (thumbnail, title, host, duration, platform, captions chip), `CaptionsChip` and
  `PlatformMark`. The dialog's row state (checking, ready, already, rejected, failed) lives in
  `add-videos-dialog.tsx` and is not exported. Also new: `FeedTabs` `singleList` (no Videos /
  Livestreams switcher when a list can never hold a livestream), `ScopeSelectionBar` `onRemove`,
  `VideoCardModel` `subtitle` / `hostName` / `platform`.
- **Video page.** For a followed host the page keeps its own account back link and shows the
  "Featuring" and "on {host}" chips when others are featured; for a source-only host the Channel line is
  plain text (there is no page to link to). Ask AI there is labelled with the featured person.
- **Add videos dialog.** While any link is still checking, "Add N videos" stays disabled (the rest
  stays usable); while saving everything disables and the dialog cannot be dismissed. A row whose save
  fails with a final answer (for example no English captions) becomes a rejected row; a transient
  failure keeps its tick and gets a Retry. After an import the page refreshes but stays on its
  current tab, as the slice says.
- **Browser check** (copy of the dev library, real public videos, `agent-browser`): mixed paste on
  a single-account person gave Ready for two YouTube videos, "Rejected: ... channel link", "Rejected:
  unsupported site", a collapsed repeat, a rejected no-captions video (`aqz-KE-bpKQ`, which has no
  captions at all, so the check works with it) and Rumble **"Couldn't check" + Retry**: Rumble returns
  403 from this machine, as noted for slice 2, so a Rumble row could not be seen Ready. Add 2 added exactly
  the two ready videos; tabs `Overview 64 | YouTube 62 | Other videos 2` landed on the account; the
  multi-account person landed on the Overview with the new tab last; the library still said 13
  creators; the feed read "BridgeMind on jawed" and the AI category filter kept it while Crypto
  removed it; the picker grouped it under the person with "on jawed"; the video page's back link went
  to `/creators/3?view=other`; hidden `/creators/<host>` and `/channels/<host>` returned 404; removing
  both videos deleted them, their transcripts and both hosts. Keyboard-only through the dialog,
  phone width, dark mode and the console were clean. A real AI turn was **not** run (no quota
  spent); `materializeSources` against the copy's real cached captions wrote `Featuring: BridgeMind`
  after `Channel:`.
- **Known gaps for slice 4.** The citation card's `channelName`; the Add creator dialog's video branch;
  "Follow channel" and the host's avatar (a host followed through the dialog's switch has none until
  then); the tab strip does not scroll the active tab into view at phone width (the same for any
  tab past the edge, such as X).

**Slice 4 (polish), done 2026-10-23.** Built in the order Follow channel, video page, Add dialog,
citations, Rumble alignment, docs. Deviations and hand-off notes:

- **Follow channel.** `followCreator(db, id)` (`lib/creators/service.ts`) refuses a creator that is
  already followed (`already_followed`), flips `followed`, then looks the picture up best effort and
  never fails on it. The lookup lives in a new `lib/creators/host-avatar.ts` (`lookupHostAvatar`,
  `ensureHostAvatar`: YouTube through `resolveCreatorFromUrl`, Rumble through
  `fetchRumbleChannelIdentity`; a channel that already has a picture is left alone). It is a separate
  module so `app/actions/videos.ts` can use it without an import cycle. `setCreatorAvatar` validates with
  `isAllowedImageUrl`. `followCreatorAction(id)` returns `{ ok: true, creator } | { ok: false, message }`;
  the client starts the feed refresh with `refreshCreatorContentAction` (the same background task the
  source picker uses), and the toast links to `/creators/<profileId>`. `useToast`'s `showToast` gained an
  optional third argument `{ label, href }` for that link (such a toast stays 8 s instead of 5).
- **Import rows say which channel they landed on.** `ImportRowResult` gained `hostCreatorId` and
  `hostFollowedBefore` (set on every row that was not rejected). The follow-as-creator path needs both:
  the first to fetch the picture and apply categories, the second to answer "created" or
  "already_saved". Existing tests that compare whole rows were updated.
- **The avatar step also runs for "Also follow these channels".** `importVideosAction` now gives every
  channel it followed a picture (three lookups at a time, best effort). This closes slice 3's known gap
  (a channel followed through the Add videos switch had no picture). A channel that stays source-only is
  never looked up.
- **Add creator dialog, video branch.** `classifyCreatorInput` returns `"video"` for a link
  `looksLikeVideoLink` accepts, after expanding a bare host (`youtu.be/<id>`), ahead of `"link"` and
  whatever platform tab is selected. A dialog with `lockPlatform` (the X Dashboard's) treats it as a
  plain link again, so it keeps today's "choose the X platform" message. The confirm step is
  `components/library/video-link-confirm.tsx` and reuses `VideoPreviewSummary`; the people list is a new
  `ProfileSearchList` extracted from `ProfileTargetPicker` (which now uses it too). With a locked person
  ("Add platform") there is no choice to make, so **"Follow {host} as a creator" is not offered** there
  (the "Also follow {host}" switch is). With an empty library the person choice is disabled and following
  the channel is the only way in.
- **"Follow {host} as a creator" is its own action, not `importVideosAction` + a second call.** The slice
  text had the client call `importVideosAction([url], { profileId: null, followHost: true })` and then an
  avatar step "from the service". It is one server step instead: `followVideoChannelAction(url, categoryIds)`
  (in `app/actions/creators.ts`) calls `followHostWithVideo`, which runs that same import, then the picture
  and the categories, and answers `created` or `already_saved`. The categories picker therefore works as
  it does for any new creator, and a failure leaves nothing half done. Rejections come back as
  `{ ok: false, code, message, retryable }` and show inline next to the input, with `YtDlpSetupNote` for
  `ytdlp_missing`.
- **Rumble alignment.** `importRumbleVideo` and the video half of `resolveRumbleCreatorPreview` are gone;
  that resolver is channel-only (a video link gets "not a channel"). `addCreatorFromUrl`'s Rumble video
  branch and `saveRumbleCreatorPayload`'s video branch call `followHostWithVideo`, so a Rumble video link
  has the English-caption gate and leaves `last_refreshed_at` alone. `resolveCreatorFromAnyUrl` now takes
  the database first (`resolveCreatorFromAnyUrl(db, raw, platform?, deps?)`) because the engine's
  known-video shortcut reads it; for a Rumble video it previews the host (no picture, no follower count)
  with the canonical `videoUrl`. `CreatorPreviewModel` lost `videoTitle` and `videoId` but **kept
  `videoUrl`**: `saveRumbleCreatorPayload` still reads it for API-style callers (`addCreatorAction`,
  `POST /api/creators`). The dialog's `ResolvedPreview` and its "Saving this also imports the video" note
  are gone. Video import error codes (`no_english_captions`, `live_or_upcoming`, `no_channel`,
  `unsupported_site`, `invalid_input`) now have HTTP statuses for `POST /api/creators`.
  **`classifyDiscoveryFailure` was removed rather than kept**: the engine classifies with
  `classifyVideoJobFailure` (slice 2), so nothing called it any more, and every case it handled is
  covered in `video-resolve.test.ts`. `parseRumbleVideoPayload`, `pickRumbleThumbnail`,
  `runRumbleDiscovery` (with new direct throttle-retry tests) and `buildRumbleVideoDiscoveryArgs` stay in
  `lib/rumble/video-import.ts`, which is now only the metadata job and its parsers.
- **Video page.** `HostedVideoActions` is mounted for every video, shows **Follow {host}** and **Remove
  from {person}** only for a source-only host, and stays mounted afterwards so the follow toast survives
  the refresh. "Remove" acts on the person the video is labelled with (the first featured person); a video
  featuring two people is removed from one at a time. It lands on `/creators/<id>?view=other` with the
  confirmation, or on the page itself when that was the person's last Other video.
- **Citations.** `ChatSource.channelName` is optional and producers leave the key out instead of setting
  it to `undefined` (the live index is spread over the archived one, so an explicit `undefined` would blank
  an archived name). The card shows "on {channel}" only when it differs from `creator`. Producers:
  `chat-view` (`hostName` of an appearance), `selectable-feed` (the card's `hostName`), `feed-stream`
  (`FeedVideoItemModel.hostName`, set only for appearances) and the video page's Ask AI.
  **The manifest did not carry `Featuring`** (only the transcript file's header does), so
  `MaterializedSourceFile` gained an optional `featuring` (video entries, left out when empty) and
  `archivedChatSources` derives `creator` = the first featured name that is not the channel and
  `channelName` = the manifest's `creator`. Manifests written before this slice have no `featuring` and
  read exactly as before; threads made during slice 3 do not either (their transcripts have the header,
  their manifests do not), so they cite the host as before.
- **Small shared pieces.** `components/ui/switch.tsx` (the "Also follow" switch, now used by both
  dialogs), the toast link, and `ProfileSearchList`. Two layout fixes found in the browser: the
  `ProfileTargetPicker` and video step `<fieldset>`s now have `min-w-0` (their content overflowed the
  dialog at phone width), and the video step takes focus when it appears (the input that had it is
  replaced), on the choice, or on the primary button when the person is locked.
- **Optional e2e step skipped.** The only HTTP entry for a video import is `POST /api/creators` with a
  Rumble link, and following it fetches the channel page from rumble.com for the picture, which the fake
  yt-dlp cannot answer, so a hermetic test is not a small change. The fakes were not touched; the
  hermetic suite (`npm run test:e2e`, which also builds for production) passes.
- **Browser check** (copy of the dev library, real public YouTube videos, `agent-browser`; Rumble answered
  from the checked-in fixture through a yt-dlp wrapper because plain yt-dlp gets 403 here, while the
  channel-page fetch for pictures worked). Library header: a YouTube link added to a person (hidden host
  `jawed`, no picture, library still 13 people); a Rumble link followed as a creator with the Crypto
  category (14 people, Crypto 8 to 9, picture fetched, no refresh stamp, one video). "Add platform" on a
  person: the person locked, "Also follow officialpsy" followed it with its picture. Video page: Follow
  jawed followed it, fetched its picture, and its feed refresh ran (Activity showed "Updating creator",
  `last_refreshed_at` set); the buttons disappeared; search then marked it saved and there was one row.
  Remove from the page of a one-video host deleted the video, its host and the transcript rows and landed
  on `?view=other` with the toast. A seeded saved thread (archived manifest, no AI turn) cited "BridgeMind on
  jawed" (live and archived), "Luke Belmar on PBD Podcast" (archived only) and, for an old-format entry,
  the channel alone. YouTube and Rumble channel links, and X profile and post links, behaved as before.
  Settings, clear cached feeds: the dialog said "2 videos you added to Other videos are kept" and after
  clearing only those two videos, their attributions and hosts remained. Phone width (390 px), dark mode,
  keyboard-only through the dialog (focus order, Enter to select and to add) and the console were clean
  after the two fixes above. **A real AI turn was not run** (no quota spent).
- **Follow-ups worth deciding on.** "Create a person from this video" (people need an account, section 6
  of the design); removing a video that two people feature from both at once; the tab strip still does not
  scroll the active tab into view at phone width (slice 3's note); and the English gate is still only as
  strict as chat's discovery (slice 2's note on machine-translated tracks), which matters more now that
  Rumble and YouTube links share it.
