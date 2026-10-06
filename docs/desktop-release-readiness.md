# Stage 7 desktop release readiness — 2026-09-24

**Decision: not ready to distribute or publish across all targets.** The
original Stage 7 checkpoint checked source commit
`2c3ad200e6a63201ff419810dff8b105cdf043f3` on `desktop-release`,
with version `0.1.9` in both manifests and lockfiles. It is not tagged. There
is no draft Release, no four-asset candidate, and no downloaded Release asset
tested against this commit. The owner requires a zero-cost process and declined
further native platform jobs. GitHub also rejected the last attempted push
matrix before runner allocation, citing failed account payments or a spending
limit. No further Actions jobs were started after that decision.

The original `main` is preserved as `main-backup-2026-09-22` at
`4a697a0424596b51b620547fddc38800b32fc368`. The native build workflow now
runs only by explicit manual dispatch or from the draft workflow; ordinary
pushes and pull requests do not start hosted platform builds.

## Local Linux update — 2026-09-24

The current `0.1.9` checkout now builds a Linux x64 AppImage locally with the
Webpack fallback. `next.config.ts` includes the Claude Agent SDK and Next.js
server files that its standalone trace omitted. Artifact verification, AppImage
structure checks, unpacked smoke, and two-run AppImage extraction-fallback smoke
passed. The smoke exercises backend startup, SQLite, the renderer and desktop
bridge, bundled yt-dlp, offline Claude SDK model listing, clipboard, menu
integration, and saved-data reopen in a disposable profile. The locally built
`scope-0.1.9-linux-x64.AppImage` has SHA-256
`470b68f71b41fe02836870643a6b6f2ca11bc8451431338dcba072ab874c381e`.
That exact file was installed and smoke-tested on this Omarchy computer. The
former `0.1.0` launcher pointed to a nonexistent file; its entry was backed up
before installing the managed `0.1.9` menu entry. User data was not moved.

This is local Linux evidence only. The AppImage has not been downloaded from a
Release, tested on a clean machine, or exercised with real provider accounts.
There is still no four-platform Release candidate.

## Checks at the original checkpoint

| Check                                   | Result                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact source and version consistency    | `release.cjs validate --tag v0.1.9 --commit 2c3ad200e6a63201ff419810dff8b105cdf043f3` passed on a clean commit. This validates source metadata; `v0.1.9` has not been created as a Git tag. |
| Desktop tests                           | 125 passed.                                                                                                                                                                                 |
| Application tests                       | 973 passed, 6 skipped.                                                                                                                                                                      |
| Migration, lint, type check, formatting | Passed.                                                                                                                                                                                     |
| Browser interaction                     | Local development server opened in `agent-browser`; creator form opened, filled, and canceled; chat navigation and sidebar hide/restore passed; no browser errors were reported.            |
| Normal production build                 | Blocked locally when Turbopack's PostCSS worker attempted to bind a port (`EPERM`).                                                                                                         |
| Webpack fallback build                  | Compiled successfully, but `verify:artifacts` rejected its standalone trace because the Claude Agent SDK was absent. This output is not a valid desktop package and was not distributed.    |
| Bundled tools                           | Pinned yt-dlp already verified; X worker built locally, with 11 Python worker tests and 5 frozen-payload tests passing.                                                                     |
| Release assembly logic                  | Existing desktop tests cover complete assembly and rejection of missing, extra, corrupt, and mixed-commit inputs. No real four-platform assembly ran for this commit.                       |

