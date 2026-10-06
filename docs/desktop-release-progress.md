# Desktop release progress

Active stage: **Stage 7 — Final acceptance — verification pending; no target
ready.** The source candidate is committed locally, but the four native
artifacts and draft Release do not exist. The Stage 7 acceptance matrix is
open in [desktop-release-readiness.md](desktop-release-readiness.md).

Branch: `desktop-release` (local candidate commit
`8aea1eba4cfea07a4897f3af3810583a5a74de5f`; not pushed or tagged)
Baseline commit: `ab9dafe` (working tree clean at branch creation)

## Baseline checks (2026-09-19, before Stage 1 changes)

| Command                | Result                      |
| ---------------------- | --------------------------- |
| `npm run desktop:test` | 43 passed, 0 failed         |
| `npm test`             | 927 passed, 3 skipped (930) |
| `npm run lint`         | clean                       |
| `npm run typecheck`    | clean                       |

## Stage 1 — Shared groundwork — implemented

Scope: reusable target/artifact validation, the shared packaged smoke harness,
verification that the Linux package needs no system runtimes, and shared
provider onboarding (OS-aware install guidance, executable-path override,
resolved-command reporting, version/platform info, logs-folder action, privacy
wording, packaged Claude SDK check). No Windows or macOS changes were made and
no compatibility is claimed for them.

### Changed and added files

Target and artifact groundwork:

- `desktop/lib/target.cjs` (new) — explicit platform/arch targets, host
  assertion for native builds, ELF/Mach-O/PE architecture sniffing.
- `desktop/scripts/prepare-runtime.cjs` — resolves the target and requires the
  matching `better-sqlite3` prebuild in the standalone output.
- `desktop/scripts/fetch-ytdlp.cjs` — target-driven asset map; rejects
  unsupported targets (macOS mappings deliberately deferred to Stages 4–5).
- `desktop/scripts/build-x-worker.cjs` — refuses non-host targets, records the
  target in `build.json`, and rejects a wrong-architecture worker binary.
- `desktop/scripts/verify-artifacts.cjs` (new) — version consistency across
  `package.json`, `desktop/package.json`, and both lockfiles; electron version
  agreement; target-specific SQLite prebuild; Claude Agent SDK trace present;
  bundled `yt-dlp` and X worker match the target architecture and checksum.
- `package.json`, `desktop/package.json` — `desktop:prepare` now ends in
  `verify:artifacts`; new `verify:artifacts` script.
- `.github/workflows/desktop-build.yml` — Linux smoke now runs with
  `--minimal-path`.

Smoke harness:

- `desktop/scripts/smoke-packaged.cjs` — accepts `--exe <path>`, isolates the
  profile and environment, runs the app twice against one profile, checks
  architecture, asserts `SCOPE_DESKTOP_SMOKE_OK` and (second run)
  `SCOPE_DESKTOP_SMOKE_REOPENED`, and on failure retains per-run output plus a
  desktop-log tail in `scope-desktop-smoke-failure-*` under the temp directory.
  `--minimal-path` uses an empty `PATH`.
- `desktop/main.cjs` — smoke mode now asserts authenticated health, the
  unauthenticated 404, writes and reopens SQLite through the packaged
  `better-sqlite3`, runs the bundled `yt-dlp`, loads the Claude Agent SDK from
  the packaged trace, renders the Creator library, then loads Settings and
  verifies the renderer bridge reports the app version and exposes the Open
  logs folder action. New `scope:app` IPC (`info`, `open-logs`) with the same
  sender validation as `scope:x`.
- `desktop/preload.cjs` — exposes `window.scopeApp`.

Provider onboarding and shared resolution:

- `lib/ai/provider-paths.ts` (new) — validates and persists per-provider
  executable overrides in the settings table, with the shared in-memory map on
  `globalThis` (route/action/instrumentation bundles are separate module
  graphs in development).
- `lib/ai/codex.ts`, `lib/ai/claude.ts`, `lib/ai/opencode.ts` — one resolver
  per provider now checks the Settings override before auto-discovery; a new
  `resetOpencodeCommandCache` joins the existing Claude cache reset.
- `lib/ai/auth/manager.ts` — snapshots expose `resolvedCommand` and
  `commandSource`; `invalidateProviderResolution` forces re-probing after a
  path change.
- `lib/ai/auth-types.ts` — new `ProviderCommandSource` and snapshot fields.
- `app/api/ai/auth/[provider]/path/route.ts` (new) — POST sets / DELETE clears
  the override with same-origin enforcement, bounded JSON, and existence
  checks for paths containing a separator; returns a fresh snapshot.
- `instrumentation.ts` — loads persisted overrides at server boot.
- `app/settings/ai-backend-setting.tsx` — separate-install and privacy copy;
  per-OS install commands and official docs links for missing CLIs;
  "Set/Change executable path" editor with resolved-command context and inline
  errors.
- `app/settings/settings-form.tsx`, `app/settings/page.tsx` — pass the host
  platform and render the new desktop info section.
- `app/settings/desktop-info.tsx` (new) — desktop-only version/platform line
  and "Open logs folder" action.
- `lib/desktop/app-bridge.ts` (new) — browser-safe bridge wrapper; absent
  bridge hides the section.
- `docs/electron-desktop.md` — maintainer build dependencies, smoke-harness
  behavior, executable-path override, and the no-runtime verification.

Tests:

- `tests/unit/ai-provider-paths.test.ts` (new) — 11 tests: validation, stored
  map parsing, persistence/load, resolver fan-out, environment precedence,
  manager snapshot source, and the path route contract.
- `tests/component/desktop-info.test.tsx` (new) — 2 tests: version/platform
  render and logs action; nothing without the bridge.
- `tests/component/ai-backend-setting.test.tsx` — fixture updates plus
  platform install guidance, Windows commands, incompatible-vs-missing CLI,
  privacy copy, and save/clear executable-path flows.
- `tests/component/model-catalog-picker.test.tsx`, `tests/unit/ai-auth-routes.test.ts`
  — snapshot fixture updates for the new fields.

### Commands and results (after Stage 1 changes)

| Command                                                    | Result                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `npm run desktop:test`                                     | 43 passed, 0 failed                                                        |
| `npm test`                                                 | 944 passed, 3 skipped (947)                                                |
| `npm run check:migration`                                  | 1 passed                                                                   |
| `npm run lint`                                             | clean                                                                      |
| `npm run typecheck`                                        | clean                                                                      |
| `npm run desktop:prepare`                                  | build + runtime + yt-dlp + X worker rebuild + all 5 artifact checks passed |
| `npm --prefix desktop run pack`                            | `desktop/dist/linux-unpacked/scope` produced                               |
| `npm --prefix desktop run smoke`                           | passed (two runs, `SCOPE_DESKTOP_SMOKE_REOPENED` on the second)            |
| `npm --prefix desktop run smoke -- --minimal-path`         | passed with an empty `PATH`                                                |
| `node desktop/scripts/smoke-packaged.cjs --exe /bin/false` | failed as expected and retained diagnostics (verified, then cleaned)       |

### Verification evidence

- No system Node, Python, `uv`, or `yt-dlp`: the full packaged smoke suite
  (SQLite write/reopen, backend health, yt-dlp, X worker, Claude SDK trace,
  renderer, desktop bridge) passes with `PATH` set to an empty directory. The
  frozen X worker build also self-tests with a clean environment containing no
  `PATH` at all.
- Wrong-architecture/stale rejection: `verify-artifacts` checks target-specific
  SQLite prebuilds, the X worker `build.json` plus binary header and sha256,
  and the bundled yt-dlp header; native build steps refuse non-host targets.
- Packaged Claude SDK model listing: `verify-artifacts` proves the SDK is in
  the standalone trace and the packaged smoke imports `sdk.mjs` and asserts
  `query()` exists.
- Same resolved executable: codex, claude, and opencode status, sign-in,
  discovery, and inference call the single resolver per provider; unit tests
  set an override and observe it in both the resolver results and the manager
  snapshot.
- Browser tests (agent-browser, dev server with a disposable
  `SCOPE_DB_PATH` under `/tmp/opencode/scope-browser-test`, `PATH=/usr/bin:/bin`
  so only codex was undiscoverable):
  - settings rendered the separate-install and privacy copy;
  - codex card showed `codex CLI not found` with the Linux install command and
    the official setup link;
  - "Set executable path" opened the editor, a nonexistent path produced the
    inline "does not exist or is not executable" error, a real executable
    saved successfully and flipped the card to the override state, and "Use
    automatic" restored discovery;
  - no console errors were observed during the flows.

### Artifacts

- `desktop/dist/linux-unpacked/scope` — packaged unpacked Linux app from the
  Stage 1 tree (smoke-tested).
- `desktop/dist/scope-0.1.0-x86_64.AppImage` — stale from before Stage 1; it
  was replaced by the verified `scope-0.1.0-linux-x64.AppImage` in Stage 2.

### Remaining manual checks

- None required for the Stage 1 checkpoint. The version/logs bridge is now
  verified in the packaged renderer by the smoke suite; a human click on
  "Open logs folder" (which opens a file manager) remains intentionally
  untested to keep the smoke run side-effect free.
- Stages 4–5 later add macOS yt-dlp asset mappings and DMG behavior; the Mac
  data path and `/opt/homebrew/bin` PATH addition from the plan baseline are
  untouched in this stage.
- Friend-facing AppImage download/install validation belongs to Stage 7.

## Phase 1 review fixes (2026-09-19)

All three review findings are fixed and carried into the Stage 2 work below.

- `desktop/scripts/smoke-packaged.cjs` sets a minimal-path smoke flag;
  `desktop/lib/runtime.cjs` preserves that PATH in the backend instead of
  restoring system/provider directories. A subprocess regression test proves
  Node, Python, uv, and yt-dlp cannot be discovered through the resulting PATH.
  This supersedes the original minimal-path evidence above, which had allowed
  backend startup to restore system directories.
