# Slice 3: First usable slice

Design: [`../other-videos-import.md`](../other-videos-import.md) sections 3.6 (person page parts) and
3.7 (plan steps 6, 7 and the feed/picker/video-page fixes from step 8). After this slice you can paste
links on a person, see them under "Other videos", select them and ask the AI, with correct labels and
no dead links anywhere.

**Prerequisites:** slices 1 and 2 done. Check: `lib/videos/attribution.ts`, `lib/videos/import/` and
`app/actions/videos.ts` exist; `npm test` is green.

## Scope

In: AI labelling ("Featuring"), report people, the "Add videos" dialog, the "Other videos" tab and
panel, removal, and every place an imported video becomes visible (Overview, Feed, picker, reports
links, video page back link).

Not in: the Add creator dialog's video branch, "Follow channel", citation `channelName`, Rumble
alignment (slice 4).

Order matters: do **A (data and AI) first**, then B and C, then D. Imported videos show up in the
Feed and picker as soon as slice 2's import runs, so D must land in the same slice as the dialog.

## Work items

### A. Labels and AI (plan step 6)

1. **Featuring on sources.** `lib/ai/scope.ts`: add `featuring: string[]` to `ScopedVideo` and
   `ScopedSource`. Fill it with `listFeaturedProfiles` (slice 1) in `resolveScope` and
   `resolveSourceScope`, one extra chunked query; leave the main `SELECT`s unchanged. `creator` stays
   the host's profile name (truthful) and `channel` stays "YouTube @handle".
2. **Header.** `lib/ai/materialize.ts` `renderTranscriptFile`: add `Featuring: A, B` after the
   `Channel:` line when non-empty. Pass `featuring` at both call sites (the legacy one and the v2 one
   near `renderTranscriptFile({ id: source.id, ...})`).
3. **Prompts.** Add one static sentence to `GROUNDING_INSTRUCTION` (`lib/ai/chat.ts`) and
   `REPORT_INSTRUCTION` (`lib/ai/reports.ts`): a source file may carry a `Featuring` line naming
   someone who appears on another person's channel (an interview or guest appearance); the Creator is
   then the channel's owner, and because captions carry no speaker labels, never attribute a statement
   to the featured person unless the transcript itself makes the speaker clear. Update the tests that
   pin these constants (`ai-chat-modes`, `ai-reports`, `ai-chat-route`). Digests are untouched.
4. **Source library.** `lib/ai/source-library.ts`: videos gain `featuredProfileId: number | null`,
   `featuredName: string | null`, `hostName: string | null`, from the first attribution
   (`listVideoProfileIds` order). For a featured video: `creatorName = featuredName`,
   `hostName` = the host's display name, and **`categoryIds` come from the featured person**
   (`listProfileCategoryAssignments` / the profile's categories), not the hidden host's, otherwise
   appearances show as Uncategorized in the picker's category filter. `creatorId` stays the real host
   id (detail links and the transcript API use it).
5. **Report people.** `lib/ai/report-people.ts`: `describeReportPeople(db, accountCounts,
profileCounts?)` ignores accounts with `followed = 0` and adds `profileCounts` (featured person to
   source count). Add `countFeaturedProfiles(sources)`; use it with `countSourceAccounts` at the three
   call sites in `lib/ai/reports.ts` (for video-report sources only). `getReportVideosByIds` carries
   `featuredNames` onto `ReportSource` (optional field; keep `creatorName` = host).
6. **Reports UI link audit.** `components/reports/model.ts` and `report-detail.tsx` link videos to
   `/channels/<creatorId>/videos/<id>` (works for hidden hosts: keep). `new-report-flow.tsx` groups
   people with `profileOf.get(item.creatorId) ?? -item.creatorId`: use `featuredProfileId` first.

### B. Add videos dialog (plan step 7)

New `components/creators/add-videos-dialog.tsx`, props `{ profile: { id, displayName }, onImported?
}`; trigger is an outline "Add videos" button (icon: `ListVideo` or `Film`) rendered in
`app/creators/[id]/creator-header.tsx` beside the existing `AddCreatorDialog` ("Add platform"), with
`onImported={() => router.refresh()}`. Follow the conventions of `components/library/add-creator-dialog.tsx`
(`AppDialog`, `Button`, `AlertNote`, `useToast`, busy handling).

- **Paste step:** a textarea ("Paste video links, one per line or all at once") and a "Find videos"
  button, disabled when empty. `extractVideoLinks` (slice 2) is the only parser; non-links are
  ignored, `rejected` entries become rejected rows with their message, `truncated` shows
  "Only the first 30 links were used."
- **Review step:** one row per link, filled in as each resolves (client pool of **3** calling
  `previewVideoLinkAction(url, profile.id)`). Row = thumbnail (plain `<img>`, like `VideoCard`), title,
  host channel, duration, platform mark, captions chip ("Human captions" / "Auto captions"), and a
  status: _Checking…_, _Ready_, _Already in Other videos_, _Rejected: reason_, or _Couldn't check_ with
  a Retry button (retryable errors). Ready rows are pre-ticked; rejected and already-added rows are
  not selectable. "Select all ready" / "None".
- **Footer:** "Add N videos" (disabled at 0), an off-by-default "Also follow these channels" switch,
  and a one-line load hint using `estimateScopeLoad` and `formatVideoHours`
  (`@/lib/ai/scope-selection`): "N videos · X h selected. An analysis takes up to 25 videos or 50
  hours."
- **Commit:** `importVideosAction(selectedUrls, { profileId, followHost })`. If every row succeeded:
  close, toast "Added N videos to {name}'s Other videos.", call `onImported`. If some failed: stay
  open, mark failed rows with their error and a Retry, keep succeeded rows marked "Added".
- Controls disable while resolving or saving; closing aborts pending previews (ignore late results).
  Keyboard: Enter in the textarea does not submit; Cmd/Ctrl+Enter triggers "Find videos".

### C. Other videos tab (plan step 7)

1. `app/creators/[id]/page.tsx`: read `view=other` from `searchParams`; load `listProfileVideos` and
   the count. Show the tabs when `otherCount > 0` **even for a single-account person** (today `single`
   skips the tabs): `Overview | <account> | Other videos`, still landing on the account when no view is
   given. When the person has several accounts the new tab is added after the account tabs. A
   `?view=other` request with zero videos falls back to the default view.
2. `creator-tabs.tsx`: a new tab (icon `ListVideo`, label "Other videos", count) linking to
   `/creators/<id>?view=other`; Overview count includes attributed videos.
3. `app/creators/[id]/other-videos-panel.tsx`: header strip explaining "Videos from other channels
   this person appears in", then `SelectableFeed` (all videos in `videos`, `livestreams=[]`; verify
   `FeedTabs` shows one clean list and hide an empty Livestreams tab if it does not already). Empty
   state with a prompt to use **Add videos**.
