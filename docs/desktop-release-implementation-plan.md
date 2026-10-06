# Scope desktop release implementation plan

Prepared 2026-09-19. This is an implementation handoff, not a claim that the
release artifacts have been built or validated.

## Objective and agreed scope

Let friends download Scope from GitHub Releases, install or launch it on
Omarchy Linux, Windows, or macOS, and use it without a source checkout or a
manually started backend. Keep Electron and the existing Next.js backend.

Use the same provider setup model discussed for T3 Code: Scope installs its
own runtime; users separately install and authenticate whichever AI provider
they want. Do not bundle or automatically install Codex, Claude Code, or
OpenCode. Users do not need all three. Core library/transcript features must
work without an AI provider.

Version one uses manual updates through GitHub Releases. No website, automatic
updater, Rust/Tauri migration, app store submission, or dedicated downloader
application is required. The downloadable files are the applications/installers.

### Supported release targets

| Platform | Initial target | Download | User experience |
| --- | --- | --- | --- |
| Omarchy Linux | x64 | `scope-VERSION-linux-x64.AppImage` | Download, enable execution if needed, launch; optional app-menu integration |
| Windows | x64 | `scope-VERSION-windows-x64-setup.exe` | Download, run per-user installer, launch from Start |
| macOS | Apple Silicon arm64 | `scope-VERSION-macos-arm64.dmg` | Download, open, drag Scope into Applications, launch |
| macOS | Intel x64 | `scope-VERSION-macos-x64.dmg` | Download, open, drag Scope into Applications, launch |

Both Apple Silicon and Intel Mac support are required for the initial release.
Ship two clearly labeled Mac downloads, not a universal bundle. This means
three operating systems and four build artifacts, each with matching native
dependencies and tests.
Linux/Windows ARM is outside the initial scope. Determine and publish minimum
OS versions from the actual shipped dependencies and testing, not guesses.

## Current repository baseline

- `desktop/electron-builder.config.cjs` defines Linux AppImage and Windows NSIS
  packaging, with a stable app ID and per-user data retention.
- Root and desktop package versions are `0.1.0`; keep both lockfiles in sync.
- `.github/workflows/desktop-build.yml` builds Linux and Windows, smoke-tests
  unpacked apps, and uploads temporary artifacts with 14-day retention. It does
  not implement a durable GitHub Release publishing process.
- `desktop/scripts/fetch-ytdlp.cjs` has Linux/Windows asset mappings but no Mac
  mapping. It already verifies upstream SHA-256 checksums.
- The builder's `copyStandaloneRuntime` hook assumes
  `<appOutDir>/resources/app-server`, which is incorrect for a macOS app bundle.
- `desktop/scripts/smoke-packaged.cjs` assumes every non-Windows target is Linux.
- `desktop/lib/runtime.cjs` contains a macOS data path, but its Unix PATH additions
  omit `/opt/homebrew/bin`.
- `packaging/install-desktop-entry.sh` installs the legacy source-tree launcher,
  not a downloaded AppImage. Preserve it as legacy functionality.
- AI providers remain external. Windows command-wrapper handling needs explicit
  verification; provider spawning currently uses `shell: false`.
- The last assessment passed 43 desktop tests, 927 application tests, lint, and
  type checking. Three application tests were skipped. This is not installer or
  real-account validation; rerun checks on the implementation commit.
- Four proposal documents were already deleted in the working tree when this
  plan was written. Do not restore or include unrelated changes accidentally.

## Working rules for the implementing agent

1. Re-read repository instructions and inspect current code before implementing;
   this plan describes a snapshot, not immutable file contents.
2. Read relevant installed Next.js guides before changing Next.js code, as
   required by `AGENTS.md`.
3. For frontend changes, start the dev server, use `agent-browser`, exercise the
   affected controls, inspect errors, fix problems, and retest. Browser testing
   does not replace packaged Electron testing.
4. Keep existing data paths, app identity, desktop token protection, renderer
   isolation, navigation guards, and protected credential storage intact.
5. Use disposable profiles for validation. Never use the owner's real library or
   provider credentials for automated tests. Real-account checks require an
   explicit opt-in and must not silently consume subscriptions.
6. Within the active stage, complete work possible locally/CI before reporting
   missing signing credentials or unavailable hardware. Distinguish implemented,
   automated-test-passed, and manually verified work in the handoff.
7. Preparing workflows and draft releases is in scope. Publishing a public
   release, configuring external accounts, and spending money require the
   owner's explicit authorization; do not infer it from this implementation plan.

## Execution contract — one stage at a time

