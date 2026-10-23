# Slice 1: Foundation

Design: [`../other-videos-import.md`](../other-videos-import.md) sections 3.1 to 3.3 and 3.8 (plan
steps 1, 2 and 9). Nothing visible changes in this slice.

**Why first:** it adds the data model and makes the app safe for hidden hosts and hand-picked videos
_before_ any code can create them. In particular, "clear cached feeds" (`DELETE FROM videos`) must
not be able to delete attributed videos by the time slice 3 lets users import them.

**Prerequisites:** none (clean baseline).

## Scope

In: migration 032, `followed` on creators, hidden-host filtering, `profile_videos` and attribution
helpers, `insertVideoIfMissing`, host pruning, cache-clearing guard and Settings copy.

Not in: link parsing, yt-dlp calls, server actions for importing, any new UI, AI changes.

## Work items

### 1. Migration `032_other_videos`

Append to `ALL_MIGRATIONS` in `lib/db/migrations.ts` (after the `031` entry):

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

Add `profile_videos` to the expected table list in `tests/checks/clean-db-migration.test.ts` and
confirm `npm run check:migration` passes.

### 2. Creator repository (`lib/creators/repository.ts`, `lib/creators/index.ts`)

- `CreatorRecord.followed: boolean`; add `followed` to `CREATOR_SELECT`, `CreatorRow` and `toRecord`
  (`Number(row.followed) === 1`). `NewCreatorInput.followed?: boolean` (default `true`) and include
  it in the `INSERT`. Typecheck will flag test helpers that build `CreatorRecord` literals; fix them.
- `listCreators(db)` returns **followed creators only** (`WHERE followed = 1`). New
  `listAllCreators(db)` returns every row. Export both from `lib/creators/index.ts`.
- `findDuplicateCreator` is unchanged: it searches **all** rows, so hosts are de-duplicated and an
  already-followed channel is reused.
- `addCreator`: when a duplicate exists, is hidden (`followed = 0`) and the input wants `followed`
  (the default), set it to followed and return `{ status: "created", creator }` (so the UI says
  "Added", not "already in your library"). When the input has `followed: false` and a duplicate
  exists, return `already_saved` without changing it. Apply the same rule in the unique-constraint
  race branch.
- New `setCreatorFollowed(db, id, followed)`.

### 3. Profiles and pages

- `lib/creators/profiles.ts`: `listProfiles` and `getProfile` already read through `listCreators`, so
  hidden hosts' profiles vanish; add a comment saying so. `profilesExist` must count only profiles
  that have a **followed** account (so `targetProfileExists` and `linkProfilesFromInput` reject a
  hidden profile id). Check `listAccountProfileRefs`, `listProfileLinkSuggestions` and
  `lib/categories/repository.ts` (the two `FROM creators cr` queries) still behave; expect no code
  change there, but cover it with tests.
- `app/creators/[id]/page.tsx`: today an unknown profile with `?account=<id>` redirects to the
  account's owner. For a hidden host that owner is the same hidden profile, which would **redirect
  to itself forever**. Extract the decision into a pure `resolveCreatorPageTarget(db, profileId,
requestedAccountId)` returning `show | redirect(profileId, accountId) | notFound`, redirect only to
  a **visible** profile that differs from the requested one, and unit test it.
- `app/channels/[id]/page.tsx`: `notFound()` when the creator is not followed.
- `lib/creators/search/service.ts`, `app/api/creators/route.ts`, `lib/ai/source-library.ts`
  (`creators`) and the X dashboard readers use `listCreators`, so they hide source-only hosts
  automatically. Do not switch any of them to `listAllCreators`.

### 4. Attribution and host lifecycle (`lib/videos/attribution.ts`, new)

- `attachVideoToProfile(db, profileId, videoId): boolean` (`INSERT OR IGNORE`; true if newly added).
- `detachVideoFromProfile(db, profileId, videoId): boolean`.
- `listVideoProfileIds(db, videoId): number[]` ordered by `added_at`, then profile id (the first is
  the label owner).
- `listFeaturedProfiles(db, videoIds): Map<string, Array<{ profileId: number; displayName: string }>>`
  (chunked `IN` queries, 500 per chunk like `lib/transcripts/prepare.ts`), used by later slices.
- `listProfileVideos(db, profileId)` and `countProfileVideos(db, profileId)`: attributed videos with
  the host's creator id, name and platform, newest published first (undated first, matching the
  other cached reads). Used by slice 3.
- `pruneSourceOnlyHosts(db): number`: delete creators with `followed = 0` that have no attributed
  video; their videos cascade and the profile trigger removes their profile.
- `removeAttributedVideo(db, profileId, videoId): { removedVideo: boolean; removedHost: boolean }`:
  detach; if no attribution remains **and** the host is source-only, delete the video (transcript and
  digest cascade); then prune. A video of a followed host is never deleted by this function.

### 5. Videos repository (`lib/videos/repository.ts`)

