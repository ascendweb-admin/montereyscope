# scope

A private, single-user YouTube creator dashboard that runs entirely on your
machine. Save favorite creators, browse their recent videos and livestreams,
extract available captions with yt-dlp, and copy a clean transcript — no
accounts, no cloud services.

This copy also contains a real **Electron desktop application** for Omarchy
Linux, Windows, and macOS (Apple Silicon and Intel). It preserves the existing
Next.js/React interface, bundles the production server and `yt-dlp`, stores its
data outside the source tree, and does not need a browser tab or separately
managed server. See
[Electron desktop application](docs/electron-desktop.md) for architecture,
security, data migration, packaging, and troubleshooting details, and
[Installing Scope on Omarchy Linux](docs/linux-install.md) /
[Installing Scope on Windows](docs/windows-install.md) /
[Installing Scope on macOS](docs/macos-install.md) (Apple Silicon and Intel) for the
download-and-install instructions friends receive with a release.
Maintainers can prepare the four downloads with the
[draft-release procedure](docs/desktop-release.md).

Organize creators into color-coded categories from the library. A creator can
belong to several categories, and the same category filters are available in
the library, AI Research, and the chat source picker so large collections stay
quick to navigate. Existing creators start as **Uncategorized** and remain
untouched when a category is deleted.

The MVP is rounded out by a local **AI layer** (stages 1–7): grounded chat
about cached transcripts and self-contained HTML reports, powered by the
`codex` CLI already installed on your machine under **your own ChatGPT
subscription**. See [AI features](#ai-features) below and
[docs/ai-features.md](docs/ai-features.md) for details.

This repository contains the **MVP release** (stages 1–6): the application
foundation, dashboard shell, persistent creator library (stage 2), cached
creator feeds (stage 3), transcript extraction with one-click copying
(stage 4), the stage 5 resilience & polish pass, and the stage 6 verification
& hardening pass (integration/e2e test harnesses, security audit, dependency
review). Each creator page shows their recent Videos and Livestreams tabs —
fetched on demand with yt-dlp flat playlist metadata (never downloading
media), stored in SQLite, and refreshed manually with a bounded per-tab item
window (Settings → Feed refresh window). Video pages offer **Get
transcript**: scope discovers an available caption track (preferring
human-made English over original English auto-generated captions), converts WebVTT to clean plain text locally, caches
complete results, and copies them with one button.

## Electron desktop quick start

```bash
npm ci
npm run desktop:setup
npm run desktop:dev
```

Create an installer on the target operating system:

```bash
npm run desktop:dist:linux      # Omarchy/Linux AppImage
npm run desktop:dist:windows    # Windows NSIS installer (run on Windows)
npm run desktop:dist:mac        # Mac — Apple Silicon DMG (run on an arm64 Mac)
npm run desktop:dist:mac:x64    # Mac — Intel DMG (run on an Intel Mac)
```

Installers are written to `desktop/dist/`. People using an installed build do
not need Node.js or a separate `yt-dlp` installation. The desktop database is
also separate from `data/localtube.db`, so this copy and the original web app
cannot overwrite each other's data.

## Web/development requirements

- Node.js (developed against v26) and npm
- `yt-dlp` available on your `PATH` (used for creator resolution, feed
  refreshes, and transcript extraction)

Verify yt-dlp works before first use:

```bash
yt-dlp --version      # prints e.g. 2026.08.19
```

If it is installed somewhere unusual, point scope at it via
`SCOPE_YTDLP_PATH` (see `.env.example`).

## Quick start

```bash
npm install          # install project dependencies (first time only)
npm run dev          # development server with hot reload
```

Open **http://127.0.0.1:3000** in your browser. The SQLite database file is
created and migrated automatically the first time the app runs — there is no
separate migration command.

The dev server binds to **127.0.0.1** (loopback) on purpose:

> **This app is not intended for LAN or hosted access.** It has no
> authentication by design and is meant to run only on your own machine.
> Do not expose it to your network or the internet.

## Production build and start

```bash
npm run build        # production build
npm start            # serves it at http://127.0.0.1:3000 (loopback only)
```

## Browser-style launch (legacy option)

One action starts (or reuses) the production server on 127.0.0.1:3000 and
opens the dashboard in your browser — in app mode when your browser supports
it:

```bash
./scripts/launch          # start if needed + open browser
./scripts/server status   # is the launcher-managed server running?
./scripts/server stop     # stop it (only ever signals its own tracked PID)
```

Logs go to `logs/launcher.log` (non-sensitive). To also get an entry in your
desktop app menu, review then install the sample launcher user-locally:

```bash
cat packaging/scope.desktop               # inspect first
./packaging/install-desktop-entry.sh          # writes only to ~/.local/share/applications
./packaging/install-desktop-entry.sh --uninstall
```

No autostart, services, or keybindings are created. Details, uninstall steps,
and troubleshooting: [docs/desktop-launcher.md](docs/desktop-launcher.md).

## Backing up your data

Everything scope keeps lives in one SQLite file:

- default location: `data/localtube.db`
- override: set `SCOPE_DB_PATH` before starting

To back up, stop scope (or simply avoid refreshing/extracting during the
copy) and copy the `.db` file — plus its `-wal` / `-shm` siblings if present —
somewhere safe. To restore, put the files back before starting.

## Clearing caches

Use **Settings → Local cache** inside the app:

- _Clear cached transcripts_ deletes stored transcripts (they are fetched
  again on demand).
- _Clear cached feed metadata_ deletes cached video lists and refresh times;
  saved creators are always kept.

Both show exact counts and ask for confirmation first.

## AI features

scope can ask AI questions about the transcripts you have already cached
and generate reports from them:

- **Ask AI** — on a video page, on a selection of channel videos, or across
  several creators on the **AI Research** page. Conversations are kept as
  threads locally and can be reopened and continued.
- **Three intelligence modes** — the panel's switcher picks how hard the AI
  works on each conversation: **Quick** (fast, conversational answers),
  **Balanced** (grounded answers at everyday depth), and **Deep** (thorough
  analysis that takes its time). Settings → **AI backend** lets you choose a
  model and supported reasoning effort for each mode independently under
  Codex, OpenCode, and Claude Code. You can switch modes mid-conversation —
  it applies from the next message on.
  The OpenCode picker includes all 27 models currently exposed by OpenCode Go;
  models without selectable variants use the provider default. The Claude
  picker follows Claude Code's model aliases: Haiku (no effort control),
  Sonnet, and Opus with low→max effort.
- **Reports** — the panel's "Generate report" action opens a picker for the
  report's **depth profile** — **Brief** (a relaxed overview to stay up to
  date), **Balanced** (the everyday analyst report), or **Deep** (an
  exhaustive technical brief) — and its **visual style** — **Editorial**
  (warm print-magazine feature), **Terminal** (dark technical briefing), or
  **Swiss** (clean minimal memo). The job then queues in the background and
  writes one designed, self-contained HTML document from the selection.
  Finished reports live under `data/ai-jobs/` and are listed on the
  **Reports** page.