Execute the numbered stages below in order. Do not implement multiple platforms
at once, delegate platforms concurrently, or treat this document as one large
change. Within a stage, follow its numbered tasks in order.

For each stage:

1. State the active stage and inspect only the code needed for it.
2. Implement that stage in a reviewable batch. Shared helpers may change when
   required by the active target; do not add later targets speculatively.
3. Run its checks and fix failures before advancing. Check already completed
   targets when a shared change could regress them.
4. Update `docs/desktop-release-progress.md` with changed files, commands/results,
   artifact paths, remaining manual checks, and the exact next stage.
5. Deliver a short checkpoint summary and end the turn. Wait for the owner's
   instruction to continue to the next stage. Do not automatically start it.

If credentials or hardware are unavailable, complete the current stage's
independent implementation and automated checks, record the stage as
**implemented — verification pending**, and stop at its checkpoint. The owner
may authorize moving on while those external checks remain pending. Never mark
that platform release-ready until they pass. A code/test failure is not an
external verification exception.

Keep one active stage in the progress file. Start all stages as **not started**;
this plan itself is not implementation evidence. No commits or public releases
are implied by the checkpoints.

| Order | Stage | Scope |
| --- | --- | --- |
| 1 | Shared groundwork | Minimal reusable checks and onboarding; validate on Linux |
| 2 | Omarchy Linux x64 | Finish and test only the AppImage experience |
| 3 | Windows x64 | Finish and test only the Windows installer |
| 4 | macOS Apple Silicon | Implement and test the arm64 DMG |
| 5 | macOS Intel | Add and test the x64 DMG after arm64 work |
| 6 | GitHub release preparation | Assemble four downloads into a draft release |
| 7 | Final acceptance | Test actual downloads and report publication readiness |

## Stage 1 — Shared groundwork

Do not attempt all-platform packaging in this stage. Use the existing Linux
build to validate reusable work; leave platform-specific paths, signing, and
installer changes to their own stages.

### Steps

1. Re-read instructions, inspect the working tree, and create the progress file.
   Record the baseline checks and preserve unrelated changes.
2. Establish explicit target platform/architecture inputs and artifact validation
   in the preparation scripts. Reject stale or wrong-architecture worker output.
   Keep both package versions and lockfiles consistent.
3. Improve the shared smoke harness to accept an executable path, isolate its
   profile/environment, retain failure diagnostics, and exercise SQLite,
   authenticated health, unauthenticated rejection, renderer loading, bundled
   yt-dlp, the X worker, shutdown, and reopening disposable saved data. Validate
   this on Linux now; add native target invocation in each later stage.
4. Verify that the Linux packaged core needs no system Node, Python, uv, or
   yt-dlp. Document maintainer build dependencies separately. Retain checksums,
   third-party notices, and existing security controls.
5. Implement shared provider onboarding and support described below. Add only
   Linux instructions now; Windows/Mac stages add and validate their own details.
6. Run relevant automated checks and required browser tests for UI changes.
   Record results and stop at the Stage 1 checkpoint.

### Shared provider onboarding and support

Primary areas: `app/settings/ai-backend-setting.tsx`, provider auth/model adapters,
`desktop/lib/runtime.cjs`, and shared provider launch code.

- Explain that provider installation is separate and only one provider is needed.
  Keep missing-provider states nonblocking for core Scope features.
- Show provider-specific installation links/instructions appropriate to the OS,
  then a "Check again" action and supported sign-in flow. Verify current official
  instructions during implementation rather than copying outdated commands.
- Report missing executable, incompatible version, logged out, and discovery
  failure distinctly. Provide a documented executable-path override or a safe
  settings control if automatic discovery fails.
- Prove the same resolved executable is used for login and actual AI work.
- Cover the new Claude SDK-based model listing in packaged tests; a development
  import working does not establish standalone tracing/runtime completeness.
- Add accessible version/platform information and an "Open logs folder" action
  if absent. Do not expose tokens or credentials in diagnostics.
- Update privacy wording: local storage does not mean AI requests stay on-device.
  Explain that selected content goes to the chosen provider and uses its account.


### Stage 1 checkpoint

Shared checks pass on Linux, core features remain usable without providers,
and onboarding clearly describes separate provider installation. Missing-provider,
logged-out, and incompatible-version states are tested with fakes. No claim of
Windows/Mac compatibility is made yet. Report results and wait to continue.

## Stage 2 — Omarchy Linux x64

Work on this target only. Later platform stages remain untouched except for
necessary shared-code fixes.

### Steps

1. Retain AppImage as the initial download. Do not represent it as a traditional
   system installer, and do not require users to clone this repository.
