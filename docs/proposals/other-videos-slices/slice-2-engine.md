# Slice 2: Import engine

Design: [`../other-videos-import.md`](../other-videos-import.md) sections 3.4 and 3.5 (plan steps 3, 4
and 5). Server-side only; no UI.

**Prerequisites:** slice 1 done. Check: `grep -n '"032"' lib/db/migrations.ts` matches,
`lib/videos/attribution.ts` exists, `npm test` is green.

## Scope

In: link parsing, resolving a link to a previewable video with the English-caption gate, the import
service, the preview cache, and the server actions the dialogs will call.

Not in: any component, any change to Rumble's existing creator-add path (slice 4), AI changes,
`followCreatorAction` (slice 4), `removeVideosAction` (slice 3).

## Work items

### 1. Link parsing: `lib/videos/import/links.ts`

Pure and **client-safe** (no `server-only` imports, no `node:` modules; `lib/rumble/urls.ts` is pure
and may be imported).

- `type VideoLink = { platform: "youtube"; id: string; url: string } | { platform: "rumble"; slug: string; url: string }`
  where `url` is canonical: `https://www.youtube.com/watch?v=<id>` or `https://rumble.com/<slug>`.
- `parseVideoLink(raw): { ok: true; link } | { ok: false; code; message }`, codes `invalid_link` |
  `unsupported_site`. Accepts YouTube `watch?v=`, `youtu.be/`, `shorts/`, `live/`, `embed/`, `/v/` on
  `youtube.com`, `www.youtube.com`, `m.youtube.com` and `youtu.be`; ids match `[A-Za-z0-9_-]{11}`.
  Drops `list=`, `t=`, `si=` and tracking params. Rumble reuses `parseRumbleUrl` (video targets only).
  HTTPS only, no credentials. A channel, playlist or home link gets a specific message ("That is a
  channel link; add it with Add creator."), anything else `unsupported_site`
  ("scope can import YouTube and Rumble video links for now.").
- `extractVideoLinks(text, { max = 30 })`: finds URLs in a pasted blob (one per line, separated by
  spaces or commas, surrounded by prose), de-duplicates by canonical URL, caps at `max`, and returns
  `{ links, rejected: Array<{ raw, code, message }>, truncated }`.
- `looksLikeVideoLink(input): boolean` for the Add dialog (slice 4): true only for a parseable
  YouTube or Rumble **video** link.

### 2. Errors: `lib/videos/import/errors.ts`

`VideoImportErrorCode` = `invalid_link | unsupported_site | unavailable_video | live_or_upcoming |
no_english_captions | no_channel | unexpected_response | invalid_input` (rejections) and
`throttled | network | timeout | ytdlp_missing` (retryable). Each error is
`{ code, message, retryable }`. `classifyVideoJobFailure(result, platformLabel)` maps a failed
`ExecFileResult` (reuse the stderr patterns in `lib/transcripts/service.ts`
`classifyCommandFailure` and `lib/rumble/video-import.ts` `classifyDiscoveryFailure`, with a
platform name in the wording instead of "Rumble"). Messages are plain language and never contain
stderr or paths. `no_english_captions`: "No original English captions are available for this video.
scope currently supports English only."

### 3. Resolve: `lib/videos/import/resolve.ts`

`resolveVideoLink(db, link, deps?)` with injectable `deps: { command, run, discover, throttleRetryMs }`
defaulting to `YT_DLP_COMMAND`, `runCommand`, `discoverAvailableSubtitles`.

1. **Already-known shortcut.** Look the id up in `videos` (left join `transcripts`). If it has a
   cached transcript, skip both yt-dlp jobs and return a `ResolvedVideo` built from the row
   (`inLibrary` set). If the row exists without a transcript, run only the caption gate.
2. **Two jobs in parallel (`Promise.all`)**:
   - Metadata: new `buildVideoMetadataArgs(url)` = `["--dump-single-json", "--skip-download",
"--no-playlist", "--ignore-config", "--no-warnings", "--no-progress", url]`, run through
     `runJobWithThrottleRetry` (exported from `lib/ytdlp/subtitles.ts`), 45 s timeout, 8 MiB output.
     YouTube payload to `VideoDraft` with `mapPublishedAt`, `mapDurationSeconds`, `mapLiveStatus`,
     `stableThumbnailUrl` / `pickThumbnailUrl` from `lib/videos/mapper.ts`; title ≤ 300, description ≤
     5000 (as the Rumble importer does). Host identity: `channel_id` must match `^UC[0-9A-Za-z_-]{22}$`
     (else `no_channel`), `displayName` from `channel` ?? `uploader`, handle from `uploader_id`
     (`@name` to lowercase, kept only if `^[0-9a-z._-]{3,30}$`), `channelUrl`
     `https://www.youtube.com/channel/<id>`. Rumble: reuse `parseRumbleVideoPayload` and
     `runRumbleDiscovery`; host handle from `channelSlugFromUrl` (re-implement the 3-line
     `normalizeHandle`, or export the existing one).
   - Captions: `discoverAvailableSubtitles(link.url)` then `selectEnglishSubtitleTrack`. This is the
     **gate**, the same functions chat uses, so the verdict cannot drift from reality.
3. **Verdict order:** metadata failure (unavailable, throttled, ...) wins over a caption verdict;
   then `is_live` / `upcoming` gives `live_or_upcoming` ("Live and scheduled videos have no captions
   yet. Import it after it ends."); then no English track gives `no_english_captions`.
4. Success: `ResolvedVideo = { platform, videoId, url, draft, host: { platform, youtubeChannelId,
handle, displayName, channelUrl }, captions: "manual" | "automatic", inLibrary: { creatorId,
hasTranscript } | null }`. A discriminated `{ ok: true, video } | { ok: false, error }` result.

### 4. Pool and preview cache

- `lib/videos/import/pool.ts`: `mapWithConcurrency(items, limit, fn)` preserving order.
- `lib/videos/import/preview-cache.ts`: process-local `Map` keyed by canonical URL; stores only
  successful `ResolvedVideo`s (server-side data, never sent back by the client); TTL 10 minutes, max
  200 entries (evict oldest); test seam `resetPreviewCacheForTests()`.

### 5. Import service: `lib/videos/import/service.ts`

`importVideos(db, { urls, profileId, followHost }, deps?) => Promise<{ results: ImportRowResult[] }>`.

- Input rules: `urls` parsed with `parseVideoLink`, de-duplicated, capped at 30. `profileId` is a
  visible person (use `profilesExist`) or `null`. **`profileId === null` requires `followHost: true`**
  (invariant: a source-only host must have an attribution), otherwise every row fails `invalid_input`.
- Resolution: preview cache first, else `resolveVideoLink`, at most 3 at a time via
  `mapWithConcurrency`. Rejected rows are returned as rejected; nothing is written for them.
- Commit per row inside one `db.transaction`: find or create the host with `addCreator({ ...host,
avatarUrl: null, followed: followHost })` (an existing followed host is reused untouched; a hidden
  host plus `followHost` is flipped to followed), `insertVideoIfMissing`, then `attachVideoToProfile`
  when `profileId` is set.
- `ImportRowResult` = `{ url, status: "added" | "attached_existing" | "already_attached" |
"rejected", videoId?, title?, hostName?, error? }`. `added`: the video row was new;
  `attached_existing`: it already existed and is now attached; `already_attached`: nothing to do.
  Rows never throw; one failure never blocks the others.
- Hosts get no avatar here (slice 4's follow path fetches it).

### 6. Server actions: `app/actions/videos.ts` (`"use server"`)

- `previewVideoLinkAction(url: unknown, profileId?: unknown)`: validate (string, ≤ 2000 chars,
  optional positive integer). Returns `{ ok: true, preview } | { ok: false, code, message, retryable }`
  where `preview` = `{ url, videoId, platform, title, thumbnailUrl, durationSeconds, publishedAt,
liveStatus, hostName, hostHandle, hostPlatform, captions, alreadyInLibrary, alreadyAttached }`.
  Client-safe only: no raw rows, stderr, paths or the full draft.
- `importVideosAction(urls: unknown, options: unknown)`: validate (array of ≤ 30 strings;
  `{ profileId: number | null; followHost: boolean }`), call `importVideos`, then
  `revalidateLibraryViews()` and revalidate `/feed` and `/chat`. Catch unexpected errors and return a
  generic message like the existing creator actions.
- Shared revalidation: `revalidateLibraryViews` is private to `app/actions/creators.ts` and that file
  may only export async functions. Move it to a new plain module (e.g.
  `app/actions/revalidate-library.ts`, no `"use server"`), import it from both, and add the extra
  paths there.

## Fixtures and tests

- Fixtures in `tests/fixtures/`: `youtube-video-captions.fixture.json` (derived from a real
  `--dump-single-json` of a short public video: id, title, channel fields, thumbnails, duration,
  `subtitles`, `automatic_captions`), plus variants without a channel id and with `live_status:
"is_live"` / `"is_upcoming"`, and compact discovery payloads in the real shape
  (`{"id":"…","subtitles":"en,de","automatic_captions":"en-orig"}`) for: human English, original auto
  English only, translated-only (for example `"fr"`), none, and unusable JSON.
- A test helper `fakeRunner({ metadata, discovery })` that picks the response from the argument array
  (`--dump-single-json` vs `--print`), as `tests/unit/rumble-video-import.test.ts` injects `run`.
- `tests/unit/video-links.test.ts` (table driven): every YouTube form; tracking params dropped;
  `list=` ignored; playlist/channel/home links rejected with the right message; http, credentials,
  look-alike hosts (`youtube.com.evil.test`); Rumble video accepted, Rumble channel rejected for this
  flow; prose around links; commas and newlines; duplicates collapse; the 30 cap and `truncated`.
- `tests/unit/video-resolve.test.ts`: argv assertions (`--no-playlist`, `--dump-single-json`,
  `--skip-download`, URL last, no `--write-subs`); the verdict matrix above; metadata failure beats
  caption verdict; throttle retry once; known-video shortcuts (cached transcript, no transcript);
  `no_channel`; the gate's verdict equals `selectEnglishSubtitleTrack(discoverAvailableSubtitles(...))`
  for every discovery fixture.
- `tests/unit/video-import.test.ts`: reuse of a followed host (not hidden, not duplicated);
  `creator_id` and `last_refreshed_at` untouched for an existing video; idempotent re-import
  (`already_attached`); `attached_existing`; `followHost` flips a hidden host; `profileId: null`
  without `followHost` is rejected; partial success; a rejected row writes nothing; invisible profile
  id rejected; preview-cache hit versus miss.
- `tests/unit/video-actions.test.ts`: input validation of both actions and the client-safe shape (keep
  the actions thin; follow the mocking style of `tests/unit/background-route.test.ts`).
- Opt-in live test `tests/integration/video-import-live.test.ts`, skipped unless
  `SCOPE_LIVE_VIDEO_IMPORT=1` (pattern: `tests/integration/transcript-live.test.ts`). Positive case:
  `https://www.youtube.com/watch?v=jNQXAC9IVRw` (human English captions) resolves `ready` with
  `captions: "manual"` and a UC channel id. Add a negative case only with a public video you have
  verified has no English captions (`yt-dlp --list-subs <url>`).

## Acceptance

- [ ] `npm run typecheck && npm run lint && npm test && npm run check:migration` pass.
- [ ] `SCOPE_LIVE_VIDEO_IMPORT=1 npx vitest run tests/integration/video-import-live.test.ts` passes
      (public network, no quota spent).
- [ ] Existing Rumble tests (`rumble-video-import`, `creator-rumble-resolver`) still pass unchanged:
      the old Rumble path is untouched in this slice.
- [ ] No imports of server-only modules from `lib/videos/import/links.ts` (a client component can
      import it); verify with a small component-level import in a test or a `next build`.
- [ ] Optional smoke on a DB copy: from a scratch script or test, run `importVideos` for two real
      public videos into a person and confirm rows in `videos`, `creators` (`followed = 0`) and
      `profile_videos`; the library UI is unchanged (hosts hidden).

## Hand-off to slice 3

Slice 3 calls `previewVideoLinkAction`, `importVideosAction`, `extractVideoLinks`, and reads
`listProfileVideos` / `countProfileVideos` / `listFeaturedProfiles` from slice 1. Record the exact
preview shape in the README slice log if it changed.