- `lib/ai/provider-paths.ts` rejects relative paths (including persisted relative
  overrides). The path route tells users to enter an absolute path or bare
  command. Regression tests cover existing relative executables and Windows
  drive-relative paths; no additional platform compatibility is claimed.
- `desktop/lib/worker-artifacts.cjs` validates worker source and lockfile hashes
  and upstream metadata as well as binary architecture/checksum. Fixture tests
  prove changes to each build input reject the stale worker.

Verification after fixes:

| Check                                                                    | Result                            |
| ------------------------------------------------------------------------ | --------------------------------- |
| `npm run desktop:test`                                                   | 48 passed                         |
| `npm test`                                                               | 946 passed, 3 skipped             |
| Focused provider/component tests                                         | 26 passed                         |
| `npm run lint`, `npm run typecheck`                                      | passed                            |
| Production build, runtime preparation, artifact verification, Linux pack | passed                            |
| `npm --prefix desktop run smoke -- --minimal-path`                       | passed twice; saved data reopened |

The production build retains the existing dynamic filesystem tracing warnings
in Claude command discovery. The rebuilt unpacked artifact is
`desktop/dist/linux-unpacked/scope`; the AppImage was not rebuilt.

Browser checks used agent-browser and an isolated database/home: an existing
relative executable was rejected with the absolute-path guidance, an absolute
executable saved, and clearing the override restored automatic discovery.
No browser errors were observed. No real provider account was used.

## Stage 2 — Omarchy Linux x64 — implemented

Scope: the download is the versioned AppImage; the packaged app can add an
optional, self-contained application-menu integration (with removal and
manual-update behavior); Linux build/layout/privacy defects found while
packaging were fixed; the Linux CI job verifies the AppImage and runs the
packaged smoke suite; end-user Linux instructions were written. No Windows or
macOS work was done and no compatibility is claimed for them.

### Changed and added files

Artifact and packaging:

- `desktop/electron-builder.config.cjs` — Linux artifact name is now
  `scope-VERSION-linux-x64.AppImage`; `appImage.executableArgs: []` stops the
  generated desktop entry from forcing `--no-sandbox`; `afterPack` deletes any
  traced `desktop/` and `data/` directories from the packaged app-server.
- `desktop/scripts/verify-appimage.cjs` (new) — extracts the built AppImage
  without FUSE and checks the generated desktop entry (including no
  `--no-sandbox`), AppRun/icon, Electron executable, standalone server,
  SQLite prebuild, Claude SDK trace, bundled yt-dlp, X worker, and that no
  checkout `desktop/`/`data/`/`tests/`/`docs/` directories shipped.
- `desktop/scripts/prepare-runtime.cjs` — removes traced `desktop/`, `data/`,
  `tests/`, `docs/` from `.next/standalone` after assembly (Turbopack ignores
  `outputFileTracingExcludes` in this version; the excludes remain for
  webpack builds).
- `desktop/scripts/verify-artifacts.cjs` — fails when those directories are
  present in the standalone runtime.
- `desktop/package.json`, `package.json` — `verify:appimage` script;
  `desktop:dist:linux` now runs it after packaging.
- `next.config.ts` — `outputFileTracingExcludes` for `desktop/**` and
  `data/**` with a `*` route key (the `/*` key misses instrumentation and
  middleware traces).
- `lib/ai/claude.ts` — `turbopackIgnore` on the dynamic mise install-path
  probe; this removes the whole-project trace warning that previously pulled
  the checkout (and any previous package) into the standalone server.

Menu integration:

- `desktop/lib/linux-integration.cjs` (new) — XDG paths; spec-compliant Exec
  quoting; marker-tagged entry; atomic AppImage/icon replacement; refuses to
  overwrite a foreign (legacy) entry; removal deletes only the managed
  AppImage, icon, and entry and keeps the library, reports, logs, and saved X
  login.
- `desktop/main.cjs` — `scope:app` operations `integration-status`,
  `install-menu-entry`, and `remove-menu-entry` behind the existing sender
  validation; the renderer never supplies a path (the main process uses the
  AppImage it was launched from, with a smoke-only override for extracted
  runs). Smoke checks now cover clipboard writes, external links through a
  recording `xdg-open`, and a UI-driven menu install/reinstall/remove
  roundtrip.
- `desktop/preload.cjs`, `lib/desktop/app-bridge.ts` — typed integration
  bridge and helpers.
- `app/settings/desktop-info.tsx` — desktop-only Application menu section
  with Add/Remove, managed path, update instructions, and data-retention note.

Provider-probe safety (found during GUI verification):

- `desktop/lib/runtime.cjs` — mise shim directories are filtered from the
  backend PATH (including directories inherited from the launching session)
  and the backend sets `MISE_AUTO_INSTALL=false`,
  `MISE_EXEC_AUTO_INSTALL=false`, and `MISE_NOT_FOUND_AUTO_INSTALL=false`.
  Without this, a provider status probe for an uninstalled provider could
  make mise download and install it, violating "Scope installs no provider".
- `desktop/test/runtime.test.cjs` — assertions for the filtered PATH and the
  three mise guards.

Smoke harness and CI:

- `desktop/scripts/smoke-packaged.cjs` — new `--appimage`,
  `--appimage-extract-and-run`, and `--check-external-links` modes; AppImage
  runs require the integration marker; external-link runs use an isolated
  recording `xdg-open`.
- `.github/workflows/desktop-build.yml` — explicit `SCOPE_DESKTOP_TARGET_*`
  inputs for prepare/build/smoke; verifies the AppImage contents; smoke-tests
  the unpacked app with an empty PATH, the AppImage extraction fallback, and
  external links.

Tests and documentation:

- `desktop/test/linux-integration.test.cjs` (new) — 10 tests: XDG paths,
  escaping, entry contents, install, atomic reinstall/update, foreign-entry
  conflict, missing download, non-Linux rejection, removal retention, and
  foreign-entry preservation.
- `tests/component/desktop-info.test.tsx` — 5 tests including the menu
  install/remove flow and failure toasts.
- `docs/linux-install.md` (new) — end-user download, FUSE fallback, menu
  integration, updates, keyring, providers, backup, and removal.
- `docs/electron-desktop.md`, `README.md` — artifact name, integration
  behavior, tracing/privacy cleanup, mise/provider-discovery safety, and the
  new smoke modes.

### Commands and results (after Stage 2 changes)

| Command                                                                   | Result                                                           |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `npm run desktop:test`                                                    | 59 passed, 0 failed                                              |
| `npm test`                                                                | 949 passed, 3 skipped (952)                                      |
| `npm run check:migration`                                                 | 1 passed                                                         |
| `npm run lint`                                                            | clean                                                            |
| `npm run typecheck`                                                       | clean                                                            |
| `npm run desktop:dist:linux`                                              | prepare, artifact verification, AppImage verification all passed |
| `npm --prefix desktop run smoke -- --minimal-path`                        | passed (two runs, data reopened)                                 |
| `npm --prefix desktop run smoke -- --check-external-links`                | passed                                                           |
| `npm --prefix desktop run smoke -- --appimage`                            | passed, including the UI-driven menu install/reinstall/remove    |
| `npm --prefix desktop run smoke -- --appimage --appimage-extract-and-run` | passed, including the menu roundtrip                             |
| `smoke --exe <managed copy>`                                              | passed (the menu-launched copy is fully functional)              |

`npm run format:check` still reports pre-existing style issues in four
unmodified `tests/unit/*` files; every file touched by Stages 1–2 is
Prettier-clean.

### Verification evidence

