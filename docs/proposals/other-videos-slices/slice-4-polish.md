# Slice 4: Add dialog, Follow channel, citations, Rumble, final pass

Design: [`../other-videos-import.md`](../other-videos-import.md) sections 3.6 (Add dialog, video
page), 3.7 (citations) and 3.9 (plan steps 8 remainder, 10 and 11).

**Prerequisites:** slices 1 to 3 done. Check: `components/creators/add-videos-dialog.tsx`,
`app/creators/[id]/other-videos-panel.tsx` and `removeVideosAction` exist; `npm test` is green.

## Scope

In: the video branch of the Add creator dialog, "Follow channel" and "Remove" on the video page,
citation channel names, moving Rumble video links onto the engine, README docs, and the full
verification pass of phase 1.

Not in: other sites (phase 2), pasting links in the source picker (phase 3).

## Work items

### 1. Follow channel (service + action)

- `lib/creators/service.ts` `followCreator(db, creatorId)`: only for a source-only host; set
  `followed = 1` (`setCreatorFollowed`); best-effort avatar (YouTube: `resolveCreatorFromUrl`
  (`lib/creators/resolver.ts`) on the channel URL; Rumble: `fetchRumbleChannelIdentity`); a failed
  avatar lookup never fails the follow. Add `setCreatorAvatar(db, id, avatarUrl)` to the repository
  (none exists yet; validate with `isAllowedImageUrl`). Returns the creator summary with `profileId`.