- `insertVideoIfMissing(db, creatorId, draft: VideoDraft): boolean`: `INSERT ... ON CONFLICT (id)
DO NOTHING`. It must **not** overwrite `creator_id` and must **not** touch `last_refreshed_at`
  (contrast with `mergeCreatorFeed`, line ~239).
- `clearAllCachedFeeds`: delete only videos whose id is **not** in `profile_videos`; keep resetting
  `creators.last_refreshed_at`; then `pruneSourceOnlyHosts`. Return the number of videos deleted.
- Counts: `countAllVideos` stays the total; add `countClearableVideos` (not attributed) and
  `countAttributedVideos`.

### 6. Hooks into removal

Call `pruneSourceOnlyHosts(db)` after the deletes in `removeProfileById`
(`lib/creators/profile-service.ts`) and `removeCreatorById` (`lib/creators/service.ts`), next to the
existing `deleteOrphanTweets`.

### 7. Settings

- `lib/maintenance/service.ts`: `CacheCounts.cachedVideos` becomes the **clearable** count and gains
  `keptVideos` (attributed). `app/settings/page.tsx` and `app/settings/settings-form.tsx` pass and
  show it: the "Clear all cached feed metadata?" dialog (settings-form.tsx ~line 391) adds "N videos
  you added to Other videos are kept." when `keptVideos > 0`; the "Nothing to clear" message still
  applies when `cachedVideos` is 0.

## Tests

- `tests/unit/creator-repository.test.ts`: `followed` default; `listCreators` vs `listAllCreators`;
  hidden host de-duplicates; adding a hidden duplicate flips it (`created`); `followed: false` on an
  existing followed channel changes nothing; `setCreatorFollowed`.
- `tests/unit/creator-profiles.test.ts`: a hidden host's profile is absent from `listProfiles`,
  `getProfile`, `listProfileSummaries`, `listProfileLinkSuggestions`, `listAccountProfileRefs`;
  `profilesExist` is false for it; `linkProfilesFromInput` rejects it; `resolveCreatorPageTarget`
  never redirects to itself or to a hidden profile.
- New `tests/unit/video-attribution.test.ts`: attach/detach are idempotent; ordering of
  `listVideoProfileIds`; `listFeaturedProfiles`; `removeAttributedVideo` for a hidden host (video and
  host removed when last attribution goes) and a followed host (video kept); `pruneSourceOnlyHosts`;
  removing a person's last account prunes their source-only hosts; deleting a video cascades its
  attributions.
- `tests/unit/video-repository.test.ts`: `insertVideoIfMissing` keeps `creator_id` and
  `last_refreshed_at`; `clearAllCachedFeeds` spares attributed videos and returns the right count.
- `tests/unit/cache-maintenance.test.ts`: `keptVideos` and the clearable count; hosts survive while
  their attributed videos do.
- `tests/unit/creator-search.test.ts`: a hidden host is not marked "saved" in search results.
- A small route test that `GET /api/creators` omits hidden hosts.

## Acceptance

- [ ] `npm run typecheck && npm run lint && npm test && npm run check:migration` pass.
- [ ] Browser check on a **copy** of the real library (see README), seeded with the SQL below.
- [ ] Library grid, counts, category filters and Refresh All scope are identical to before.
- [ ] `/creators/<hidden profile id>` and `/channels/<hidden creator id>` return the not-found page
      (no redirect loop); `GET /api/creators` omits the host.
- [ ] Settings → clear cached feed metadata: the dialog counts exclude the seeded video and say it is
      kept; after clearing, the seeded video and host still exist in the database.
- [ ] Removing the seeded video's person (or its last account) also removes the hidden host.
- [ ] No console errors on the pages above.

Seed for the browser check: one hidden host with a video attributed to an existing visible person.
Replace `<visible profile id>` with a real `creator_profiles.id` from the copy, then run it with
`sqlite3 <copy>`.

```sql
INSERT INTO creators (youtube_channel_id, handle, display_name, channel_url, platform, followed)
  VALUES ('UCAAAAAAAAAAAAAAAAAAAAAA', 'hiddenhost', 'Hidden Host',
          'https://www.youtube.com/channel/UCAAAAAAAAAAAAAAAAAAAAAA', 'youtube', 0);
INSERT INTO videos (id, creator_id, title, url, live_status)
  VALUES ('hiddenVid01', (SELECT id FROM creators WHERE handle = 'hiddenhost'),
          'Seeded appearance', 'https://www.youtube.com/watch?v=hiddenVid01', 'not_live');
INSERT INTO profile_videos (profile_id, video_id) VALUES (<visible profile id>, 'hiddenVid01');
```

## Hand-off to slice 2

Slice 2 relies on: `addCreator({ followed })`, `insertVideoIfMissing`, `attachVideoToProfile`,
`profilesExist` (followed-only), and `listCreators` / `listAllCreators`. Record any signature changes
in the README slice log.