The normal Turbopack build limitation is an environment restriction. The local
Webpack fallback and AppImage now pass on this computer as described above.
The untagged macOS startup change
that defers a synchronous Keychain diagnostic has unit coverage but no native
Mac execution. [Electron documents](https://www.electronjs.org/docs/latest/api/safe-storage)
that its synchronous `safeStorage` calls can block the current thread while
macOS collects user input; the CI timeout's precise cause is still unconfirmed.

## Earlier native evidence, not the current candidate

| Source                                                                                                                                               | Recorded result                                                                                                                                                                                                                                                 | Limit                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`v0.1.8` release run](https://github.com/ascendweb-admin/scope-desktop/actions/runs/35791540775), commit `137ad62ddf605c1574b235b55ec58c33b8335e26` | Linux native build, AppImage verification, unpacked smoke, extraction-fallback smoke, and external-link smoke passed. The staged `scope-0.1.8-linux-x64.AppImage` manifest recorded SHA-256 `fd0897ea075944ee421e2bd5d2b1f6ef591e685a8d34ef30b1adec5afb2a4df2`. | Internal Actions artifact, never a downloaded Release asset; earlier source and version.       |
| Same run, Apple Silicon                                                                                                                              | DMG structure, components, minimum macOS 13.0, and ad-hoc signatures verified. Packaged smoke timed out after menu, window, and loopback setup.                                                                                                                 | Notarization and physical-device checks absent; later source change remains untested natively. |
| Same run, Windows and Intel                                                                                                                          | Windows desktop and application unit suites passed; both jobs were canceled before their remaining gates at the owner's pause request.                                                                                                                          | No v0.1.8 Windows installer lifecycle result or Intel packaged smoke result.                   |
| [`v0.1.7` release run](https://github.com/ascendweb-admin/scope-desktop/actions/runs/35790229322)                                                    | Both Mac DMGs passed package verification, then both packaged smoke runs timed out.                                                                                                                                                                             | Earlier source; no Mac target passed native runtime smoke.                                     |
| [Saved branch push](https://github.com/ascendweb-admin/scope-desktop/actions/runs/35792364682)                                                       | All four jobs failed before runner allocation.                                                                                                                                                                                                                  | GitHub's check annotation cites account payments or spending limit; no platform checks ran.    |

## Artifact inventory and target decision

These are the intended Release filenames for version `0.1.9`. The Linux file
exists locally, but there are no Release downloads. No SHA-256 can be assigned
to a current Release asset.

| Target              | Intended asset                      | Current candidate SHA-256 | Readiness                         |
| ------------------- | ----------------------------------- | ------------------------- | --------------------------------- |
| Omarchy Linux x64   | `scope-0.1.9-linux-x64.AppImage`    | None; local file only     | **Local pass; Release not ready** |
| Windows x64         | `scope-0.1.9-windows-x64-setup.exe` | None; not built           | **Not ready**                     |
| macOS Apple Silicon | `scope-0.1.9-macos-arm64.dmg`       | None; not built           | **Not ready**                     |
| macOS Intel x64     | `scope-0.1.9-macos-x64.dmg`         | None; not built           | **Not ready**                     |

The installation, update, uninstall, and backup instructions exist in this
repository. Their Release download links and clean-device behavior cannot be
confirmed without actual assets. This repository is private, so friends would
need repository access to download a future draft or published Release.

## Acceptance matrix for this source

Every cell remains open. Earlier CI results and local source tests do not
replace checks on exact downloaded `0.1.9` assets. No Windows or Mac physical
device is available here, and real X and AI provider accounts were not used.

| Check                                                | Omarchy x64 | Windows x64 | macOS arm64 | macOS Intel x64 |
| ---------------------------------------------------- | ----------- | ----------- | ----------- | --------------- |
| Native build and unpacked smoke                      | [ ]         | [ ]         | [ ]         | [ ]             |
| Download actual Release asset in browser             | [ ]         | [ ]         | [ ]         | [ ]             |
| Install/launch without developer runtimes            | [ ]         | [ ]         | [ ]         | [ ]             |
| Menu/Start/Finder launch and second launch           | [ ]         | [ ]         | [ ]         | [ ]             |
| Add creator, load feed, fetch/copy transcript        | [ ]         | [ ]         | [ ]         | [ ]             |
| X login, restart persistence, disconnect             | [ ]         | [ ]         | [ ]         | [ ]             |
| Advertised AI providers: setup, models, chat, report | [ ]         | [ ]         | [ ]         | [ ]             |
| External links, report display, clipboard            | [ ]         | [ ]         | [ ]         | [ ]             |
| Offline startup and missing-provider errors          | [ ]         | [ ]         | [ ]         | [ ]             |
| Upgrade from previous build with saved data          | [ ]         | [ ]         | [ ]         | [ ]             |
| Backup/restore and uninstall/reinstall               | [ ]         | [ ]         | [ ]         | [ ]             |
| Signing/security prompts match instructions          | [ ]         | [ ]         | [ ]         | [ ]             |

## Remaining gates

The zero-cost decision leaves the four native jobs, draft assembly, actual
downloads and checksums, controlled Windows upgrade lifecycle, both Mac smoke
runs, clean-device tests, and provider-account checks incomplete. The Mac DMGs
also need Developer ID signing and notarization before distribution. Windows
signing or explicit acceptance of an unsigned friends beta remains open.
Review the native bundled notices before distribution.

Do not create or publish a partial three-platform Release. The manual workflow
and draft assembly code are in place for a future authorized verification path,
but this Stage 7 acceptance checkpoint cannot pass under the current
zero-cost and no-platform-testing constraints.