- `followCreatorAction(creatorId)` in `app/actions/creators.ts`: validate the id, call the service,
  `revalidateLibraryViews()` (slice 2's shared module). The client then starts the feed refresh through
  the existing background operation (`components/background/creator-refresh.ts` /
  `operations.ts`) so the new channel fills in; the toast links to `/creators/<profileId>`.

### 2. Video page actions

`app/channels/[id]/videos/[videoId]/page.tsx` (+ a small client component for the buttons) for a
source-only host: **Follow {host}** (uses 1) and **Remove from {person}** (uses
`removeVideosAction`; confirm dialog; on success navigate to the person's Other videos). Hide both for
videos of followed hosts.

### 3. Add creator dialog: video branch (`components/library/add-creator-dialog.tsx`)

- `classifyCreatorInput` (`lib/creators/search/model.ts`) returns `"video"` when `looksLikeVideoLink`
  (slice 2) is true; it takes precedence over `"link"` and ignores the selected platform tab (the link
  names its platform). X status links and channel links behave as today.
- A video link calls `previewVideoLinkAction` and shows the same preview row as the Add videos dialog
  (extract it to a shared component if slice 3 did not). Two choices:
  - **Add to a person:** searchable list of people (`listProfilesAction`, reuse the avatar and
    list styling of `components/creators/profile-target-picker.tsx`), with the off-by-default "Also
    follow {host}". When the dialog has a `targetProfile` ("Add platform"), that person is preselected
    and locked. Button: "Add video to {person}". Calls `importVideosAction([url], { profileId,
followHost })`.
  - **Follow {host} as a creator:** `importVideosAction([url], { profileId: null, followHost: true })`
    then the avatar step from item 1 (use the service, not a second action), then the usual "Added"
    flow (categories picker works as today). This is today's Rumble behaviour, now for YouTube too.
- Rejections (no English captions, live, unsupported, unavailable) show inline next to the input,
  with `YtDlpSetupNote` for `ytdlp_missing` as elsewhere in the dialog.
- Copy: update `PLATFORM_HINTS`, `PLATFORM_PLACEHOLDERS`, the dialog description ("Rumble video links
  and X post links also import that one item" becomes "Paste a YouTube or Rumble video link to add
  just that video to someone"), the `resolveCreatorAction` docstring in `app/actions/creators.ts`, and
  the empty state in `components/library/library-empty-state.tsx`. Leave the YouTube channel parser's
  video-link messages (`lib/validation/creator-url.ts`) for API callers of `POST /api/creators`.

### 4. Citations

- `lib/content/chat-source.ts`: `ChatSource.channelName?: string`. `components/ai/citation.tsx`
  (`SourcePreviewCard`) shows "on {channelName}" when it differs from `creator`.
- Producers: `app/chat/chat-view.tsx` (from the library's `hostName`), `components/channel/
selectable-feed.tsx` (per-card host), and `lib/ai/thread-sources.ts`
  (`archivedChatSources`): read the manifest/transcript header; if it already carries `Channel` and
  `Featuring`, derive `creator` = the featuring person(s) when present and `channelName` = the host
  channel. Search for other `ChatSource` producers and update them. Existing threads without the new
  fields must render exactly as before.

### 5. Rumble alignment (plan 3.9)

- Route the Rumble **video** branches onto the engine as "follow host + import video":
  `saveRumbleCreatorPayload`'s video branch, `addCreatorFromUrl`'s Rumble video branch and
  `resolveCreatorFromAnyUrl` in `lib/creators/service.ts`. A Rumble video link now gets the caption
  gate and no longer stamps the host as refreshed.
- Retire the old path: remove `importRumbleVideo` and the video half of `resolveRumbleCreatorPreview`
  (`lib/creators/rumble-resolver.ts`); keep `parseRumbleVideoPayload`, `pickRumbleThumbnail`,
  `runRumbleDiscovery` and `classifyDiscoveryFailure` where the engine uses them, with platform-neutral
  wording. Remove the now-dead `videoTitle` / `videoId` / `videoUrl` plumbing from
  `CreatorPreviewModel`, `ResolvedPreview` and the "Saving this also imports the video" note in the
  Add dialog if nothing else uses them.
- Update `tests/unit/rumble-video-import.test.ts` and `tests/unit/creator-rumble-resolver.test.ts` for
  the new behaviour (do not delete coverage of the payload parser, thumbnail picker or throttle retry).
  Existing visible Rumble creators already in a library are untouched.

### 6. Docs and optional e2e

- `README.md`: a short "Other videos" paragraph (what it is, English-caption rule, hidden hosts,
  Follow channel). Update the status of `docs/proposals/other-videos-import.md` to "Phase 1 built".
- Optional, if cheap: teach both fake yt-dlp executables (`tests/integration/fake-yt-dlp.cjs`,
  `tests/e2e/fake-yt-dlp.cjs`) to answer `--dump-single-json` on a watch URL (no `--flat-playlist`)
  with a video fixture, and add one step to `tests/e2e/core-flow.e2e.test.ts`. Skip if it grows beyond
  a small change; the unit, component and browser coverage already exist.

## Tests

- Unit: `followCreator` (flips, avatar best effort, refuses a followed creator); `classifyCreatorInput`
  `"video"` cases; Rumble video import through the engine (gate, hidden vs followed host, no refresh
  stamp); `archivedChatSources` with and without the new fields.
- Component: `add-creator-dialog.test.tsx` video flows (preview, add to person, locked person,
  follow-as-creator, rejection messages, X and channel links unchanged); video page buttons;
  citation preview card shows "on {channel}".

## Acceptance

- [ ] `npm run typecheck && npm run lint && npm test && npm run check:migration` pass; run
      `npm run test:e2e` if you changed the fakes. Prettier clean on touched files.
- [ ] Browser (DB copy), the remaining design scenarios plus regression:
  1. Add dialog from the library header: paste a YouTube video link, add it to a person; paste a
     Rumble video link, "Follow as creator". Both end in the right place with the right toast.
  2. "Add platform" from a person's page with a video link: person preselected and locked.
  3. Follow a hidden host from the video page: it appears in the library once (no duplicate if it is
     then added again from search), its avatar loads, its feed refresh runs.
  4. Remove from the video page; removing the last video of a host removes the host.
  5. Citations in a chat over appearances read "{person} on {host}" (a real AI turn only if the user
     agrees to spend quota).
  6. Rumble channel links, X profile and post links, and YouTube channel links still work exactly as
     before.
  7. Settings → clear cached feeds still keeps Other videos (slice 1 behaviour, re-checked end to
     end).
  8. Phone width, dark mode, keyboard-only through both dialogs, no console errors.
- [ ] README status table: all four slices marked done; slice log summarises deviations and any
      follow-ups discovered.

## After this slice

Phase 1 is complete. Before starting phase 2 (more sites) or 3 (paste in the picker), use it on real
research and decide whether they are worth it; the design notes for both are in section 4 of the
design document.