How it runs, in one paragraph: scope shells out to the selected local
`codex`, `opencode`, or `claude` CLI and parses its streaming output. Chat
runs are locked down to read-only transcript access; report runs may write
their one HTML deliverable inside their own job directory. Chat mode
settings choose the provider's model and reasoning variant; reports keep
their separate depth-profile settings. Authentication comes from the
provider's existing machine-local login — Codex uses your ChatGPT
subscription (`~/.codex/auth.json`, from `codex login`), OpenCode uses its
own credential store, and Claude Code uses your Claude subscription (from
`claude auth login`, which Settings can start for you) — so every AI action
consumes the selected provider's plan. Without a valid login, chat and
reports show a clear authentication message.

Two rules matter whenever a provider is connected:

- **The app is loopback-only on purpose.** scope binds to 127.0.0.1 and
  has no authentication. Anyone who could reach it could spend your selected
  provider's plan and read your transcripts — so, as with the whole app, do
  not expose it to your network or the internet.
- **Tests never touch your plan.** The unit/integration/e2e suites run
  entirely offline against a scripted fake. Real-subscription code paths are
  exercised only when you explicitly opt in with
  `SCOPE_AI_LIVE_TEST=1` (a smoke test; see docs/ai-features.md).

Built-in guardrails keep usage sane: selections are capped at **25 videos
per analysis**, videos without cached transcripts are skipped (the UI says
which), the materialized transcripts are capped at ~4 MB per job with any
truncation disclosed to you and to the model, reports run **one at a time**
in a sequential queue, and a server restart fails any job stuck mid-run
instead of leaving it "running" forever. Full details, data locations, and
failure behavior: [docs/ai-features.md](docs/ai-features.md).

## Useful commands

| Command                        | What it does                                        |
| ------------------------------ | --------------------------------------------------- |
| `npm run dev`                  | Start dev server at http://127.0.0.1:3000           |
| `npm run build`                | Production build                                    |
| `npm start`                    | Serve the production build (127.0.0.1)              |
| `npm run desktop:dev`          | Open the Electron app with a development server     |
| `npm run desktop:test`         | Test desktop paths, security, and lifecycle helpers |
| `npm run desktop:dist:linux`   | Build the Omarchy/Linux AppImage                    |
| `npm run desktop:dist:windows` | Build the Windows installer                         |
| `npm run desktop:dist:mac`     | Build the Mac — Apple Silicon DMG (on an arm64 Mac) |
| `npm run desktop:dist:mac:x64` | Build the Mac — Intel DMG (on an Intel Mac)         |
| `./scripts/launch`             | Start server if needed + open browser (app mode)    |
| `./scripts/server status`      | Report launcher-managed server state                |
| `./scripts/server stop`        | Stop the launcher-managed server                    |
| `npm test`                     | Unit + integration tests (vitest, fully offline)    |
| `npm run test:integration`     | Integration tests only (real processes, fake tool)  |
| `npm run test:e2e`             | Build + end-to-end core-flow test over real HTTP    |
| `npm run check:migration`      | Clean-database migration release-gate check         |
| `npm run lint`                 | ESLint                                              |
| `npm run typecheck`            | TypeScript strict check                             |
| `npm run format`               | Prettier write                                      |
| `npm run format:check`         | Prettier check                                      |

Automated tests never require YouTube access or an installed yt-dlp binary:
a deterministic fake executable stands in for the real tool.

## Database

SQLite file lives at **`data/localtube.db`** (override with
`SCOPE_DB_PATH`, see `.env.example`). The directory is git-ignored except
for a placeholder so a fresh checkout can create it automatically. Migrations
run idempotently on first database access; re-opening an existing database
applies only pending migrations and preserves all data.

## Health check

`GET /api/health` reports application status, database connectivity, and
whether yt-dlp is available (with its version). It intentionally exposes no
filesystem paths or other environment details. Returns `200` when healthy,
`503` when degraded.

## Error handling

Route segments render designed fallbacks: unknown URLs get the app-wide
404 page, unknown creator or video IDs get a "creator not in your library"
state, unexpected rendering failures hit `app/error.tsx` (with Try again),
and catastrophic layout failures fall back to the dependency-free
`app/global-error.tsx`. yt-dlp failures are classified into specific,
actionable messages; when the tool itself is missing, the UI shows setup
guidance without exposing private paths.