2. Set the explicit versioned Linux artifact name. Pin the Linux build baseline
   and validate the resulting worker/native dependencies on supported Omarchy.
   Do not promise all Linux distributions merely because the format is AppImage.
3. Document making the file executable and the FUSE requirement, with a tested
   extraction fallback if applicable. Never recommend disabling Electron's
   sandbox as the installation workaround.
4. Add an optional, explicit "Add to application menu" action for the packaged
   Linux app, or an equivalently simple supported integration flow. A narrow
   desktop IPC action is acceptable; validate the sender and fixed operation.
5. For a self-contained integration action, copy the running AppImage from its
   original `APPIMAGE` path (not its temporary mount) into a stable user location,
   e.g. `~/.local/share/scope/app/scope.AppImage`. Install the icon and a properly
   escaped `.desktop` entry pointing there. Never require sudo or alter Hyprland,
   keybindings, themes, or system settings. Honor XDG paths where appropriate.
6. Make integration idempotent. Reintegrating a downloaded update replaces the
   managed executable safely and keeps the menu entry stable. Explain when the
   original downloaded copy can be deleted and that restart opens the new version.
7. Provide removal instructions/action that deletes only managed application
   files and the menu entry, retaining user data. Keep this separate from the
   legacy source-tree desktop-entry installer.
8. Verify Wayland window behavior, icon, clipboard, external links, and X-session
   persistence. Explain locked/missing keyring status without silently storing
   plaintext credentials or changing the user's keyring configuration.

After those tasks, finish Linux-specific provider discovery/setup instructions
and validate status, login, model listing, chat, and reports. Add/update the Linux
CI job and run the packaged smoke harness. Test installation, menu launch,
restart, update, backup/restore, and removal using disposable data. Record any
opted-in live-account checks separately. Write Linux end-user instructions.

### Stage 2 checkpoint

The AppImage builds and its automated checks pass. A friend can run it without
a checkout, optionally integrate it into the menu, and update it without losing
data. Complete the Omarchy column of the acceptance matrix where test access
allows; clearly record external verification still pending.
Report evidence in the progress file and wait for instruction to continue.

## Stage 3 — Windows x64

Work on this target only. Later platform stages remain untouched except for
necessary shared-code fixes.

### Steps

1. Retain the per-user NSIS installer, stable app ID, Start menu entry, selectable
   installation directory, and optional desktop shortcut. Confirm ordinary
   installation does not require administrator rights.
2. Set the explicit versioned Windows artifact name from the target table.
3. Verify provider executable resolution for native executables and recommended
   npm-based installations. Windows `.cmd` wrappers cannot be treated as native
   executables. Prefer resolving the real executable or supported script runner;
   do not broadly enable shell execution or concatenate user-controlled arguments.
4. Share provider command resolution between status, login, model discovery,
   inference, and reports. Test paths with spaces and non-ASCII user directories.
5. Provide a signing configuration using CI secrets. Never commit certificates or
   credentials. Allow an explicitly identified unsigned friends-beta mode; state
   that signing does not guarantee immediate SmartScreen reputation.
6. Test the actual installer: install, launch from Start, launch a second instance,
   quit, upgrade, uninstall, and reinstall. Verify data is retained as documented.
7. Include offline automated checks for platform-specific process launching;
   extend Windows coverage beyond the existing unit-only application job where
   integration tests are needed to prove provider process behavior.

Then finish Windows-specific provider onboarding and execute the shared smoke
checks on the native Windows build, including the bundled SQLite module, worker,
and yt-dlp. Test a downloaded installer on a clean Windows machine and fill the
Windows acceptance column. Write Windows install/update/uninstall instructions.
Recheck Linux if shared process or packaging code changed.

### Stage 3 checkpoint

The Windows installer builds, native automated checks pass, and setup works
without developer tools for core features. Provider launching is verified for
the installation methods recommended to users. Signing status and any pending
clean-machine checks are explicit.
Report evidence in the progress file and wait for instruction to continue.

## Stage 4 — macOS Apple Silicon (arm64)

Work on this target only. Later platform stages remain untouched except for
necessary shared-code fixes.

### Steps

1. Add root/desktop arm64 Mac build scripts, a native arm64 CI job, an application
   icon, macOS builder configuration, and a DMG with Applications-folder
   installation. Verify the runner architecture. Do not add the Intel job yet.
2. Add the pinned release's actual macOS yt-dlp asset mapping after verifying its
   upstream architecture and minimum OS requirements. Preserve checksum checks.
3. Build the X worker and SQLite/runtime dependencies for arm64 and verify the
   yt-dlp asset supports arm64. Assemble the complete bundle before signing.