4. `components/channel/video-card.tsx`: optional `subtitle` ("on PBD Podcast"); add optional
   `hostName` and `platform` to `VideoCardModel`.
5. `components/channel/selectable-feed.tsx`: build chat `sources` from each card's own
   `platform` / host when present (it currently takes one `creatorName`/`platform` for the whole
   feed), and add an optional `onRemove?: (ids: string[]) => Promise<void>` that adds a **Remove**
   button to the selection bar behind the existing `ConfirmDialog` ("Remove N videos from Other
   videos? Their transcripts are deleted if nothing else uses them.").
6. `app/actions/videos.ts`: `removeVideosAction(profileId, videoIds)` (validate; loop
   `removeAttributedVideo`; revalidate; return counts). Hook it up through the panel.
7. Overview: `lib/feed/items.ts` `buildFeedItems(db, accounts, { featuredProfileId? })` also includes
   the person's attributed videos so the Overview and its count agree.

### D. Everything else an imported video touches (part of plan step 8)

1. **Feed items** (`lib/feed/items.ts`, `components/feed/feed-stream.tsx`): for a featured video use
   the featured person's profile id, name, avatar and categories, set `accountLabel` to "on {host}",
   and make `accountHref` (feed-stream.tsx ~line 1034) return `/creators/<featuredProfileId>?view=other`.
   `creatorId` stays the real host id for the detail and transcript URLs.
2. **Picker** (`components/ai/chat-source-picker.tsx`): add `featuredProfileId`, `featuredName`,
   `hostName` to `PickerVideo` and `toItems` (`groupId = featuredProfileId ?? groupIdOf(...)`, name
   from the featured person), and show "on {host}" under the card title. The rail already contains the
   person, so appearances land in their group.
3. **Video page** (`app/channels/[id]/videos/[videoId]/page.tsx`): for a source-only host the back link
   currently resolves to the hidden profile (404). Point it at the first attributed person's
   `?view=other` ("Back to {person}'s Other videos") and show read-only "Featuring {names}" and
   "on {host}" chips. (Actions come in slice 4.)

## Tests

- Unit: `ai-scope` (featuring in both resolvers), `ai-materialize-sources` / `ai-materialize` (header
  line only when non-empty, both call sites), `ai-report-sources` (people from featured profiles,
  hidden hosts ignored), `ai-sources-route` / a `loadSourceLibrary` test (featured fields, categories
  from the person), `buildFeedItems` (featured label/href/avatar/categories), prompt constants.
- Component: `tests/component/add-videos-dialog.test.tsx` (mock `previewVideoLinkAction` and
  `importVideosAction`): pool of 3, statuses, rejected rows not selectable, Retry, all-success path,
  partial-failure path, follow switch payload, abort on close. `CreatorTabs` (tab appears only with
  videos; counts). `selectable-feed` (per-card platform in sources; Remove flow with confirm).
  `chat-source-picker` (featured grouping and subtitle). `creator-library` unchanged snapshot-style
  check that a hidden host adds nothing.

## Acceptance

- [ ] `npm run typecheck && npm run lint && npm test` pass; prettier clean on touched files.
- [ ] Browser (DB copy, real public videos), per README:
  1. On a person's page: Add videos with a mixed blob: 2 YouTube videos with captions, 1 Rumble video,
     1 video with no English captions (verify one with `yt-dlp --list-subs`), 1 channel link, 1
     unsupported site, 1 repeat. Statuses and messages are right; rejected rows cannot be ticked;
     "Add N" adds exactly the ready ones.
  2. The Other videos tab appears with the right count; the Overview includes the videos; a
     single-account person gets `Overview | account | Other videos` and still lands on the account.
  3. The library grid, category filters and Refresh All scope are unchanged.
  4. Feed shows the appearances labelled with the person ("on {host}") and every link works (no 404);
     the picker groups them under the person, the person's categories filter them, selecting two opens
     the chat panel. A real AI turn only if the user agrees to spend quota: check the transcript
     header has `Featuring:` (look in the job directory) and the answer cites correctly.
  5. The video page's back link goes to the person's Other videos.
  6. Remove two videos in selection mode; removing the last video of a host also removes the host row
     (check the database copy).
  7. Phone width, dark mode, keyboard-only through the dialog, no console errors.

## Hand-off to slice 4

Slice 4 builds on: `previewVideoLinkAction` / `importVideosAction` (preview shape), the dialog's row
components (reuse for the Add creator dialog's video preview card), `removeVideosAction`,
`featured*` fields in the picker and feed models. Note in the slice log any component you extracted.