- Linux artifact: `desktop/dist/scope-0.1.0-linux-x64.AppImage`,
  214,659,462 bytes, SHA-256
  `fc2fd2a7ffcd960021624726455fdcc1be9eb4844c4b08c7a524ada9b1d7b8a6`.
  The packaged app-server is 60 MB and contains no checkout `desktop/` or
  `data/` directories (the earlier trace had recursively copied a previous
  package and the developer's local transcripts/reports).
- AppImage contents: the embedded entry does not disable the Chromium
  sandbox; the managed entry written by the app launches the copied AppImage
  directly, also with the sandbox enabled.
- Menu integration evidence: unit tests cover hostile path escaping and
  atomic replacement; a direct library run copied the 214 MB AppImage,
  installed a byte-identical icon, wrote the marker entry, and removal left
  the pretend database and saved X login file in place. In the packaged app,
  the real Settings buttons installed, reinstalled, and removed the entry
  inside the disposable profile, and the managed copy then passed the full
  smoke suite.
- Wayland/GUI checks (agent-browser over CDP against the packaged AppImage on
  this Omarchy Hyprland session, disposable profile and `XDG_DATA_HOME`):
  the window mapped as a native Wayland client (`xwayland=false`, class and
  title `scope`), rendered the Creator library, and a screenshot confirmed
  the dark-theme UI; a second launch exited immediately (single-instance
  lock) and focused the first; quit was clean with no new coredumps.
- Provider discovery on Linux: with an empty provider PATH the packaged
  Settings page reported `codex CLI not found`, `opencode CLI not found`, and
  `claude CLI not found` with install guidance; no provider was downloaded or
  installed (isolated `XDG_DATA_HOME` stayed at 72 KB). A separate run
  confirmed mise's shim/auto-install path cannot be reached through the
  backend PATH or environment.
- Clipboard and external links: every smoke run verifies a renderer clipboard
  write on the system clipboard; the external-links run recorded
  `https://example.com/scope-smoke-link` from the isolated `xdg-open`.
- X storage/keyring: the normal smoke reported `gnome_libsecret` with
  `protected: true`; a no-secret-service run reported `basic_text`,
  `available: false`, `sessionOnly: true`, and the app refused to save. No
  plaintext login was written.
- No system runtimes: the unpacked `--minimal-path` run passes every check
  with an empty PATH; the AppImage keeps a system PATH only because AppRun is
  a shell wrapper, which is documented.
- Browser regression (dev server + agent-browser): Settings renders, the
  desktop-only section stays hidden without the Electron bridge, and the
  console showed no errors.

### Remaining manual checks (external verification, not code failures)

- Downloading the artifact from a real GitHub Release and running it on a
  friend's Omarchy machine belongs to Stages 6–7; the local file is
  smoke-tested only.
- Live provider status/login/model listing/chat/report checks need an
  opted-in provider account and were not run; missing/logged-out/incompatible
  states are covered by fakes and the packaged discovery checks above.
- A live X login/logout/restart-persistence check needs an opted-in test
  account; unit tests and the storage diagnostic cover the storage policy.
- A real application-menu launch (after installing into the real
  `~/.local/share`) was intentionally not performed on the owner's desktop;
  the managed copy was launched directly and passed the smoke suite instead.

## Stage 2 review fixes (2026-09-19)

All four findings from the Stage 2 review are addressed:

- `app/settings/desktop-info.tsx` retains an **Update application-menu copy**
  action after integration. The success message and Linux instructions explain
  quitting the old instance before running a new download and restarting from
  the menu afterwards. `desktop/main.cjs` smoke verification now clicks the
  visible update button rather than invoking its IPC method directly.
- `desktop/lib/linux-integration.cjs` preserves extraction mode in the menu
  entry. It recognizes the environment switch and the runtime's extraction
  directory, because the runtime removes the CLI flag before launching Electron.
- Exec arguments receive both command quoting and desktop-string escaping.
  A fixed shell command receives the path as a positional argument, so it is
  never evaluated as shell source. Launcher regression tests validate and launch
  entries with spaces, Unicode, quotes, backslashes, dollar/backtick characters,
  percent/equals signs, newlines, tabs, and carriage returns.
- `.github/workflows/desktop-build.yml` pins Linux to `ubuntu-24.04` and installs
  the desktop-entry test tools. `docs/electron-desktop.md` documents the baseline
  and maintainer test dependencies. The hosted CI run itself remains pending.

Verification after these fixes:

| Check                                                                     | Result                                                                                                                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run desktop:test`                                                    | 62 passed                                                                                                                                           |
| `npx vitest run tests/component/desktop-info.test.tsx`                    | 5 passed                                                                                                                                            |
| `npm run lint`, `npm run typecheck`                                       | passed                                                                                                                                              |
| `npm run desktop:dist:linux`                                              | production build, runtime/artifact verification, AppImage build and verification passed                                                             |
| `npm --prefix desktop run smoke -- --appimage --appimage-extract-and-run` | passed twice, including visible Add/Update/Remove and saved-data reopening                                                                          |
| `npm --prefix desktop run smoke -- --minimal-path`                        | passed twice                                                                                                                                        |
| Dev server + agent-browser                                                | Add/Update/Remove passed with a mock desktop bridge; no browser errors                                                                              |
| Real generated menu entry + managed AppImage                              | launched through Gio in a disposable XDG directory; a Node-mode probe confirmed extraction without an inherited `APPIMAGE_EXTRACT_AND_RUN` variable |

The launcher probe checks the actual entry and runtime invocation; it is not a
new claim of a full human application-menu GUI test. No real provider account,
owner data, or real application-menu entry was used. Existing external checks
listed above remain pending.

Rebuilt artifact: `desktop/dist/scope-0.1.0-linux-x64.AppImage`, SHA-256
`7477a4c5f2c7013c68fe727270deb2d156ac0134eb0dbee7308900e29475a9dd`.
This supersedes the earlier Stage 2 artifact checksum.

## Stage 3 — Windows x64 — implemented; native verification pending

Scope: the download is the versioned per-user NSIS installer; provider command
resolution works for native executables and npm command wrappers without
enabling a shell; one shared launch resolver now feeds status, sign-in,
sign-out, model discovery, inference, and reports; Windows signing is
configured from CI secrets with an explicit unsigned friends-beta mode; the
Windows CI job runs real process-launch integration tests, verifies the
installer, and smoke-tests the unpacked app with a minimal `PATH`; end-user
Windows instructions were written. No macOS work was done. Shared process code
changed, so Linux was rechecked.

### Changed and added files

Provider launch resolution:

- `lib/ai/provider-command.ts` (new) — one `ProviderLaunch` description
  (`command`, `argsPrefix`, `resolvedCommand`, `kind`, `detail`).
  Non-Windows requests pass through unchanged. On Windows it prefers native
  `.exe`/`.com` files in provider install locations or on `PATH`, otherwise
  parses npm cmd-shim `.cmd`/`.bat` wrappers: a wrapper pointing at an `.exe`
  resolves to that executable, a wrapper pointing at a JavaScript entry
  resolves to a Node runner plus that script as one argument. Unresolvable
  wrappers return `kind: "unresolved"` with a client-safe explanation; the
  wrapper is never executed and no shell or argument concatenation is used.
  Directory listings restore the on-disk casing under uppercase `PATHEXT`.
- `lib/ai/codex.ts`, `lib/ai/claude.ts`, `lib/ai/opencode.ts` — resolvers now
  return the shared launch object (`resolveCodexLaunch`,
  `resolveClaudeLaunch`, `resolveOpencodeLaunch`); each keeps its env/Settings
  override precedence and (outside Windows) mise handling. Run options gained
  `commandArgs`, and the real spawners prepend them before provider arguments.
- `lib/ai/backend.ts`, `lib/ai/models/connection.ts`,
  `lib/ai/models/adapters/codex.ts`, `lib/ai/models/adapters/opencode.ts`,
  `lib/ai/auth/codex-account-client.ts` — infer, report, discovery, catalog
  connection, and app-server paths all spawn the resolved launch (script
  launches include the entry as a prefix argument / `executable`).
- `lib/ai/models/adapters/claude.ts` — the Agent SDK receives the resolved
  native binary, or for npm wrappers the JavaScript entry plus the resolved
  Node runner through the SDK's `executable` option.
- `lib/ai/auth/manager.ts` — snapshots report `launch.resolvedCommand`; an
  unresolved Windows wrapper surfaces as a distinct `discovery_failed`
  status error; legacy codex probes/login/logout and Claude login/logout use
  the resolved launch.
- `lib/ai/auth/claude-login.ts` — status, logout, and the login session run
  the resolved launch, with `argsPrefix` support on the login child.
- `desktop/lib/runtime.cjs` — Windows backend `PATH` now also includes
  `%USERPROFILE%\.local\bin`, `%USERPROFILE%\.opencode\bin`,
  `%USERPROFILE%\.codex\bin`, and the per-user Node.js directory, so a
  Start-menu launch can see native provider installers and Node without a
  restart.

Packaging, signing, and verification:

- `desktop/electron-builder.config.cjs` — Windows artifact name is now
  `scope-${version}-windows-x64-setup.${ext}`; `nsis.allowElevation: false`
  keeps the installer strictly per-user (no UAC on ordinary installs) while
  retaining the selectable installation directory and Start menu entry; the
  desktop shortcut keeps `FRESH_INSTALL` semantics (optional: deleting it
  survives upgrades). `win.forceCodeSigning` follows the explicit require flag.
- `desktop/scripts/windows-signing.cjs` (new) — selects the signed vs explicit
  unsigned friends-beta mode from `CSC_LINK`/`CSC_KEY_PASSWORD` (or `WIN_`
  variants); rejects half-configured secrets; fails fast when
  `SCOPE_DESKTOP_WINDOWS_REQUIRE_SIGNING` is set without credentials; never
  echoes certificate material; the description states that signing does not
  guarantee immediate SmartScreen reputation.
- `desktop/scripts/verify-windows.cjs` (new) — Windows-only check of the
  unpacked x64 app, bundled `yt-dlp`/X worker architecture, the versioned
  installer name/PE header, and the Authenticode status against the declared
  signing mode.
- `desktop/package.json`, `package.json` — `verify:windows` script;
  `desktop:dist:windows` now ends in verification.
- `.github/workflows/desktop-build.yml` — Windows job runs the new
  process-launch integration tests, builds with signing secrets only on
  non-pull-request Windows runs, verifies the installer, and smoke-tests the
  unpacked app with `--minimal-path`.
- `desktop/test/windows-packaging.test.cjs`,
  `desktop/test/windows-signing.test.cjs` (new) — offline checks for the
  installer options/artifact name and the signing-mode contract.
- `desktop/test/runtime.test.cjs` — Windows PATH assertions for the new
  locations, using a spaces/non-ASCII home directory.

Onboarding and documentation:

- `app/settings/ai-backend-setting.tsx` — Windows install guidance prefers
  the standalone/native installers and points at **Set executable path** for
  npm installs; the path editor's resolved-launch copy covers script/native
  launches and uses a Windows placeholder on Windows.
- `docs/windows-install.md` (new) — download, per-user installation,
  SmartScreen/unsigned explanation, updates, provider setup and npm-wrapper
  guidance, data/backup, uninstall, and data retention.
- `docs/electron-desktop.md`, `README.md` — Windows artifact name, installer
  behavior, signing secrets/mode, wrapper resolution, and the new verification
  commands.

Tests:

- `tests/unit/provider-command.test.ts` (new) — 14 tests over a virtual
  Windows filesystem: native installer locations, native-over-wrapper
  preference, PATH `.exe` discovery, npm script and executable shims,
  bundled-Node resolution, configured wrappers, unresolved wrapper/Node
  failures, paths with spaces and non-ASCII user directories, and proof that
  parsing returns single path tokens instead of a shell command line.
- `tests/integration/provider-command-windows.test.ts` (new, Windows-only) —
  writes real `.cmd` wrappers into a temp directory with spaces and non-ASCII
  characters and spawns them through the real codex adapter: the wrapper body
  must never execute, a native `.exe` must win over a wrapper, and an
  unrecognizable wrapper is reported, not spawned.
- `tests/unit/ai-provider-paths.test.ts` — updated to the launch-returning
  resolvers (same override/persistence coverage).
- `tests/component/ai-backend-setting.test.tsx` — Windows hint now also
  asserts the npm fallback guidance.

### Commands and results (after Stage 3 changes)

| Command                                              | Result                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run desktop:test`                               | 72 passed, 0 failed                                                                     |
| `npm test`                                           | 963 passed, 6 skipped (969)                                                             |
| `npm run check:migration`                            | 1 passed                                                                                |
| `npm run lint`                                       | clean                                                                                   |
| `npm run typecheck`                                  | clean                                                                                   |
| `npm run desktop:prepare`                            | build + runtime + yt-dlp + X worker rebuild + all 5 artifact checks passed              |
| `npm --prefix desktop run pack`                      | `desktop/dist/linux-unpacked/scope` rebuilt                                             |
| `npm --prefix desktop run smoke -- --minimal-path`   | passed (two runs, saved data reopened)                                                  |
| `node --check` on the new Windows scripts            | clean                                                                                   |
| `windowsSigningPlan`/config smoke via `node -e`      | unsigned friends-beta default, require-flag failure, signed mode, artifact name/options |
| Dev server + agent-browser (Settings → AI providers) | passed; no page errors or console errors                                                |

The Windows-only integration test and installer verification are skipped on
Linux; they run in the Windows CI job and require a hosted Windows run.

### Verification evidence

- Windows artifact name: `scope-0.1.0-windows-x64-setup.exe` (config test and
  the verifier both check it).
- Installer behavior is set from the electron-builder config: per-user,
  elevation refused, selectable directory, Start menu entry, optional desktop
  shortcut, `deleteAppDataOnUninstall: false`; `desktop/test/windows-packaging.test.cjs`
  asserts each option.
- Wrapper resolution is proven offline for native installs (Claude native,
  Codex standalone versioned scan, OpenCode/Scoop/WinGet locations), npm
  `.cmd` wrappers (script and native targets), bundled Node, missing Node, and
  unresolvable wrappers. Paths with spaces and non-ASCII user directories are
  covered in the fixture tests; `desktop/test/runtime.test.cjs` covers the new
  Windows `PATH` entries with the same home directory.
- The same resolved launch reaches consumers: resolvers are called by the
  account client, Claude login/status/logout, OpenCode probes, model
  discovery, `createAiRunner` (chat/reports), and catalog connection; the
  manager snapshot displays the same `resolvedCommand` the spawn sites use.
- Signing: the plan never contains certificate material; tests cover signed,
  unsigned, half-configured, and required-without-credentials cases;
  `verify:windows` compares the actual Authenticode status to the declared
  mode.
- Linux regression recheck after the shared process changes: production build,
  runtime preparation, artifact verification, unpacked pack, and the packaged
  smoke suite with an empty `PATH` all pass.
- Browser regression (dev server with a disposable `SCOPE_DB_PATH` under
  `/tmp/opencode/scope-browser-test-stage3`, `PATH=/usr/bin:/bin`): Settings
  rendered the separate-install/privacy copy and the Linux install hint; the
  Codex card showed `codex CLI not found`; **Set executable path** opened the
  editor, a nonexistent path produced the inline error, `/usr/bin/true` saved
  and flipped the card to the override state (`Status unavailable` from the
  non-provider executable), and **Use automatic** restored discovery. No page
  errors; the console showed only Next.js dev/HMR messages.

### Remaining manual checks (external verification, not code failures)

- No Windows host is available here, so the installer itself was not executed:
  install, launch from Start, second-instance focus, quit, upgrade from a
  previous build, uninstall, and reinstall with saved data must be run on a
  clean Windows machine and recorded.
- Confirmation that ordinary installation never prompts for administrator
  rights on a real Windows account (the config disables elevation; only a real
  run can confirm the UX).
- Signing/notarization-style validation for Windows: no certificate secrets
  are configured, so the artifact is the explicit unsigned friends-beta build;
  the hosted CI run and a signed build remain pending. SmartScreen reputation
  cannot be verified here.
- The hosted Windows CI run (integration tests, `verify:windows`, minimal-PATH
  smoke) is pending; it cannot be executed from this Linux checkout.
- Live provider checks on Windows with opted-in accounts (native and npm
  installs, paths with spaces/non-ASCII): status, sign-in, model listing,
  chat, and reports.
- Downloading the installer from a real GitHub Release belongs to Stages 6–7.

### Artifacts

- No Windows artifact was built on this Linux host; the Windows build produces
  `desktop/dist/scope-0.1.0-windows-x64-setup.exe` on Windows/CI.
- Linux recheck artifact: `desktop/dist/linux-unpacked/scope` (rebuilt and
  smoke-tested after the shared resolver changes). The Stage 2 AppImage was
  not rebuilt in this stage.

## Stage 3 review fixes (2026-09-20)

The review found that OpenCode's advertised npm installation was rejected by
the wrapper parser, that requiring signing also broke unsigned PR builds,
and that the installer/provider verification was too narrow. The code and
automated coverage are now updated. **Native Windows execution is still
pending; this is implementation and Linux evidence, not Windows acceptance.**

### Changes

- `lib/ai/provider-command.ts`: accepts extensionless npm entries when the
  wrapper explicitly selects a Node runner, preserving argv arrays and
  `shell: false`. A directly quoted `node.exe` is kept separate from the
  script. Unknown extensionless launchers remain rejected.
- `tests/unit/provider-command.test.ts`: regression cases for OpenCode's
  actual extensionless entry shape, non-Node wrappers, and quoted Node paths.
- `.github/workflows/desktop-build.yml`: PR build and verification steps
  explicitly disable required signing while trusted builds retain the
  repository requirement. `desktop/test/windows-signing.test.cjs` evaluates
  both workflow expressions for PR, push, and dispatch scenarios.
- `tests/fixtures/provider-process.cjs` and
  `tests/integration/provider-process.test.ts`: offline real-process tests for
  Codex account status/login/logout, Claude status/login/logout, all three
  model adapters, and shared chat/report runners with actual file output.
  Claude discovery uses the real SDK control protocol. Windows uses `.cmd`
  wrappers and OpenCode's extensionless entry, with spaces and Unicode in
  fixture and working-directory paths. HTTP catalog membership is stubbed;
  no real provider accounts or paid requests are involved.
- `tests/integration/provider-command-windows.test.ts`: avoids passing both
  `Path` and `PATH`, which can hide fixture commands on Windows.
- `desktop/scripts/test-windows-installer.ps1`: native installer lifecycle
  harness, restricted to CI or an explicitly disposable Windows account;
  refuses existing Scope data/installation/shortcuts. Installs a controlled
  older version, launches the actual Start-menu shortcut twice, upgrades,
  uninstalls/reinstalls, restores a closed-app backup, and checks SQLite and
  report retention plus the deleted desktop-shortcut preference. Uses the real
  default data directory in that disposable account and no developer tools on
  PATH. Records version, OS, checks, and logs under
  `desktop/dist/windows-lifecycle/`; retains failures.
- Windows CI builds `0.1.0-stage3-baseline` as an internal unsigned upgrade
  fixture and runs that harness against the candidate. Baseline artifacts are
  not uploaded as downloads. Lifecycle evidence is uploaded even on failure.
- `desktop/main.cjs`: smoke mode now performs actual `supportedModels()`
  through the bundled Claude SDK and Electron Node runtime using an offline
  fixture. Also supports a bounded second-instance handshake for the
  installer harness, verifying that the window is restored/visible. The first
  SDK smoke attempt exposed that the SDK classifies `.cjs` as native; the
  fixture now uses `.js`, matching Claude's npm entry, and the retest passed.
- `desktop/scripts/verify-windows.cjs`: passes signature paths to PowerShell
  as environment data, checks both installer and app, and requires exactly
  `Valid` or `NotSigned` for the declared mode instead of accepting unknown
  statuses.
- `docs/windows-install.md` and `docs/electron-desktop.md`: remove the
  premature "built and tested" claim, document native verification status,
  explain lifecycle automation and remaining manual checks, and clarify
  OpenCode's local credential storage.

### Checks and results

| Check                                                           | Result                                                                                                            |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run desktop:test`                                          | 73 passed                                                                                                         |
| `npm test`                                                      | 972 passed, 6 skipped (978 total)                                                                                 |
| Focused provider tests after fixture/path refinements           | 23 passed, 3 Windows-only skipped                                                                                 |
| `npm run lint`, `npm run typecheck`                             | passed                                                                                                            |
| `npm run check:migration`                                       | 1 passed                                                                                                          |
| `npm run desktop:prepare`                                       | production build, runtime/worker preparation, all 5 artifact checks passed                                        |
| `npm --prefix desktop run pack`                                 | Linux unpacked app rebuilt                                                                                        |
| `npm --prefix desktop run smoke -- --minimal-path`              | two runs passed, including offline SDK model listing and saved-data reopening                                     |
| Packaged second-instance probe with a disposable Linux profile  | passed; original instance received the launch and restored its window before shutdown                             |
| PowerShell parser on `test-windows-installer.ps1`               | passed using checksum-verified official portable PowerShell 7.6.6 on Linux; no native Windows execution implied   |
| `node --check`, changed-code Prettier check, `git diff --check` | passed                                                                                                            |
| Dev server + isolated `agent-browser` session                   | invalid executable rejected, `/usr/bin/true` override saved, automatic discovery restored, no page/console errors |

Browser validation used port 3107 and disposable data under
`/tmp/scope-stage3-browser-review`. The temporary Next.js output and automatic
tsconfig additions were removed after stopping the server. The packaged Linux
artifact is `desktop/dist/linux-unpacked/scope`; the Stage 2 AppImage was not
rebuilt. There is still no Windows artifact from this checkout.

### Remaining Stage 3 evidence

**Owner decision — 2026-09-20:** Leave native Windows CI testing for now.
No verification branch was pushed and no Windows CI run was started. The
repository is private, and its remaining GitHub Actions allowance and spending
settings have not been checked. Resume only when the owner asks; first confirm
the available allowance or obtain approval for any paid usage, then arrange
the remote verification snapshot. Stage 3 remains **implemented — verification
pending**, not Windows release-ready.

GitHub authentication and repository access are available, but the reviewed
Stage 1–3 tree has never been committed/pushed. The latest remote Desktop builds
are older `main` runs, so dispatching that workflow would not test these fixes.
The plan says no commits are implied by checkpoints; a remote verification
snapshot needs owner approval before the Windows CI run can be started.

After that run, record its URL, tested commit, installer checksum, native test
results, and lifecycle evidence here. Fix native failures before declaring the
automated Windows checkpoint passed. Remaining manual checks are interactive
installation as an ordinary Windows user, actual browser download on a clean
machine, SmartScreen/signing UX, X-account persistence, and opted-in live
provider setup/model list/chat/reports. No minimum Windows version is claimed
until supported by actual dependency and clean-machine evidence.

## Stage 4 — macOS Apple Silicon (arm64) — implemented; native verification pending

Scope: the download is `scope-VERSION-macos-arm64.dmg`, built natively on an
arm64 Mac, using the `Contents/Resources` app-bundle layout; the bundled
`yt-dlp` macOS asset and minimum OS floor were verified against the pinned
upstream release; provider discovery covers both Homebrew prefixes without
reading shell startup files; macOS gets normal menus, keyboard shortcuts,
Dock reopen, and quit behavior; Developer ID signing, hardened runtime,
entitlements, and notarization are configured from CI secrets with an explicit
ad-hoc engineering mode. No Intel x64 work was started. Shared code changed,
so Linux was rechecked.

### Changed and added files

Target, assets, and signing:

- `desktop/lib/target.cjs` — new `darwin-arm64` target (`yt-dlp_macos`,
  universal2, `darwin-arm64` SQLite prebuild, minimum macOS 13.0) plus
  Mach-O minimum-OS parsing (`readMachOMinimumOS`) and dotted-version
  comparison helpers.
- `desktop/scripts/fetch-ytdlp.cjs` — macOS asset mapping enabled; the
  downloaded binary must match the target (universal is accepted) and its
  slice minimum macOS is logged. The official `SHA2-256SUMS` check is
  unchanged.
- `desktop/scripts/mac-signing.cjs` (new) — complete-secret-set validation and
  explicit `signed-notarized` vs `unsigned-engineering` plans; supports
  certificate link/password/name (generic or `MAC_` variants) and
  Apple-ID, API-key, or keychain-profile notarization. Never logs secrets.
- `desktop/assets/entitlements.mac.plist`,
  `desktop/assets/entitlements.mac.inherit.plist` (new) — narrow Electron
  entitlements (JIT, unsigned executable memory, library validation for the
  packaged native modules); no device permissions.
- `desktop/electron-builder.config.cjs` — macOS/DMG configuration
  (`scope-${version}-macos-${arch}.${ext}`, Applications shortcut,
  `LSMinimumSystemVersion` 13.0, `darkModeSupport`), explicit signing of the
  nested `yt-dlp`/X worker, and platform-aware `afterPack` placement of the
  standalone server in `.app/Contents/Resources` via the new
  `desktop/lib/bundle-layout.cjs`.
- `desktop/scripts/verify-mac.cjs` (new) — verifies the bundle layout, target
  architectures, actual Mach-O minimums against the declared floor,
  `Info.plist` identity/version/icon/minimum, the versioned DMG (including
  `hdiutil verify` and a mount check for `scope.app` + `/Applications`), and
  the signature mode (Developer ID + hardened runtime + stapled ticket +
  Gatekeeper for release builds; ad-hoc for engineering builds).

App behavior:

- `desktop/main.cjs` — macOS application menu (About/Quit/Services, Edit
  clipboard roles, Window roles), Dock `activate` reopens a closed window
  against the still-running backend, `window-all-closed` no longer quits on
  macOS, and the smoke clipboard check focuses the app first. Linux/Windows
  behavior is unchanged.
- `desktop/lib/runtime.cjs` — provider `PATH` for macOS now includes
  `/opt/homebrew/bin` (Apple Silicon Homebrew) and `/usr/local/bin` (Intel
  Homebrew); Finder launches never source shell startup files.
- `desktop/scripts/smoke-packaged.cjs` — default macOS executable is
  `dist/mac-arm64/scope.app/Contents/MacOS/scope`.
- `app/settings/ai-backend-setting.tsx` — macOS install guidance with the
  official curl installers and Homebrew alternatives.

Build scripts and CI:

- `package.json`, `desktop/package.json` — `desktop:dist:mac`, `dist:mac`
  (`electron-builder --mac dmg --arm64`), and `verify:mac`.
- `.github/workflows/desktop-build.yml` — native `macos-15` arm64 matrix job
  that asserts `uname -m` is `arm64` before building, runs the full
  application tests, builds/verifies the DMG, and runs the shared packaged
  smoke suite with an empty `PATH`. Apple secrets and
  `SCOPE_DESKTOP_MAC_REQUIRE_SIGNING` are passed only to non-PR macOS runs.
  No Intel job was added.

Tests and documentation:

- `desktop/test/macos-packaging.test.cjs` (new) — target metadata, synthetic
  Mach-O arch/min-OS parsing, bundle-layout resolution, and the DMG/signing
  configuration in both modes, including rejection of half-configured secrets.
- `desktop/test/mac-signing.test.cjs` (new) — signing-plan modes, secret
  non-disclosure, and workflow signing-policy expressions for PR, push, and
  manual runs.
- `desktop/test/runtime.test.cjs` — macOS Homebrew `PATH` assertions.
- `tests/component/ai-backend-setting.test.tsx` — macOS install-hint
  assertions.
- `docs/macos-install.md` (new) — download, drag-to-Applications, Gatekeeper,
  menus/shortcuts, manual updates, backup, Keychain, providers, uninstall.
- `docs/electron-desktop.md`, `README.md` — arm64 build/verification,
  signing-secret table, minimum macOS, bundle layout, and Homebrew discovery.

### Commands and results (after Stage 4 changes)

| Command                                            | Result                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run desktop:test`                             | 93 passed, 0 failed                                                           |
| `npm test`                                         | 973 passed, 6 skipped (979)                                                   |
| `npm run check:migration`                          | 1 passed                                                                      |
| `npm run lint`                                     | clean                                                                         |
| `npm run typecheck`                                | clean                                                                         |
| Changed-file Prettier check                        | clean                                                                         |
| `npm run desktop:prepare` (linux-x64)              | production build, runtime/worker preparation, all 5 artifact checks passed    |
| `npm --prefix desktop run pack` (linux-x64)        | `desktop/dist/linux-unpacked/scope` rebuilt                                   |
| `npm --prefix desktop run smoke -- --minimal-path` | passed (two runs, saved data reopened)                                        |
| Mac build/verify/smoke CI job                      | defined; **not run** (no hosted-runner approval and no Apple credentials)     |
| `fetch-ytdlp` with `darwin/arm64` target           | checksum-verified universal2 asset downloaded; arm64 slice minimum macOS 11.0 |

### Verification evidence

- Minimum macOS: 13.0 is the candidate floor, not a tested support claim.
  The original four-executable header check did not inspect SQLite or frozen
  Python dependencies. The review fixes below extend that inventory. Native
  minimum-OS testing and proof of operation without Rosetta remain pending.
- Bundled yt-dlp (`2026.08.19`): SHA-256
  `0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202` matches
  the release's `SHA2-256SUMS`; `file` reports x86_64 + arm64 slices; the
  arm64 slice is `LC_BUILD_VERSION 11.0`.
- Bundle placement: `packagedResourcesDirectory` returns
  `<appOutDir>/scope.app/Contents/Resources` for `darwin` and
  `<appOutDir>/resources` elsewhere; unit tests cover both, and `verify:mac`
  checks the real layout after packing. `afterPack` therefore assembles the
  complete bundle before electron-builder signs it.
- Provider discovery without shell initialization: macOS is not reading
  `~/.zshrc`, `~/.zprofile`, or any other startup file (no code path invokes a
  shell); the backend `PATH` always adds `/opt/homebrew/bin` and
  `/usr/local/bin`. The empty-`PATH` smoke run is the CI proof.
- Menus/Dock: menu roles and activation behavior are configured; a real
  Finder/Dock click test requires a Mac and is listed below as pending.
- Shared-build regression: Linux production build, artifact verification,
  unpacked pack, and the empty-`PATH` smoke suite all pass after the
  `target.cjs`, `runtime.cjs`, `main.cjs`, and smoke-harness changes. Windows
  code paths were not modified beyond the untouched branches of shared files.
- Browser regression (dev server port 3110 with a disposable `SCOPE_DB_PATH`
  under `/tmp/opencode/scope-browser-stage4`, `PATH=/usr/bin:/bin`): the
  Settings → AI providers section rendered the separate-install and privacy
  copy and the platform guidance without page errors; the console showed only
  Next.js dev/HMR messages. No provider sign-in action was clicked.

### Remaining manual checks (external verification, not code failures)

- A native arm64 build and DMG have not been produced: no Apple Silicon Mac is
  available here and the hosted macOS CI job has not been approved/run. The
  `verify:mac` and packaged smoke checks run automatically when it is started.
- Signing/notarization is configured but untested: no Developer ID certificate
  or Apple credentials are present, so no signed/notarized artifact exists and
  `verify:mac` has never executed its distribution branch. The engineering
  mode is the default until the owner provides secrets.
- Browser-download of the actual DMG, install by dragging to Applications,
  Gatekeeper behavior on another Mac, Finder launch, Keychain persistence, and
  replacing the app with a newer signed version must be tested on real Macs
  and recorded (Stage 7 for the downloaded asset).
- Opted-in provider status/sign-in/model listing/chat/report checks on a real
  Apple Silicon Mac, including the packaged Claude SDK model listing, have not
  been run.
- The complete native bundle must pass the expanded architecture/minimum-OS
  checks, then run on the advertised minimum macOS without Rosetta. Neither
  macOS 13 compatibility nor the complete native runtime is verified yet.

### Artifacts

- No macOS artifact was produced on this Linux host. The CI build produces
  `desktop/dist/scope-0.1.0-macos-arm64.dmg` on an arm64 runner.
- Linux recheck artifact: `desktop/dist/linux-unpacked/scope` (rebuilt and
  smoke-tested after the shared changes). The Stage 2 AppImage was not rebuilt
  in this stage.

### Stage 4 review corrections — 2026-09-22

The five review findings are addressed in the working tree. Stage 4 remains
**implemented — native verification pending**; no Mac artifact or signing
success is claimed.

- `desktop/scripts/mac-signing.cjs`, `desktop/electron-builder.config.cjs`:
  normalize `MAC_CSC_LINK`, password, and identity aliases into the actual
  `CSC_*` variables electron-builder reads. Secrets stay out of its generated
  effective configuration. Developer ID mode requires code signing.
- `desktop/scripts/sign-mac.cjs`, `desktop/scripts/mac-frozen.py`:
  use the builder's resolved identity/keychain to sign the worker and yt-dlp's
  embedded Mach-O libraries, rebuild the onefile archives while preserving
  bytecode/options/Python metadata, repair the Mach-O container lengths, then
  sign the outer app before the existing notarization step. Only packaged
  copies change; the checksum-verified downloads are untouched. Engineering
  builds retain upstream frozen payloads. A native signed run of this custom
  repackaging path remains required.
- `desktop/lib/mac-native.cjs`, `desktop/scripts/verify-mac.cjs`,
  `desktop/lib/target.cjs`: recursively inventory native libraries, including
  SQLite and extracted frozen payloads; reject missing arm64 slices or a
  minimum OS above the declared floor. Verify every native signature and, for
  release builds, that its Developer ID team matches the app. Correct FAT64
  slice-offset parsing. `docs/macos-install.md` and `docs/electron-desktop.md`
  now describe macOS 13 as provisional.
- `desktop/lib/window-lifecycle.cjs`, `desktop/main.cjs`: add the Close/⌘W
  menu role, allow closing the startup window on macOS, and share reopen
  behavior between Dock activation and second launches. Native Mac smoke now
  checks the Close role and both reopen paths against the running backend.
- Regression tests: `desktop/test/mac-signing.test.cjs`,
  `desktop/test/macos-packaging.test.cjs`, `desktop/test/sign-mac.test.cjs`,
  `desktop/test/window-lifecycle.test.cjs`, and
  `desktop/scripts/test_mac_frozen.py`. The Python tests run automatically
  from `desktop/scripts/build-x-worker.cjs` with its pinned build environment.

Review-fix validation (Linux host):

| Check                                                                                                        | Result                                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `npm run desktop:test`                                                                                       | 106 passed                                                                                                     |
| `desktop/.runtime/x-worker/venv/bin/python -m unittest discover -s desktop/scripts -p test_mac_frozen.py -v` | 5 passed                                                                                                       |
| Rebuild PKG archives in disposable copies of the real Linux worker and yt-dlp                                | Worker runtime check and yt-dlp `--version` passed                                                             |
| Inspect pinned `yt-dlp_macos` payload                                                                        | SHA-256 matches the value above; 103 embedded Mach-O files, all arm64 slices declare macOS 11.0                |
| `npm run lint`, `npm run typecheck`                                                                          | Passed                                                                                                         |
| `npm --prefix desktop run pack`                                                                              | Rebuilt `desktop/dist/linux-unpacked/scope` using existing prepared standalone runtime                         |
| `npm --prefix desktop run smoke -- --minimal-path`                                                           | Passed twice; saved data reopened, clipboard and offline Claude SDK model listing passed                       |
| `agent-browser` against dev server on port 3112                                                              | Library → Settings → missing-provider Check again → executable-path validation → library; no JavaScript errors |

Browser checks used disposable data under `/tmp/scope-stage4-fixes`, with the
final checks running under an empty environment plus explicit disposable HOME,
XDG directories, and system PATH. No sign-in or paid AI operation was invoked.
The temporary dev server/browser were stopped and Next's temporary configuration
edits were removed. The first lint attempt included the temporary dev build;
lint passed after that generated directory was moved out of the repository.
Linux packaging initially needed network access to obtain Electron; the retry
and smoke checks passed. No production application source changed, so the
existing prepared standalone server was reused for this desktop-only repack.

Remaining verification: native arm64 engineering build/DMG verification/smoke,
Developer ID signing/notarization (including actual execution after frozen
payload repackaging), macOS 13 support, and clean-Mac/Finder/Gatekeeper/Keychain
checks. No CI run, commit, release, or Intel work was started.

## Stage 5 — macOS Intel (x64) — implemented; native verification pending

Scope: the second Mac architecture reuses the completed Stage 4 implementation
without redesigning it. The download is `scope-VERSION-macos-x64.dmg`, built
natively on an Intel Mac with the same app identity, data paths,
`Contents/Resources` layout, DMG installation behavior, entitlements, and
signing/notarization plan as the arm64 app. A separate native Intel CI job was
added on GitHub's hosted `macos-15-intel` runner with a `uname -m` assertion.
The bundled `yt-dlp` universal2 asset was verified to support Intel. Both Mac
downloads are now clearly labeled with About-This-Mac chip identification.
The follow-up review fixed the shared bundle lookup used by verification and
smoke testing. Both architecture paths are covered against the installed
packager's directory calculation; a native arm64 re-run remains pending with
the rest of Stage 4's native work.

### Changed and added files

Target, build commands, and CI:

- `desktop/lib/target.cjs` — new `darwin-x64` release target (`yt-dlp_macos`
  universal2, `darwin-x64` SQLite prebuild, minimum macOS 13.0) with the label
  "macOS x64 (Intel)". `RELEASE_TARGETS` already promised `darwin-x64`; it now
  resolves. Arm64 metadata is unchanged.
- `desktop/package.json`, `package.json` — explicit `dist:mac:x64` /
  `desktop:dist:mac:x64` commands (`electron-builder --mac dmg --x64`). The
  existing `dist:mac` / `desktop:dist:mac` stay the Apple Silicon commands.
- `.github/workflows/desktop-build.yml` — separate `macOS Intel DMG` matrix job
  on `macos-15-intel` with `target_arch: x64` and `runner_uname_m: x86_64`;
  the existing Apple Silicon job gains `runner_uname_m: arm64`. The runner
  architecture step now asserts `uname -m` against `matrix.runner_uname_m`
  instead of hardcoding `arm64`, so a mislabeled runner fails for either job.
  The macOS verify and smoke steps now pass `matrix.target_arch`, so the Intel
  job cannot silently verify or smoke-test an arm64 bundle. Signing secrets
  stay per-platform and are still never exposed to pull-request code; each Mac
  architecture signs and notarizes independently in its own job. The workflow
  comment records that `macos-15-intel` is GitHub's last hosted x86_64 macOS
  image (scheduled for retirement in August 2027) and that a self-hosted Intel
  Mac runner is required after that date — the target is never silently
  dropped.

Rejection of leftover arm64 artifacts (task 2):

- Already enforced by the Stage 1/4 machinery, now covered by Intel-specific
  tests: `assertBinaryMatchesTarget` rejects a thin arm64 Mach-O for the
  `darwin-x64` target (and the reverse); `nativeMinimum` requires an x64 slice;
  `desktop/lib/worker-artifacts.cjs` rejects an X worker whose `build.json`
  records `darwin/arm64`; `desktop/scripts/prepare-runtime.cjs` requires the
  `darwin-x64` `better-sqlite3` prebuild; `desktop/scripts/build-x-worker.cjs`
  refuses non-host targets via `requireHostTarget`, so a fresh x64 worker and
  runtime are produced on the Intel host and a stale arm64 one cannot be
  cross-copied.

Provider discovery (task 4):

- `desktop/lib/runtime.cjs` already adds `/usr/local/bin` (Intel Homebrew) and
  `/opt/homebrew/bin` (Apple Silicon Homebrew) to the backend `PATH` for Finder
  launches without reading shell startup files. No code change was needed;
  `desktop/test/runtime.test.cjs` already asserts both prefixes. Intel-specific
  setup guidance was added only where needed: `docs/macos-install.md` now states
  which Homebrew prefix belongs to which chip.

Tests and documentation:

- `desktop/test/macos-packaging.test.cjs` — the "Intel target is not buildable
  before its own stage" test is replaced by: `darwin-x64` target metadata and
  `RELEASE_TARGETS` membership; `requireHostTarget` refuses an Apple Silicon
  host for the Intel target and the reverse; the universal Mach-O test now also
  satisfies `darwin-x64`; a thin arm64 leftover is rejected for the Intel
  target (and a thin x64 for arm64) including the `nativeMinimum` missing-slice
  path; Intel packaging shares the arm64 app ID, product name, binaries list,
  entitlements, DMG layout, and minimum system version; and the desktop
  workflow builds both Mac architectures on native runners with no hardcoded
  arm64 target arch left in verify/smoke steps.
- `docs/macos-install.md` — retitled for both Mac architectures; a labeled
  download table (**Mac — Apple Silicon** `scope-VERSION-macos-arm64.dmg` and
  **Mac — Intel** `scope-VERSION-macos-x64.dmg`), About This Mac chip
  identification for each download, per-chip native-execution note (no Rosetta
  requirement for either), and the Intel/Apple Silicon Homebrew prefix
  distinction. Update instructions now say to download the same chip's DMG.
- `docs/electron-desktop.md` — maintainer table covers both Mac hosts and CI
  images; new "Build a macOS Intel DMG" section with the explicit target
  command, the `macos-15-intel` runner and its August 2027 retirement /
  self-hosted fallback, shared identity/layout/signing with arm64, leftover
  rejection, the universal2 yt-dlp note, and the Intel smoke command.
- `README.md` — supported platforms and build-command table list both Mac
  downloads with their labels and host requirements.
- `desktop/scripts/verify-mac.cjs`, `desktop/scripts/mac-signing.cjs`,
  `desktop/electron-builder.config.cjs`, `desktop/scripts/smoke-packaged.cjs` —
  comment updates so the Mac tooling describes both architectures instead of
  naming arm64 only.

### Commands and results (after Stage 5 changes)

| Command                                             | Result                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run desktop:test`                              | 110 passed, 0 failed (was 106; +4 new Intel/both-Mac tests)                                   |
| `npm test`                                          | 973 passed, 6 skipped (979) — unchanged from Stage 4                                          |
| `npm run check:migration`                           | 1 passed                                                                                      |
| `npm run lint`                                      | clean                                                                                         |
| `npm run typecheck`                                 | clean                                                                                         |
| Prettier check on every touched file                | clean                                                                                         |
| `git diff --check`                                  | clean                                                                                         |
| `node --check` on changed desktop scripts/config    | clean                                                                                         |
| `npm --prefix desktop run pack` (linux-x64 recheck) | `desktop/dist/linux-unpacked/scope` rebuilt                                                   |
| `npm --prefix desktop run smoke -- --minimal-path`  | passed (two runs, `SCOPE_DESKTOP_SMOKE_REOPENED`, saved data reopened) — Linux shared recheck |
| `fetch-ytdlp` macOS asset inspect (not vendored)    | see evidence below                                                                            |
| Intel build/verify/smoke CI job                     | defined on `macos-15-intel`; **not run** (no hosted-runner approval and no Apple credentials) |

### Verification evidence

- yt-dlp Intel support: the pinned `yt-dlp_macos` asset (`2026.08.19`) was
  downloaded to a scratch directory and its SHA-256
  `0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202` matches the
  release's `SHA2-256SUMS`. `file` reports a Mach-O universal binary with
  `x86_64` and `arm64` slices; `readMachOMinimumOS` reports the x64 slice as
  minimum macOS 10.13 and the arm64 slice as 11.0. `assertBinaryMatchesTarget`
  accepts the asset for both `darwin-x64` and `darwin-arm64`. The x64 slice
  floor (10.13) is well below the declared 13.0 candidate minimum. The
  Linux-host `desktop/vendor/yt-dlp` copy was left untouched (it currently
  holds the Linux ELF from the last prepare).
- Fresh x64 native dependencies and leftover rejection: `requireHostTarget`
  refuses to build the Intel X worker on an arm64 host and the reverse (unit
  tested). On an Intel host, `desktop:prepare` rebuilds the X worker (whose
  `build.json` then records `darwin/x64`) and requires the `darwin-x64`
  `better-sqlite3` prebuild. `verify:artifacts` and `verify:mac` reject a
  worker whose recorded platform/arch does not match the target, any native
  file whose Mach-O header lacks the target architecture, and a missing
  target-specific SQLite prebuild. A thin arm64 leftover is rejected for the
  Intel target with `Wrong architecture: ... is arm64, expected x64` (unit
  tested with synthetic Mach-O headers).
- Intel DMG identity parity: the electron-builder configuration is shared, so
  both architectures produce `scope-<version>-macos-<arch>.dmg` with the same
  `com.scope.desktop` app ID, `scope` product name, `Contents/Resources`
  layout, nested `yt-dlp`/X-worker signing binaries, narrow entitlements,
  `LSMinimumSystemVersion` 13.0, and the drag-to-Applications DMG. A unit test
  loads the config under `darwin/x64` and asserts each of these against the
  arm64 config.
- Intel provider locations from a Finder launch: the backend `PATH` includes
  `/usr/local/bin` (Intel Homebrew) and `/opt/homebrew/bin` (Apple Silicon
  Homebrew) without sourcing shell startup files; `desktop/test/runtime.test.cjs`
  asserts both prefixes and their de-duplication. A live Finder-launch probe on
  an Intel Mac remains pending with the rest of the native checks.
- Signing/notarization is per-architecture and independent: each Mac job runs
  its own `desktop:prepare` → `dist:mac[:x64]` → `verify:mac` chain with the
  same secret set. The existing `mac-signing.cjs` plan (complete-secret-set
  validation, `signed-notarized` vs `unsigned-engineering`) and the
  `sign-mac.cjs` frozen-payload repackaging hook are architecture-agnostic.
  No certificate secrets are configured here, so both artifacts would be the
  explicit ad-hoc engineering build until the owner provides credentials.
- Shared regression recheck on Linux after the `target.cjs`, workflow, and
  comment changes: production pack and the full packaged smoke suite with an
  empty `PATH` pass. The arm64 code path is identical except for the additive
  `darwin-x64` target entry; a native arm64 re-run is listed below rather than
  claimed here.
- Application tests, lint, typecheck, and migration checks are unchanged from
  Stage 4 (973 passed / 6 skipped). No application source changed in this
  stage.

### Remaining manual checks (external verification, not code failures)

- A native Intel build and DMG have not been produced: no Intel Mac is
  available here and the hosted `macos-15-intel` CI job has not been
  approved/run. `verify:mac` and the packaged smoke checks run automatically
  when it is started.
- Signing/notarization of the Intel artifact is configured but untested: no
  Developer ID certificate or Apple credentials are present, so no
  signed/notarized Intel artifact exists and `verify:mac` has never executed
  its distribution branch for `darwin-x64`. The engineering mode is the
  default until the owner provides secrets.
- The full packaged smoke suite on native Intel hardware, and verification of
  the tested minimum macOS version against the actual x64 dependencies
  (SQLite, frozen Python payloads, Electron), have not been run.
- Browser download of the actual Intel DMG, installation into Applications,
  launch, saved X login, opted-in AI setup/chat/reports, upgrade,
  backup/restore, and uninstall/reinstall on an Intel Mac must be run and the
  Intel acceptance column filled (Stage 7 for the downloaded asset).
- A native arm64 re-run after these shared changes is pending alongside Stage
  4's outstanding arm64 verification. Local regression tests verify that the
  shared bundle lookup retains the `mac-arm64` directory for Apple Silicon.
- GitHub's `macos-15-intel` image is scheduled for retirement in August 2027.
  Before then the owner should decide on a self-hosted Intel Mac runner (or an
  approved alternative) so the Intel target stays buildable; this is recorded
  in the workflow comment and here rather than silently dropping the target.

### Artifacts

- No macOS artifact was produced on this Linux host. The CI builds produce
  `desktop/dist/scope-0.1.0-macos-arm64.dmg` on `macos-15` and
  `desktop/dist/scope-0.1.0-macos-x64.dmg` on `macos-15-intel`.
- Linux recheck artifact: `desktop/dist/linux-unpacked/scope` (rebuilt and
  smoke-tested after the shared changes). The Stage 2 AppImage was not rebuilt
  in this stage.
- Scratch-only evidence (not vendored, not shipped):
  `/tmp/opencode/stage5-ytdlp/yt-dlp_macos` and its `SHA2-256SUMS`, used to
  verify the Intel slice; safe to delete.

### Follow-up review and local verification (2026-09-22)

- Fixed a real Intel pipeline blocker: electron-builder 26.15.3 writes Intel
  bundles to `dist/mac/scope.app`, while verification and smoke testing had
  incorrectly expected `dist/mac-x64/scope.app`. Both now use
  `packagedMacAppPath` from `desktop/lib/bundle-layout.cjs`; the Intel DMG name
  remains `scope-VERSION-macos-x64.dmg`.
- Added two regression tests that invoke the installed electron-builder
  `PlatformPackager.computeAppOutDir` with the actual Mac configuration and
  compare the helper's result for x64 and arm64. These exercise the dependency
  contract instead of merely asserting configuration text.
- `npm run desktop:test`: **112 passed, 0 failed** with localhost access.
  The two failures seen under the restricted sandbox were `listen EPERM`,
  not application defects.
- `npm test`: **973 passed, 6 skipped**. Lint, typecheck, migration check,
  changed-code formatting, and `git diff --check` passed.
- `npm run desktop:pack` rebuilt the production Linux package, including a
  fresh X worker and artifact verification. `npm --prefix desktop run smoke
-- --minimal-path` passed against it, exercising both launches, persisted
  data reopening, bundled tools, the Settings bridge, and clipboard access.
- GitHub authentication and Actions access were verified read-only. The
  repository secret list was empty; billing allowance could not be read with
  the existing token's scopes. An isolated local snapshot was prepared, but
  the owner explicitly chose local-only verification. No snapshot was pushed,
  no Actions run was started, and the working branch was not committed.
- Native Intel/arm64 builds, signed/notarized verification, Finder launch,
  minimum-OS hardware testing, and the clean-Mac acceptance checks remain
  unverified. This follow-up does not satisfy the native Stage 5 checkpoint.

## Stage 6 — GitHub release preparation — implemented; draft verification pending

Scope: a dedicated manual draft-release workflow reuses the four native jobs
from the same tag commit, stages one exact artifact per target, validates the
complete set, and creates a **draft only** in this repository. PR/push jobs no
longer receive signing secrets. Versioned downloads, SHA-256 checksums,
release notes, installation guides, and a third-party notice review are all
release assets. No new public release or commit was made.

### Changed and added files

- `.github/workflows/desktop-build.yml` — reusable release input, exact commit
  checkout, release-only signing secrets, pinned Node.js `24.21.0` and
  `windows-2025` runner, and a manifest/asset upload after native verification
  and smoke checks. Routine PR/push artifact upload remains separate.
- `.github/workflows/desktop-release.yml` (new) — manual dispatch on an
  existing `vX.Y.Z` tag; preflight checks the tag, commit, four metadata
  versions, and absence of an existing Release; the four build jobs must all
  pass before the read/write assembly job creates a draft. No publish step.
- `desktop/scripts/release.cjs` (new) — tag/version/lockfile consistency,
  clean exact-commit checkout, strict target artifact naming, signing-mode
  manifests, SHA-256 validation, missing/duplicate/extra/mixed-commit
  rejection, draft notes, links, and asset assembly. The notice review must
  match the pinned yt-dlp version.
- `desktop/test/release.test.cjs` (new) — version mismatch and missing,
  duplicate, corrupt, and mixed-commit assembly failures plus complete-set
  output and links.
- `desktop/scripts/fetch-ytdlp.cjs`, `desktop/electron-builder.config.cjs`,
  `desktop/scripts/verify-artifacts.cjs`, `desktop/scripts/verify-appimage.cjs`,
  `desktop/scripts/verify-windows.cjs`, `desktop/scripts/verify-mac.cjs` — fetch
  the pinned yt-dlp source tag's `LICENSE` and
  `THIRD_PARTY_LICENSES.txt`, bundle them with every app, and verify presence.
- `desktop/scripts/prepare-notices.cjs`,
  `desktop/test/prepare-notices.test.cjs` (new), `package.json` — inventory
  all Node packages in the actual Next.js standalone trace, copy source npm
  license files omitted by tracing into those package directories, and check
  the resulting inventory before packaging. The local Linux trace contained
  69 packages; 7 had no license file in their installed source package and
  remain explicitly marked for review.
- `docs/desktop-release.md`, `docs/desktop-third-party-notices.md` (new),
  `README.md`, `docs/electron-desktop.md`, `docs/windows-install.md` — maintainer version/tag/dispatch
  steps, signing modes, owner publication review, private-repository access,
  direct download links, manual updates, closed-app backup/restore, and the
  full shipped-bundle notice inventory/review boundary.
- `desktop/test/mac-signing.test.cjs`,
  `desktop/test/windows-signing.test.cjs` — signing-gate tests now assert only
  the dedicated release invocation receives the signing requirement; routine
  pushes and pull requests remain unsigned engineering checks.

### Commands and results (2026-09-22)

| Command/check                                                             | Result                                                                                                                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run desktop:test`                                                    | 116 passed, 0 failed                                                                                                                                              |
| `npm test`                                                                | 973 passed, 6 skipped (979), with subprocess access                                                                                                               |
| `npm run check:migration`                                                 | 1 passed                                                                                                                                                          |
| `npm run lint`, `npm run typecheck`                                       | passed                                                                                                                                                            |
| Prettier on changed files, `git diff --check`                             | passed                                                                                                                                                            |
| `actionlint` v1.7.12 on both desktop workflows                            | passed; downloaded binary checksum verified against its release                                                                                                   |
| `npm run desktop:dist:linux`                                              | production build, 69-package notice inventory, pinned yt-dlp notice fetch, worker build, artifact verification, AppImage build and extraction verification passed |
| `npm --prefix desktop run smoke -- --minimal-path`                        | passed twice with saved data reopened                                                                                                                             |
| `npm --prefix desktop run smoke -- --appimage --appimage-extract-and-run` | passed against final AppImage, including menu integration                                                                                                         |
| Release assembly negative fixtures                                        | rejected missing, extra/duplicate, corrupt, and mixed-commit transport outputs                                                                                    |

The first `npm test` attempt inside the restricted sandbox failed subprocess
tests with `EPERM`; the full suite passed when rerun with required process and
loopback access. All source changes made after that run affect desktop release
scripts, packaging, and documentation, not application runtime code.

### Artifacts

- Local verified Linux package:
  `desktop/dist/scope-0.1.0-linux-x64.AppImage`.
- On a tagged CI run, the draft would contain
  `scope-VERSION-linux-x64.AppImage`,
  `scope-VERSION-windows-x64-setup.exe`,
  `scope-VERSION-macos-arm64.dmg`, and
  `scope-VERSION-macos-x64.dmg`, plus `SHA256SUMS.txt`, `RELEASE-NOTES.md`,
  `INSTALL.md`, three platform instructions, and
  `THIRD-PARTY-NOTICES.md`. These CI outputs and the draft do **not** exist
  yet. Actions artifacts are only internal transport.

### Remaining checks and checkpoint

- Run the release workflow on one committed, pushed `vX.Y.Z` tag to prove the
  actual four-job gate, native builds, downloads, signing modes, and draft
  asset upload. No tag or draft was created from this uncommitted branch.
- Stage 3 Windows native installer/clean-machine checks and Stages 4–5 Mac
  native builds, signatures/notarization, minimum OS, and clean-machine
  checks remain pending. Missing Apple signing credentials mean any Mac draft
  produced now would contain ad-hoc engineering DMGs and cannot be published.
- Review the seven standalone npm packages whose installed source contains no
  license text, and inspect each native artifact's Electron/Chromium,
  Node.js, X-worker, and yt-dlp notices before publication. The yt-dlp
  PyInstaller binary includes GPLv3+ components, recorded in the attached
  notice review.
- If the repository remains private, friends need repository access. The
  owner must review the draft's exact commit, checksums, actual downloaded
  assets, installation instructions, and acceptance matrix before any manual
  publication action.

This is **implemented — verification pending** under the plan's external
hardware/credential exception, not a completed four-download draft checkpoint.

## Stage 7 — Final acceptance — verification pending

The source candidate is local commit
`8aea1eba4cfea07a4897f3af3810583a5a74de5f`. It contains the Stage 4–6
implementation and a release-instruction correction: GitHub requires the new
manual workflow on the default branch before a tag-ref dispatch. The complete
decision, four target statuses, and open acceptance matrix are in
[desktop-release-readiness.md](desktop-release-readiness.md).

### Changed files

- `docs/desktop-release.md` — documents the default-branch prerequisite for
  `workflow_dispatch`.
- `docs/desktop-release-readiness.md` — Stage 7 candidate evidence, artifact
  inventory, target readiness, acceptance matrix, and remaining gates.
- `docs/desktop-release-progress.md` — this checkpoint.

### Commands and results (2026-09-22)

| Command/check                                                                                              | Result                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run desktop:test`                                                                                     | 116 passed with subprocess access                                                                                                                                                                                                      |
| `npm test`                                                                                                 | 973 passed, 6 skipped with subprocess access                                                                                                                                                                                           |
| `npm run check:migration`                                                                                  | 1 passed                                                                                                                                                                                                                               |
| `npm run lint`, `npm run typecheck`, `git diff --check`                                                    | Passed                                                                                                                                                                                                                                 |
| `node desktop/scripts/release.cjs validate --tag v0.1.0 --commit 8aea1eba4cfea07a4897f3af3810583a5a74de5f` | Passed on the clean candidate commit                                                                                                                                                                                                   |
| `npm run desktop:dist:linux`                                                                               | Blocked during Turbopack PostCSS worker spawn (`binding to a port: EPERM`) even with process access                                                                                                                                    |
| `npm run build -- --webpack`                                                                               | Production build passed, but its standalone trace was incomplete for the desktop runtime                                                                                                                                               |
| Webpack-output `verify:artifacts`, `verify:appimage`, packaged smoke                                       | Artifact check found a missing Claude SDK. A temporary diagnostic copy allowed packaging and AppImage structure verification, but packaged smoke exposed a missing Next.js module; the copy was reverted and that AppImage is invalid. |
| GitHub read-only checks                                                                                    | Authenticated access works; repo is private; the release workflow is absent from remote `main`; Actions billing usage was unavailable (HTTP 404).                                                                                      |

The initial restricted-shell test failures were process-permission errors;
both suites passed when rerun with required access. The failed Webpack
diagnostic AppImage and standalone output were removed. No valid Stage 7
artifact checksum exists.
No Windows or Mac artifact was built locally, and no release draft or download
was tested.

### Remaining checks and exact next action

All four targets are **not ready**. The prior owner decision kept native CI
local-only because private-repository Actions cost could not be verified; no
branch push, tag push, workflow dispatch, or draft creation was performed.
After authorization for that CI usage, put the release workflow on `main`,
push and tag the candidate, run the four native jobs, and test actual draft
downloads against the readiness matrix. Signing, notarization, provider-account
checks, minimum OS tests, and clean-device install/upgrade/reinstall checks
remain pending. Publication needs a separate explicit owner decision.

## Stage 7 — zero-cost checkpoint (2026-09-24)

The owner declined further native platform jobs and requires a zero-cost path.
GitHub also rejected the saved-branch push matrix before runner allocation,
citing account payments or a spending limit. The native build workflow now
has manual-only triggers, so a branch push or pull request cannot start the
four hosted platform jobs automatically.

Source version `0.1.9` was checked locally at commit
`2c3ad200e6a63201ff419810dff8b105cdf043f3`. Desktop tests (125),
application tests (973 passed, 6 skipped), migration, lint, type checking,
formatting, and representative browser interactions passed. The normal
Turbopack build is blocked on this host by a PostCSS worker port `EPERM`;
the Webpack build completed but its standalone artifact failed verification
because the Claude Agent SDK was absent. That generated standalone output was
removed. No current Linux package is accepted.

The earlier `v0.1.8` Linux native job passed build, verification, and three
packaged smoke scenarios, but it is a different commit. The v0.1.8 Apple
Silicon package verified but runtime smoke timed out; Windows and Intel did
not finish their gates before that run was canceled. The later Mac Keychain
startup change has local unit coverage but no native Mac check. No
four-platform draft or downloaded Release asset exists. The complete target
decisions, historical evidence, and open acceptance matrix are in
[desktop-release-readiness.md](desktop-release-readiness.md). All four targets
remain **not ready to distribute**.
