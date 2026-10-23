# Other videos: attach individual videos to a person

Status: **Phase 1 built** (YouTube and Rumble), 2026-10-23. Phases 2 (more sites) and 3 (paste in the
source picker) are not started; decide after using phase 1 on real research. The execution record,
including where the build differs from this design, is the slice log in
[`other-videos-slices/README.md`](other-videos-slices/README.md). Sections 2 and 6 below describe the
situation while planning, before the change.

## 1. Goal and decisions

Researching a person (for example, a guest who appears on dozens of other people's podcasts) means
collecting individual videos that live on **other people's channels**, across platforms. Today that
means adding every host channel, waiting for its feed, and hoping the episode is still inside the
cached window. YouTube video links are rejected outright.

The goal: paste video links onto a person, and have those videos behave like the person's own
content (browse, select, chat, report) without cluttering the library with host channels.

Decisions already made:

- **Host channels are hidden by default.** A host created by an import is a _source-only_ creator:
  no library card, no Refresh All, no counts. A "Follow channel" action turns it into a normal one.
- **Imports reject videos without English captions.** The check reuses the transcript pipeline's own
  caption discovery, so it matches what chat does later. No speech-to-text.
- **The UI name is "Other videos"** (a tab on the person's page).

Choices made while planning (flagged in section 6 for confirmation):

- Every imported video is **attached to a person**. The earlier "attach to nobody" option is dropped
  from v1 so that every source-only host always has an owner and cleanup stays a simple rule.
- Phase 1 covers YouTube and Rumble. Other sites come in phase 2 from a strict host allowlist.

## 2. What exists today

- YouTube video links are rejected with "That is a single video link. Paste the creator's channel
  page instead." (`lib/validation/creator-url.ts:72-74,109-114`).
- Rumble video links import the video **and** save the whole host as a visible creator
  (`lib/rumble/video-import.ts:379-389`). The import also stamps the host's `last_refreshed_at`
  through `mergeCreatorFeed`, so the card claims a refresh that never happened.
- `videos.creator_id` is `NOT NULL ... ON DELETE CASCADE` (`lib/db/migrations.ts:36`). Every video
  needs a creator row, and transcripts, digests and attributions hang off the video.
- `mergeCreatorFeed` overwrites `creator_id` on conflict (`lib/videos/repository.ts:239`). It is
  correct for feed refreshes and wrong for importing a video that already belongs to someone.
- Feed window: 30 items per tab by default, 300 at most (`lib/settings/settings.ts:38-40`). Rumble
  reads one listing page (about 25).
- Transcripts are captions-only and English-only (`lib/transcripts/service.ts:225-262`).
  `discoverAvailableSubtitles` + `selectEnglishSubtitleTrack` (`lib/ytdlp/subtitles.ts`) decide
  whether a usable track exists.
- AI joins take the creator label from the host's profile name
  (`COALESCE(p.display_name, c.display_name)` in `lib/ai/scope.ts`, `lib/ai/reports.ts`,
  `lib/ai/digests.ts`). That stays correct for hidden hosts and needs only a new "Featuring" line.
- `listCreators` is the funnel for most library surfaces; `listProfiles` returns any profile with at
  least one account. The migration-024 trigger gives every new creator its own profile.
- Settings "clear cached feeds" runs `DELETE FROM videos` (`lib/videos/repository.ts:108`). Hand
  picked videos are curated data and must survive it.
- A single YouTube lookup (`yt-dlp --dump-single-json --skip-download --no-playlist`) takes about
  1.4 s and returns id, title, channel id, @handle, duration, date, thumbnails and caption
  languages.

## 3. Design

### 3.1 Concepts

- **Followed creator** (today's behaviour) vs **source-only creator**: a `creators` row with
  `followed = 0`, created by an import to satisfy the `videos.creator_id` constraint.
- **Featuring**: a video can be attributed to one or more people (`profile_videos`). An episode that
  features two researched people appears in both people's "Other videos".
- **Other videos**: the person's page tab listing the videos attributed to them, whatever channel
  hosts them.

Invariant: every video of a source-only host is attributed to at least one person. A source-only
host with no attributed videos is deleted.

### 3.2 Data model: migration `032_other_videos`

```sql
ALTER TABLE creators ADD COLUMN followed INTEGER NOT NULL DEFAULT 1 CHECK (followed IN (0, 1));

CREATE TABLE profile_videos (
  profile_id INTEGER NOT NULL REFERENCES creator_profiles (id) ON DELETE CASCADE,
  video_id   TEXT    NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  added_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (profile_id, video_id)
);
CREATE INDEX idx_profile_videos_video ON profile_videos (video_id, added_at);
```

- Existing rows keep `followed = 1`; existing Rumble-imported hosts stay visible.
- Update the table list in `tests/checks/clean-db-migration.test.ts`.
- The `creators_default_profile` trigger still gives a hidden host a profile row. Keeping that
  invariant ("every account has a profile") is cheaper than special-casing it; visibility is handled
  at read time (section 3.3).

### 3.3 Visibility rules

Implementation: `listCreators(db)` returns **followed creators only**; a new `listAllCreators(db)`
returns everything. `listProfiles` / `getProfile` build from followed accounts, so a hidden host's
profile is invisible everywhere profiles are listed. `findDuplicateCreator` keeps searching **all**
rows so hosts are de-duplicated and an already-followed channel is reused.

| Surface                                                         | Source-only host                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Library grid, category filters, platform filter                 | Hidden (comes from `listProfileSummaries`)                                      |
| Refresh All, per-person refresh, picker refresh                 | Excluded (built from visible profile accounts)                                  |
| Link suggestions, "Link existing creator", Add-dialog people    | Hidden (`listProfiles`); `targetProfileExists` also requires a followed account |
| Creator search "Added" badge (`lib/creators/search/service.ts`) | Not counted as saved                                                            |
| `GET /api/creators`                                             | Hidden by default                                                               |
| `/creators/[id]` for a hidden profile, `/channels/[id]`         | 404                                                                             |
| Video detail `/channels/[hostId]/videos/[id]`                   | Works; back link goes to the featured person's Other videos                     |
| Feed, picker, citations, reports                                | Show the featured person, with "on {host}" (section 3.7)                        |
| Settings cache clearing                                         | Spares attributed videos (section 3.8)                                          |
| X dashboard, research lists                                     | Unaffected (X only)                                                             |

Adding a channel normally (`addCreator` on a duplicate that is hidden) flips `followed` to 1 and
reports `created`, so the UI says "Added", not "already in your library".

### 3.4 Import engine (`lib/videos/import/`)

**`links.ts`** (pure, client-safe)

- `parseVideoLink(raw)` returns `{ platform: "youtube", videoId }`, `{ platform: "rumble", slug }`,
  or a typed rejection. YouTube forms: `watch?v=`, `youtu.be/`, `shorts/`, `live/`, `embed/`, `/v/`
  on `youtube.com`, `www.`, `m.`. IDs match `[A-Za-z0-9_-]{11}`. Strict HTTPS, no credentials, same
  philosophy as `creator-url.ts` and `rumble/urls.ts`. Canonical URL is
  `https://www.youtube.com/watch?v=<id>`; `list=`, `t=` and tracking params are dropped.
  Rumble reuses `parseRumbleUrl` (video target).
- `extractVideoLinks(text)` splits a pasted blob (lines, spaces, surrounding prose), de-duplicates by
  canonical id and caps a paste at 30 links.
- `looksLikeVideoLink(input)` lets the Add dialog route a pasted link.

**`resolve.ts`**: `resolveVideoLink(link, deps)` runs two yt-dlp jobs in parallel:

1. Metadata: `--dump-single-json --skip-download --no-playlist --no-warnings --no-progress`
   (YouTube; Rumble keeps `runRumbleDiscovery`'s throttle retry). Parsed with the helpers in
   `lib/videos/mapper.ts` (`mapPublishedAt`, `mapDurationSeconds`, `mapLiveStatus`, stable
   thumbnail) into a `VideoDraft` plus the host identity (channel id, handle, name, channel URL).
2. Captions: `discoverAvailableSubtitles(url)` + `selectEnglishSubtitleTrack`, the exact functions
   transcripts use. This is the **gate**; it matches chat by construction. A later optimisation can
   fold it into the metadata call once measured against these results.

Outcomes: `ready { draft, host, captions: "manual" | "automatic" }`, `already_added`, or a rejection
with a stable code and plain-language message:

- `no_english_captions` ("No original English captions are available for this video.")
- `live_or_upcoming` (live or scheduled videos have no captions yet; try again after they end)
- `unsupported_site`, `invalid_link`, `unavailable_video`, `no_channel`
- retryable (not a rejection): `throttled`, `network`, `timeout`, `ytdlp_missing`

Shortcuts: if the video row exists and its transcript is cached, skip both jobs. If the row exists
without a transcript, run only the caption gate.

A process-local preview cache (canonical URL to resolved server-side result, 10 min TTL, 200 entries)
lets the commit step avoid re-fetching. On a miss the commit re-resolves. The client never supplies
video data; this keeps the pattern `saveRumbleCreatorPayload` already documents.

**`service.ts`**: `importVideos(db, { urls, profileId, followHost })`, per link and independently
(partial success is normal):

1. Find or create the host with `addCreator({ followed: false })`. A followed host is reused as-is;
   with `followHost`, set `followed = 1`.
2. `insertVideoIfMissing`: new repository function; no `last_refreshed_at` stamp, no `creator_id`
   overwrite (the Rumble stamp bug disappears with it).
3. `attachVideoToProfile(profileId, videoId)` (idempotent).

Hosts get no avatar at import (single-video metadata has none). The avatar is fetched when the user
follows the channel, using the existing channel resolvers.

### 3.5 Server actions (`app/actions/videos.ts`)

- `previewVideoLinkAction(url)`: one link in, one outcome out. The client runs a pool of 3 so rows
  fill in as they resolve and a stale batch can simply be ignored.
- `importVideosAction(urls, { profileId, followHost })`: validates ids (integers), caps the array at
  30, runs `importVideos`, then `revalidateLibraryViews()` plus `/feed` and `/chat`.
- `followCreatorAction(creatorId)` (in `creators.ts`): sets `followed = 1`, fetches the avatar best
  effort, and starts a background feed refresh through the existing `components/background` task.
- `removeVideoAction(videoId, profileId)`: removes the attribution; if the host is source-only and no
  attribution remains, deletes the video (transcript and digest cascade) and then the host. Videos
  of a followed host are never deleted by this action.

All inputs are treated as untrusted; return values are shaped for the client (no stderr, paths or
raw records), like the existing creator actions.

### 3.6 UI

**Person page: "Add videos"** (`components/creators/add-videos-dialog.tsx`), an outline button next
to "Add platform" in `creator-header.tsx`.

- Paste box (many links, any layout) leads to rows. Each row: thumbnail, title, host channel,
  duration, platform, a captions chip (human-written / auto-generated) and a status (resolving,
  ready, already in Other videos, rejected with reason, or failed with Retry).
- Rejected rows cannot be selected; ready rows are pre-ticked. Footer: "Add N videos", an off by
  default "Also follow these channels", and a one-line load hint (hours selected vs. the 25 video /
  50 hour analysis limit, via `estimateScopeLoad` and `formatVideoHours`).
- States follow `add-creator-dialog.tsx`: controls disable while a step runs, `AppDialog` busy
  handling, `useToast` on success, `router.refresh()` afterwards.

**Person page: "Other videos" tab.** `CreatorTabs` gains a tab (`?view=other`) with a count; it
appears once the person has at least one attributed video. People with a single account currently get
no tabs; with Other videos they get `Overview | <account> | Other videos`, still landing on the
account as today. The panel reuses `SelectableFeed`, so selecting several appearances and "Ask AI"
already work. Additions: a `subtitle` on `VideoCard` ("on PBD Podcast") and a **Remove** action in
selection mode (calls `removeVideoAction`). The Overview feed includes attributed videos
(`buildFeedItems(db, accounts, { featuredProfileId })`), and the Overview count includes them.

**Add creator dialog.** `classifyCreatorInput` gains `"video"`; a pasted YouTube or Rumble video
link (whatever platform tab is selected, since the link names its platform) shows a video preview
card and two choices:

- **Add to a person**: searchable list of people (reuses the profile-picker styling), with an off by
  default "Also follow {host}". When the dialog was opened with `targetProfile` ("Add platform"),
  that person is preselected and locked.
- **Follow {host} as a creator**: today's Rumble behaviour for both platforms (adds the channel and
  imports this video).

Rejections show inline next to the input. Fix the misleading copy (`PLATFORM_HINTS`, the dialog
description, and the "channel or video link" docstring in `app/actions/creators.ts`).

**Video detail page.** For a source-only host: back link goes to the featured person's Other videos;
chips for "Featuring {name}" and "on {host}"; actions **Follow {host}** and **Remove from {person}**.
`app/channels/[id]/page.tsx` returns 404 for hidden hosts.

### 3.7 AI, labelling and reports

- `lib/ai/scope.ts`: `ScopedVideo` / `ScopedSource` gain `featuring: string[]`, read with a
  `json_group_array` subquery over `profile_videos` and `creator_profiles`.
- `lib/ai/materialize.ts` (`renderTranscriptFile`): add `Featuring: Luke Belmar` when non-empty.
  `Creator:` stays the host (truthful) and `Channel:` stays "YouTube @pbdpodcast".
- Chat and report prompts: when any source lists "Featuring", add one sentence that these are
  appearances on other people's channels and that captions carry **no speaker labels**, so statements
  must not be attributed to a named person unless the transcript itself identifies the speaker.
  Locate the shared preamble from the `renderTranscriptFile` callers in `lib/ai/chat.ts` and
  `lib/ai/reports.ts`. Digests are left alone (prompt version is part of their cache key).
- `lib/ai/source-library.ts`: videos gain `featuredProfileId`, `featuredName`, `hostName`;
  `creatorId` stays the real host id (detail hrefs and the transcript API depend on it).
  `chat-source-picker.tsx` `toItems`: `groupId = featuredProfileId ?? groupIdOf(...)`, name from the
  featured person, card subtitle "on {host}". The picker already degrades gracefully for creators
  missing from its list.
- Labelling rule (feed, picker, citations): a video with attributions is labelled with its **first
  attached person** plus "on {host}". It appears once, under that person, not duplicated under a
  followed host's group. It still appears in every featured person's Other videos tab and in the
  host's own account tab.
- Feed (`lib/feed/items.ts`, `components/feed/feed-stream.tsx`): `creatorId` stays the real host id
  for the detail and transcript URLs; `accountHref` (`feed-stream.tsx:1034-1037`) points to the
  featured person's `?view=other` view instead of the (hidden) host's account tab.
- Citations: `ChatSource` gains optional `channelName`; the preview card shows "on {channel}".
  `ChatSource` producers to update include `app/chat/chat-view.tsx`,
  `components/channel/selectable-feed.tsx` and `lib/ai/thread-sources.ts`; find any others with a
  search for `ChatSource` when implementing.
- Reports: `describeReportPeople` ignores source-only accounts and accepts an extra
  `profileId to count` map so a report built from appearances lists the featured people, not the
  hosts. `getReportVideosByIds` carries `featuredNames` and `channelName` onto `ReportSource`.

### 3.8 Maintenance guard

- `clearAllCachedFeeds` deletes only videos **not** in `profile_videos`, then source-only hosts left
  with no videos. Attributed videos keep their transcripts.
- `getCacheCounts` / `countAllVideos` (the confirmation dialog) count only deletable videos, and the
  Settings copy states how many hand-picked videos are kept. "Clear transcript cache" is unchanged:
  transcripts are re-fetched on demand.
- After a **person is removed**, run `pruneSourceOnlyHosts(db)`: delete source-only hosts with no
  attributed videos (their videos cascade), as `deleteOrphanTweets` does for posts.

### 3.9 Rumble alignment

`saveRumbleCreatorPayload`'s video branch, `addCreatorFromUrl`'s Rumble video branch, and
`resolveCreatorFromAnyUrl` move onto the engine ("Follow {host}" path with the video imported). Rumble
video links therefore also get the caption gate and lose the false refresh stamp.
`importRumbleVideo` and its tests are reworked rather than left as a second code path; the reusable
parsing (`parseRumbleVideoPayload`, `pickRumbleThumbnail`, `runRumbleDiscovery`) stays, with
platform-neutral error wording.

## 4. Build order

Read the relevant guide in `node_modules/next/dist/docs/` before touching server actions, route
handlers or page `searchParams` (per `AGENTS.md`). Baseline first: `npm run typecheck`,
`npm run lint`, `npm test` green.

### Phase 1: core (YouTube and Rumble)

Phase 1 is executed as four slices, each runnable on its own in a fresh session. The slice files in
[`other-videos-slices/`](other-videos-slices/README.md) are authoritative for **order and scope**;
this document stays the design reference. The slices re-order the steps below in two ways:

- The maintenance guard (step 9) moves into slice 1, so no UI can create hand-picked videos before
  "clear cached feeds" is made safe.
- The feed, picker and video-page label and link fixes (part of step 8) move into slice 3, so the
  first usable slice has no dead links. Slice 4 keeps the Add dialog branch, "Follow channel",
  citations, Rumble alignment and the final pass.

| Slice | Steps             | Outcome                                                                                         |
| ----- | ----------------- | ----------------------------------------------------------------------------------------------- |
| 1     | 1, 2, 9           | Foundation: hidden hosts, attribution table, cache-clearing guard; invisible                    |
| 2     | 3, 4, 5           | Engine: link parsing, resolve + caption gate, import service and actions; no UI                 |
| 3     | 6, 7, part of 8   | First usable: AI labelling, "Add videos" dialog, "Other videos" tab, correct feed/picker labels |
| 4     | rest of 8, 10, 11 | Add dialog branch, Follow channel, citations, Rumble alignment, final pass                      |

1. **Migration and primitives.** Migration 032; `followed` on `CreatorRecord`; `listCreators`
   (followed) / `listAllCreators`; `addCreator` accepts `followed` and flips a hidden duplicate;
   `insertVideoIfMissing`; `profile_videos` CRUD and `pruneSourceOnlyHosts` in
   `lib/videos/attribution.ts`. Tests: repository + clean-db migration list.
2. **Visibility pass.** Apply section 3.3 across `profiles.ts`, `profile-service.ts`,
   `search/service.ts`, `app/api/creators/route.ts`, `source-library.ts`, 404s. Test that a hidden
   host never appears in: profile list, link suggestions, search "Added", source-library creators,
   refresh targets, `/api/creators`.
3. **Links.** `links.ts` with a table-driven test (all YouTube forms, tracking params, playlists
   ignored, http, credentials, look-alike hosts, prose around links, dedupe, cap).
4. **Resolve and gate.** `resolve.ts`, error classes, platform-neutral wording. Fixtures under
   `tests/fixtures/` (human captions, auto captions only, translated-only, none, live, members-only,
   no channel id) and fake yt-dlp support in `tests/integration/fake-yt-dlp.cjs` and
   `tests/e2e/fake-yt-dlp.cjs`. Test that the gate verdict equals `discoverAvailableSubtitles` +
   `selectEnglishSubtitleTrack` for every fixture.
5. **Import service and actions.** `service.ts`, preview cache, `app/actions/videos.ts`,
   `followCreatorAction`, `removeVideoAction`. Tests: reuse of a followed host, no `creator_id`
   overwrite, no refresh stamp, idempotent re-import, partial success, cache hit vs. miss, removal and
   host cleanup, person removal prune.
6. **AI side.** Section 3.7: `scope.ts`, `materialize.ts`, prompt sentence, report people,
   `source-library.ts`. Extend `ai-scope`, `ai-materialize-sources`, `ai-report-sources` and
   `ai-sources-route` tests.
7. **Person page UI.** `AddVideosDialog`, header button, `CreatorTabs` tab, Other videos panel,
   `SelectableFeed` remove action, `VideoCard` subtitle, Overview feed. Component tests alongside
   `add-creator-dialog.test.tsx` and `selectable-feed.test.tsx`.
8. **Add dialog, detail page, labels.** Video branch in `add-creator-dialog.tsx`, detail page and
   follow action, picker, feed, citation labels.
9. **Maintenance guard** (section 3.8) and Settings copy; extend `cache-maintenance.test.ts`.
10. **Rumble alignment** (section 3.9) and removal of the old path; README paragraph on Other videos.
11. **Browser verification** (section 5).

Done when the section 5 checklist passes and typecheck, lint, `npm test`, `npm run check:migration`
and the hermetic e2e (`npm run test:e2e`) are green.

### Phase 2: more sites

A host allowlist in `links.ts` (for example Vimeo, X video, Odysee, Twitch VODs), driven by yt-dlp
extractor coverage, with no generic-page fallback. Namespaced video ids (`vimeo_123456789`) and
widening the `^[A-Za-z0-9_-]{6,20}$` check in the video detail route and the transcript API route.
The caption gate already rejects audio-only hosts without captions.

### Phase 3: paste in the source picker

A "Paste links" box in the AI Chat and Reports picker that previews, imports (attributing to the
chosen person) and auto-ticks the new videos, within the existing 25 video / 50 hour limits.

## 5. Verification

Unit and component tests are listed per step. Browser testing follows `AGENTS.md` using a snapshot of
the real library (never the live DB): `sqlite3 -readonly <db> ".backup <scratch>/localtube.db"`, then
`SCOPE_DB_PATH=<copy> SCOPE_AI_JOBS_ROOT=<scratch>/ai-jobs npx next dev -H 127.0.0.1 -p 3123`, driven
with `agent-browser`. Public YouTube metadata lookups are fine; X is not reachable from plain
`next dev`.

Scenarios:

1. Paste a mixed blob on a person: two YouTube videos, one Rumble, one without English captions, one
   unsupported site, one duplicate. Check row statuses and messages, that rejected rows are not
   selectable, and that "Add N" adds exactly the ready ones.
2. The Other videos tab appears with counts; Overview includes the videos; a single-account person
   gets the new tabs and still lands on the account.
3. The library grid, category counts and Refresh All scope are **unchanged** after importing.
4. Select two videos and Ask AI. Citations read "{person} on {host}". With the user's OK, one cheap
   real turn (a short video with a cached transcript) to confirm the `Featuring:` header and the
   no-speaker-labels behaviour.
5. Follow a host: it appears in the library once, with no duplicate when added again from search.
6. Remove a video, then the last video of a host: the host disappears. Remove a person: their
   source-only hosts are pruned.
7. Settings "clear cached feeds" keeps Other videos and reports the kept count.
8. Add dialog: video link from the library header, and from "Add platform" with the person locked.
9. Phone width, dark mode, keyboard-only through the dialog, no console errors.

## 6. Risks and open details

- **"Attach to nobody" is dropped from v1.** Keeping it needs a marker to tell deliberate loose
  imports from orphaned hosts, plus a place to manage them (Feed rows). If wanted, add a
  `videos.kept` flag or a generalised "collection" (which `profile_videos` could grow into).
- **Label ownership.** A video attributed to a person is listed under them in the picker even when
  its host is followed (no duplicate groups or double selection state). The alternative is to list it
  in both groups and dedupe selection by video id.
- **First attribution wins for labels.** With several featured people the picker and feed use the
  first; each person's tab shows it.
- **People need an account.** The profile-pruning trigger means a person with no accounts cannot
  exist, so someone with no channels of their own cannot be researched yet. Follow-up: "Create a
  person from this video".
- **Throttling on bulk pastes.** Mitigated by a pool of 3, one paced retry (existing helpers), a per
  row Retry and the 30 link cap. Two yt-dlp jobs per link means up to 6 processes at once.
- **English captions only.** Videos with only non-English or translated captions are rejected,
  consistent with the transcript pipeline. Auto-caption quality is not assessed.
- **Speaker attribution.** Captions have no speaker labels; the `Featuring:` line and the prompt
  caveat reduce, but do not remove, the risk of crediting a statement to the wrong speaker.
- **Existing X status-link import** still creates a visible author creator; unchanged and out of
  scope.
- **Migration on user databases.** The desktop app upgrades its database in place; the new column has
  a safe default and the new table is empty, so nothing is rewritten.

## 7. Out of scope

Speech-to-text, Spotify, speaker diarisation, automatic discovery of someone's appearances, playlist
and channel-page import, unfollowing a channel back to source-only, and person-less collections.