4. Correct server placement to the `.app/Contents/Resources` layout and update
   smoke executable discovery to `.app/Contents/MacOS/...`.
5. Support `/opt/homebrew/bin` in Apple Silicon provider discovery and verify
   Finder launches without interactive shell initialization. Avoid sourcing arbitrary
   shell startup files just to discover tools.
6. Provide expected Mac menus and keyboard shortcuts. Current blanket removal of
   the application menu and quit-on-all-windows-closed behavior should be reviewed;
   implement normal Quit/About/Edit behavior and Dock reopen handling as needed.
7. Configure Developer ID signing, required entitlements/hardened runtime, and
   notarization/stapling for a smooth external download. Include nested worker,
   yt-dlp, and native runtime components in signing validation. Use the narrowest
   required entitlements and keep secrets out of the repository.
8. Allow unsigned builds for engineering checks, but do not mark the intended
   frictionless Mac distribution ready until the signed/notarized artifact passes
   validation. Clearly report any missing owner credentials.
9. Test the actual browser-downloaded DMG on another Mac, installation into
   Applications, Gatekeeper handling, Finder launch, keychain persistence, and
   replacing the application with a newer signed version.
10. Sign, notarize, and test the arm64 artifact. Do not require Rosetta. Label it
    "Mac — Apple Silicon" and publish the tested minimum macOS version.

Finish Apple Silicon provider instructions and test the complete shared smoke
suite on the native packaged app. Verify provider model listing, including the
Claude SDK path, from the installed app. Write Mac installation, manual-update,
and removal instructions. Recheck previous targets affected by shared changes.

### Stage 4 checkpoint

The arm64 DMG builds and native smoke checks pass. Signing/notarization and
clean-Mac checks are recorded separately from engineering builds. Complete the
Apple Silicon acceptance column where possible. Do not begin Intel work in this
stage.
Report evidence in the progress file and wait for instruction to continue.

## Stage 5 — macOS Intel (x64)

Reuse the completed Mac implementation. This stage adds the second architecture;
it does not redesign the Apple Silicon implementation.

### Steps

1. Add explicit x64 Mac build commands and a separate native Intel CI job. Verify
   runner architecture; if hosted Intel runners are unavailable, document the
   required Intel build machine rather than silently omitting this target.
2. Build fresh x64 SQLite/runtime and X-worker dependencies. Verify the yt-dlp
   asset supports Intel and reject artifacts left over from the arm64 build.
3. Produce `scope-VERSION-macos-x64.dmg` with the same app identity, data paths,
   resources layout, and installation behavior as the arm64 app.
4. Verify `/usr/local/bin` and other supported Intel provider locations from a
   Finder launch. Add Intel-specific setup guidance only where needed.
5. Sign, notarize, and staple this artifact independently. Run the full packaged
   smoke suite on native Intel hardware and verify the tested minimum macOS
   version against the actual dependencies.
6. Test browser download, Applications installation, launch, saved X login,
   opted-in AI setup/chat/reports, upgrade, backup/restore, and uninstall/reinstall
   on an Intel Mac. Fill the Intel acceptance column.
7. Label both Mac downloads clearly and explain chip identification via About
   This Mac. Recheck arm64 if shared Mac implementation changed.

### Stage 5 checkpoint

The Intel DMG and native automated checks pass; signing and clean-machine
verification are recorded. Both Mac architectures remain required release
outputs. Record external blockers without claiming full Mac release readiness.
Report results and wait to continue.

## Stage 6 — GitHub release preparation and manual updates

Begin only after the platform stages have checkpoint reports. Pending external
checks may permit draft preparation, but never publication readiness.

### Steps

Primary files: `.github/workflows/desktop-build.yml`, a dedicated release workflow,
version/release helper scripts, and end-user documentation.

1. Keep PR checks separate from secret-bearing release jobs. Never expose signing
   or publishing secrets to untrusted pull request code.
2. Support `vX.Y.Z` release tags and/or manual dispatch. Validate tag, root version,
   desktop version, and lockfile metadata agree. Add a deterministic version-bump
   command if helpful.
3. Build all four targets from the same commit with locked dependencies and
   pinned toolchain choices. Explicitly document any runner constraint.
4. Gate release assembly on all required platform checks. Aggregate the complete
   asset set into a draft release; fail clearly on missing/duplicate assets.
5. Upload versioned application downloads, SHA-256 checksums, release notes, and
   installation instructions as durable Release assets. CI artifacts remain an
   internal transport mechanism, not the user download destination.
6. Default to same-repository Releases. If source is private, document that
   friends need access, or support an owner-configured public distribution repo
   with narrowly scoped credentials. Never expose a private-repo token to clients.
7. Provide explicit links per OS/architecture. Stable filenames across releases
   or a latest-release landing link can be added for a later website; do not use
   a latest-download URL whose versioned asset basename changes each release.
8. Document owner review and publication after clean-machine checks. Record the
   commit and verification status in release notes. Do not overwrite a published
   version with different binaries; issue a new version instead.
9. Manual update instructions: quit Scope, run the new Windows installer; replace
   Scope in Mac Applications; replace/reintegrate the Linux AppImage. Preserve
   app identity and platform data directories throughout.
10. Document backup/restore covering the database and reports, with Scope fully
    closed for file-copy backups. Treat encrypted sessions as machine-bound
    credentials, not a portable backup guarantee. Explain that downgrading the
    executable may not reverse database migrations.
11. Review notices for the complete shipped bundle, not only the X worker.


### Stage 6 checkpoint

The release workflow assembles four versioned downloads, checksums, instructions,
and release notes into a draft. Validate missing-asset failure behavior and
version consistency. Do not publish yet. Record results and wait to continue.

## Stage 7 — Final acceptance and publication readiness

### Steps

1. Build the final candidate from one commit after all platform changes.
2. Prepare the draft release and obtain its actual artifacts through the
   authenticated draft interface (or an explicitly authorized test prerelease).
3. Test the matrix below on one target at a time: Omarchy, Windows, Apple Silicon,
   then Intel. Do not confuse unpacked smoke tests with downloaded-app validation.
4. Fix any failures and retest affected targets. Refresh artifacts after code
   changes; record their checksums and the exact tested commit.
5. Confirm all four downloads and instructions are usable by the intended
   friends; explain any private-repository access requirement.
6. Produce the final readiness report. Leave the release as a draft until the
   owner explicitly authorizes publication.

### Required checks

Run applicable desktop tests, application tests, lint, type checking, migration
checks, production build, and packaged smoke tests. Add meaningful targeted
tests for resource placement, target validation, provider launching, integration,
and upgrade behavior. Do not silently skip a failing platform to publish others
under a claim of three-platform support.

Use this matrix for each actual release candidate. Checkboxes stay open until
there is recorded evidence; CI success does not fill hardware-only checks.

| Check | Omarchy x64 | Windows x64 | macOS arm64 | macOS Intel x64 |
| --- | --- | --- | --- | --- |
| Native build and unpacked smoke | [ ] | [ ] | [ ] | [ ] |
| Download actual Release asset in browser | [ ] | [ ] | [ ] | [ ] |
| Install/launch without developer runtimes | [ ] | [ ] | [ ] | [ ] |
| Menu/Start/Finder launch and second launch | [ ] | [ ] | [ ] | [ ] |
| Add creator, load feed, fetch/copy transcript | [ ] | [ ] | [ ] | [ ] |
| X login, restart persistence, disconnect | [ ] | [ ] | [ ] | [ ] |
| Each advertised AI provider: setup/model list/chat/report | [ ] | [ ] | [ ] | [ ] |
| External links, report display, clipboard | [ ] | [ ] | [ ] | [ ] |
| Offline startup and missing-provider errors | [ ] | [ ] | [ ] | [ ] |
| Upgrade from previous build with saved data | [ ] | [ ] | [ ] | [ ] |
| Backup/restore and uninstall/reinstall | [ ] | [ ] | [ ] | [ ] |
| Signing/security prompts match documentation | [ ] | [ ] | [ ] | [ ] |

For the first release, use two controlled test versions to exercise the upgrade
path. If any provider cannot be validated on a platform, label the limitation
explicitly rather than advertising full support. Exercise real network and
provider behavior manually with opted-in test accounts; never charge real plans
from standard CI.

## Owner inputs and final handoff

Implementation can begin without these answers. Collect them when needed:

- GitHub release destination and whether downloads should be public.
- Apple Developer signing/notarization credentials and testers with both an
  Apple Silicon Mac and an Intel Mac.
- Windows signing credentials, or explicit acceptance of unsigned beta builds.
- One tester/device for each platform and opted-in provider test accounts.

Deliver source changes, workflows, maintainer build/release instructions,
end-user install/update/uninstall/backup instructions, artifact inventory, and a
verification report distinguishing passed checks from outstanding checks.

### Stage 7 checkpoint

Report ready/not ready for each of the four targets, with artifact names, tested
commit, checksums, evidence, and any blockers. Do not claim an untested target is
ready. Publishing is a separate owner-authorized action, not an automatic next
step. The implementation is complete only when the required work is done and
remaining external verification is honestly documented.
