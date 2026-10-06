# Electron desktop application

This project keeps the existing Next.js interface and runs it inside a native
Electron window. The renderer is the same React and CSS application as the web
version; there is no second UI to keep in sync.

The packaged app contains Electron, the production Next.js standalone server,
the required Node.js modules, and a checksum-verified `yt-dlp` executable. An
installed user does not need Node.js or `yt-dlp`.

## Maintainer build dependencies

These are needed only to build artifacts; an installed Scope needs none of
them. The packaged Linux app was verified to pass every smoke check with an
empty `PATH`, and its frozen X worker runs in a clean environment with no
`PATH` at all.

| Tool               | Version used                                                                        | Needed for                                                             |
| ------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Node.js + npm      | 24.21.0 (pinned in CI), 22+ supported                                               | Next.js build, Electron packaging                                      |
| `uv`               | 0.8.22 (pinned in CI)                                                               | X worker Python environment                                            |
| Python             | 3.12 (managed by `uv`)                                                              | X worker PyInstaller build                                             |
| Git                | any recent                                                                          | Source checkout                                                        |
| macOS build host   | Apple Silicon for arm64, Intel x64 for x64; CI uses `macos-15` and `macos-15-intel` | Native DMG per architecture; minimum supported OS pending verification |
| Xcode command line | current                                                                             | Ad-hoc/Developer ID signing on macOS                                   |

`npm run desktop:prepare` runs the whole preparation chain: production build,
standalone-runtime assembly, checksum-verified `yt-dlp` download, frozen X
worker build, and `desktop/scripts/verify-artifacts.cjs`, which refuses to
continue when package/lockfile versions disagree, when the standalone
`better-sqlite3` prebuild or Claude Agent SDK trace belongs to another target,
or when the bundled `yt-dlp`/X worker was built for a different platform or
architecture. Native targets must be built on matching hardware: the X worker
and Electron packaging cannot cross-compile.

For versioning, the four-target draft workflow, checksums, signing modes, and
owner publication review, see [Preparing a Scope desktop release](desktop-release.md).

## Runtime design

Electron starts the standalone server as a child utility process bound to a
random `127.0.0.1` port. A new random token is required on every request and is
injected only by the app's renderer session. The server is therefore not usable
as an unauthenticated local web service while the desktop app is running.

The renderer has Node.js integration disabled, context isolation and Chromium's
sandbox enabled, guarded navigation, and a narrow permission policy. External
HTTP(S) and email links open in the system browser or mail client. Provider
sign-in follows the same rule: `window.open` and the explicit login links in
Settings → AI providers go through the navigation guard to
`shell.openExternal` after the URL is validated as https on the provider's
official hosts, and the provider callback stays on its own listener — never
inside a scope webview. All `/api/ai/auth` requests keep the per-launch
desktop token requirement from `proxy.ts`.

The Electron host owns the server lifecycle. It waits for the authenticated
health endpoint before showing the app and stops the server during a normal
quit. A rotating diagnostic log is kept in the desktop data directory.

## Develop locally

From the project root:

```bash
npm ci
npm run desktop:setup
npm run desktop:dev
```

`desktop:setup` installs the separate Electron build dependencies and downloads
the pinned official `yt-dlp` binary after verifying its SHA-256 checksum. Dev
mode uses `scope-desktop-dev` as its data directory, so it cannot overwrite the
packaged app's database.

## Build an Omarchy/Linux AppImage

Build on an x86-64 Linux machine:

```bash
npm ci
npm ci --prefix desktop
npm run desktop:dist:linux
```

The result is `desktop/dist/scope-0.1.0-linux-x64.AppImage`; `desktop:dist:linux`
also extracts it and runs `verify:appimage`, which checks the generated desktop
entry, icon, Electron executable, standalone server, SQLite runtime, bundled
`yt-dlp`, and X worker against the current sources. The Linux release target is
x64 only, built on `ubuntu-24.04` (Ubuntu 24.04, glibc 2.39) in CI and validated on Omarchy. The package
does not promise every Linux distribution.

To run the built artifact:

```bash
chmod +x desktop/dist/scope-0.1.0-linux-x64.AppImage
./desktop/dist/scope-0.1.0-linux-x64.AppImage
```

This needs no Omarchy, Hyprland, terminal, theme, keybinding, or service
configuration changes. The AppImage uses the normal native window chrome and
runs as a native Wayland client in an Omarchy Wayland session. AppImage
execution requires FUSE 2, which is present in a normal Omarchy installation;
`--appimage-extract-and-run` is the tested fallback on a system without FUSE.
The AppRun script is a shell script, so a manual launch needs `/usr/bin` on
`PATH`; it does not need Node, Python, `uv`, or `yt-dlp`.

### Application-menu integration

The packaged Linux app can add itself to the application menu from
**Settings → Desktop app → Application menu**. The main process performs one
fixed operation: copy the running AppImage (from the `APPIMAGE` path, never
the temporary mount) to `$XDG_DATA_HOME/scope/app/scope.AppImage`, install the
icon, and write a marker-tagged `scope.desktop` entry pointing there. Nothing
uses `sudo`, changes Hyprland or themes, or touches an entry it did not
create; removal deletes only the managed AppImage, icon, and entry while
keeping the library, reports, logs, and saved X login. Re-running the action
replaces the managed copy atomically, which is the manual-update path. Once
integrated, Settings keeps an **Update application-menu copy** action visible.
Quit before opening a new download; after updating, quit and launch from the menu.
Integration detects both the extraction environment switch and the runtime's
`appimage_extracted_*` directory, and writes `--appimage-extract-and-run` into
the entry when needed. The entry uses a fixed `sh -c` program with the managed
path passed as a positional argument, never interpolated as shell code. This
supports desktop-launcher handling of percent signs and equals signs as well
as the two escaping layers required by the
[Desktop Entry Specification](https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html).
Linux desktop tests require `desktop-file-validate` and `/usr/bin/python3` with
PyGObject (`desktop-file-utils`, `python3-gi`, `gir1.2-glib-2.0` on Ubuntu).
These are maintainer test dependencies, not application runtime dependencies.
User instructions live in [linux-install.md](linux-install.md).

## Build a Windows installer

Build the Windows artifact on an x86-64 Windows machine:

```powershell
npm ci
npm ci --prefix desktop
npm run desktop:dist:windows
```

The result is `desktop\dist\scope-0.1.0-windows-x64-setup.exe`, a per-user NSIS
installer with a selectable installation directory, Start menu entry, optional
desktop shortcut, and an uninstaller. Ordinary installation goes to
`%LOCALAPPDATA%\Programs\scope` and never requests administrator rights;
elevation is disabled, so the installer cannot switch to a per-machine install.
The desktop shortcut is created on first install only, so a user who removes it
will not have it recreated by an upgrade. Uninstall keeps the database,
reports, and logs in `%LOCALAPPDATA%\scope`; see
[windows-install.md](windows-install.md) for user instructions.

Native Windows verification is pending. These are the configured behaviors;
the progress file records which checks have actually run. A hosted runner does
not establish standard-user UAC UX or a clean-machine minimum Windows version.

## Build a macOS Apple Silicon DMG

Build the arm64 Mac artifact on an Apple Silicon Mac (CI uses macOS 15;
macOS 13 is only the candidate minimum until native verification passes):

```bash
npm ci
npm ci --prefix desktop
npm run desktop:dist:mac
```

The result is `desktop/dist/scope-0.1.0-macos-arm64.dmg`. CI builds it on the
`macos-15` runner and asserts `uname -m` is `arm64` before doing any work, so a
mislabeled Intel runner fails instead of producing a wrong-architecture
artifact. The X worker and the SQLite native module are built natively; there
is no cross-compilation. Intel x64 is a separate download built on Intel
hardware (see below), not a universal bundle.

`desktop:dist:mac` runs `verify:mac`, which checks:

- the app bundle uses the `Contents/Resources` layout (server, SQLite prebuild,
  bundled `yt-dlp`, X worker, `icon.icns`);
- every bundled native component matches the target architecture and reports a
  Mach-O minimum
  macOS no higher than the candidate `mac.minimumSystemVersion` (13.0).
  This includes SQLite, every loose native library, and the Python/extensions
  inside the worker and yt-dlp onefile archives. Headers do not replace testing
  on the advertised minimum OS;
- `Info.plist` carries the stable bundle id `com.scope.desktop`, the package
  version, and the declared minimum system version;
- the DMG has the versioned name, passes `hdiutil verify`, and mounts with
  `scope.app` plus the `/Applications` shortcut;
- the signature of the app and the nested `yt-dlp`/X worker matches the
  declared mode: Developer ID + hardened runtime + stapled notarization ticket
  - Gatekeeper acceptance for release builds, ad-hoc for engineering builds.

`npm --prefix desktop run smoke -- --minimal-path` runs the full packaged smoke
suite against `desktop/dist/mac-arm64/scope.app/Contents/MacOS/scope` with an
empty `PATH`, proving a Finder-style launch needs no system Node, Python, `uv`,
or `yt-dlp`. The CLI equivalent for a clean-Mac check is
`open desktop/dist/mac-arm64/scope.app`.

## Build a macOS Intel DMG

Build the x64 Mac artifact on an Intel Mac (CI uses `macos-15-intel`). Set the
explicit target so a mixed-architecture checkout cannot reuse Apple Silicon
output:

```sh
SCOPE_DESKTOP_TARGET_PLATFORM=darwin SCOPE_DESKTOP_TARGET_ARCH=x64 \
  npm run desktop:dist:mac:x64
```

The result is `desktop/dist/scope-0.1.0-macos-x64.dmg`. CI builds it on the
`macos-15-intel` runner and asserts `uname -m` is `x86_64` before doing any
work. `macos-15-intel` is GitHub's last hosted x86_64 macOS image and is
scheduled for retirement in August 2027; after that date this job needs a
self-hosted Intel Mac runner. The Intel target is a required release output and
is never silently dropped.

The Intel build uses the same app identity (`com.scope.desktop`), data paths,
`Contents/Resources` layout, DMG drag-to-Applications flow, signing secrets, and
`verify:mac` checks as the Apple Silicon build. Fresh x64 SQLite prebuilds and a
fresh x64 X worker are produced on the Intel host; `verify:artifacts` and
`verify:mac` reject an arm64 worker, an arm64-only Mach-O, or a missing
`darwin-x64` SQLite prebuild left over from an Apple Silicon build. The bundled
`yt-dlp` is the pinned universal2 asset, so the same checksum-verified download
serves both architectures; its x64 slice minimum macOS is logged at fetch time.

Smoke-testing the Intel package:

```sh
SCOPE_DESKTOP_TARGET_PLATFORM=darwin SCOPE_DESKTOP_TARGET_ARCH=x64 \
  npm --prefix desktop run smoke -- --minimal-path
```

which runs against `desktop/dist/mac/scope.app/Contents/MacOS/scope`.
electron-builder omits the directory suffix for x64; Apple Silicon uses
`desktop/dist/mac-arm64`. The Intel DMG name still includes `macos-x64`.

### macOS code signing and notarization

Signing uses CI secrets only; certificates, passwords, and Apple credentials
are never committed.

| Secret                                                  | Purpose                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `MAC_CSC_LINK` / `CSC_LINK`                             | Base64 or path to the Developer ID `.p12`                   |
| `MAC_CSC_KEY_PASSWORD` / `CSC_KEY_PASSWORD`             | Certificate password                                        |
| `MAC_CSC_NAME` / `CSC_NAME`                             | Optional identity already installed in the signing keychain |
| `APPLE_ID`                                              | Apple account for notarization                              |
| `APPLE_APP_SPECIFIC_PASSWORD`                           | App-specific password for that account                      |
| `APPLE_TEAM_ID`                                         | Developer team id                                           |
| Repository variable `SCOPE_DESKTOP_MAC_REQUIRE_SIGNING` | `1` fails the build without credentials                     |

The API-key form (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) and
an `APPLE_KEYCHAIN_PROFILE` are also supported. `mac-signing.cjs` requires a
complete set: a certificate without notarization credentials, notarization
credentials without a certificate, or a partial APPLE set fails the build.
With no secrets the build is the explicit **ad-hoc engineering** mode: Apple
Silicon cannot run a completely unsigned binary, so the app is signed with the
ad-hoc identity, is not notarized, and cannot be opened on another Mac. That
mode is for local checks only. Hardened runtime and the narrow entitlements
(`allow-jit`, `allow-unsigned-executable-memory`,
`disable-library-validation` for the packaged native modules; no device
permissions) apply to the Developer ID build. The workflow passes these
secrets only to non-pull-request macOS runs.

Mac aliases are normalized to electron-builder's `CSC_*` environment variables;
certificate material is never placed in the generated effective configuration.
The `sign-mac.cjs` hook receives the builder's resolved identity and temporary
keychain. For Developer ID builds, `mac-frozen.py` signs each native entry inside
both frozen executables, rebuilds their PKG archives without changing Python
bytecode/version/options, and repairs the Mach-O lengths using the pinned
PyInstaller build environment. Electron then signs the outer binaries and app
and performs notarization. Only copies inside the `.app` change; downloaded
yt-dlp checksums remain intact. `verify:mac` independently extracts the final
payloads and verifies each native signature belongs to the app's Developer ID
team. This custom repackaging path still requires a native signed smoke run.

The clean-Mac checks — browser download, dragging the DMG to Applications,
Gatekeeper on a second Mac, Keychain persistence, and replacing the app with a
newer signed version — still require an owner-provided Mac and Apple
credentials; they are recorded as pending until they run.

`desktop:dist:windows` also runs `desktop/scripts/verify-windows.cjs`, which
verifies the unpacked app and bundled `yt-dlp`/X worker are Windows x64 builds,
that the installer uses the versioned download name, and that the Authenticode
status of both the installer and app matches the declared signing mode.
`npm --prefix desktop run smoke --
--minimal-path` runs the packaged smoke suite with only `System32` on `PATH`,
checking that the unpacked app needs no system Node, Python, `uv`, or `yt-dlp`.
The Claude SDK check initializes an offline fixture and calls `supportedModels()`
through Electron's bundled Node runtime; it does not merely import the SDK.

### Actual installer lifecycle check

Windows CI builds an internal `0.1.0-stage3-baseline` installer, then uses
`desktop/scripts/test-windows-installer.ps1` to install it, launch its real
Start-menu shortcut twice, and run the packaged smoke checks. It upgrades to
`0.1.0`, checks SQLite/report retention and deleted-shortcut preference, then
uninstalls, reinstalls, and restores a closed-app backup. All app runs use only
`System32` on PATH. Logs and `results.json` are uploaded as
`scope-windows-lifecycle-evidence`, including on failure. The internal baseline
is unsigned and is never uploaded as a user download.

For manual execution, use a **fresh disposable Windows account**, build both
versions, and run:

```powershell
npm --prefix desktop run dist:windows -- --config.extraMetadata.version=0.1.0-stage3-baseline --config.directories.output=dist/installer-baseline --publish never
./desktop/scripts/test-windows-installer.ps1 -DisposableAccount -PreviousInstaller desktop/dist/installer-baseline/scope-0.1.0-stage3-baseline-windows-x64-setup.exe -Installer desktop/dist/scope-0.1.0-windows-x64-setup.exe -PreviousVersion 0.1.0-stage3-baseline -Version 0.1.0
```

The harness refuses an existing Scope profile, Start shortcut, desktop shortcut,
or per-user installation. It exercises the real default data directory in that
disposable account. It retains failure evidence and cleans its own profile on
success. Silent per-user installation does not replace a manual check of the
interactive installer, standard-user elevation behavior, or SmartScreen.

### Windows code signing

Signing uses CI secrets only; certificates and passwords are never committed.

| Secret                                                      | Purpose                                  |
| ----------------------------------------------------------- | ---------------------------------------- |
| `WINDOWS_CSC_LINK` / `CSC_LINK`                             | Base64 or path to the `.pfx` certificate |
| `WINDOWS_CSC_KEY_PASSWORD` / `CSC_KEY_PASSWORD`             | Certificate password                     |
| Repository variable `SCOPE_DESKTOP_WINDOWS_REQUIRE_SIGNING` | `1` fails the build without credentials  |

electron-builder signs the app executables and installer automatically when the
certificate variables are present. Without them the build is the explicit
**unsigned friends-beta** mode: `windows-signing.cjs` logs the mode, and
`verify:windows` fails if an unsigned build unexpectedly carries a signature or
a signed build does not. The GitHub Actions workflow passes these secrets only
to non-pull-request Windows runs. Pull requests explicitly disable the signing
requirement even if the repository requires signing for trusted builds; they
still run unsigned artifact checks. Signing improves publisher identity but does
not guarantee immediate SmartScreen reputation; warnings can persist until
reputation accumulates. A public release should set the require flag so an
unsigned artifact cannot ship by accident.

Build each installer on its target operating system. In particular, a native
Windows build ensures that all optional and native Node.js dependencies are
resolved for Windows. The included GitHub Actions workflow does exactly this on
separate Linux and Windows runners, runs the Windows provider process-launch
integration tests, verifies the installer, and smoke-tests the unpacked
application with a minimal `PATH` before the installer lifecycle checks and
artifact upload. Offline integration tests cover real Codex/Claude account
processes, model discovery for all three providers (including the real Claude
SDK), and shared chat/report runners. OpenCode's extensionless npm Node entry
is covered explicitly. These use protocol fixtures, not real subscriptions.

## Data locations and isolation

The desktop application deliberately does not use this repository's `data/`
directory:

| Data        | Omarchy/Linux                                     | Windows                        | macOS                                 |
| ----------- | ------------------------------------------------- | ------------------------------ | ------------------------------------- |
| App root    | `$XDG_DATA_HOME/scope`, or `~/.local/share/scope` | `%LOCALAPPDATA%\scope`         | `~/Library/Application Support/scope` |
| Database    | `<app root>/data/localtube.db`                    | `<app root>\data\localtube.db` | `<app root>/data/localtube.db`        |
| Reports     | `<app root>/data/ai-jobs`                         | `<app root>\data\ai-jobs`      | `<app root>/data/ai-jobs`             |
| Desktop log | `<app root>/logs/desktop.log`                     | `<app root>\logs\desktop.log`  | `<app root>/logs/desktop.log`         |

This means the original web project and the desktop project can run side by
side without sharing a port, process, database, report directory, or Chromium
profile. To migrate existing data, close both versions completely, make a
backup, and copy the existing database (including matching `-wal` and `-shm`
files if they exist) into the desktop database location before starting the
desktop app. Keep the backup until the migrated library has been checked.

Set `SCOPE_DESKTOP_USER_DATA` to an absolute path to use a disposable or custom
profile. Existing `SCOPE_DB_PATH` and `SCOPE_AI_JOBS_ROOT` overrides are still
honored when explicitly supplied.

## X session storage

A verified X login is saved as an OS-encrypted, versioned file at
`<app root>/x-session.enc` with `0600` permissions. Saving is the default; the
Settings → X card reports whether the login is saved and offers retry, unlock,
or setup guidance. Storage failures never delete or overwrite a saved login;
only Disconnect clears it.

On Linux, Electron chooses the Chromium password store before the `ready`
event. This desktop host:

- respects an explicit choice in `SCOPE_X_STORAGE_BACKEND` or
  `x-storage.json` in the profile (`gnome_libsecret`/`gnome-libsecret`,
  `kwallet`, `kwallet5`, `kwallet6`, or `auto`);
- leaves KDE sessions to Chromium's own detection;
- otherwise selects `gnome-libsecret` when a freedesktop Secret Service owns
  the session bus. Compositors Chromium does not recognize (for example
  Hyprland) would otherwise fall back to the insecure `basic_text` store.

Each start logs a bounded storage diagnostic (backend, availability, profile
kind, selection source) to `<app root>/logs/desktop.log`; it never contains
cookies or key material. If the Secret Service is missing, Scope explains the
one-time keyring setup instead of silently writing an unprotected session.

## AI command-line tools

`codex`, `opencode`, and `claude` are not bundled because they use each
person's existing installation and credentials. Desktop launches do not
always inherit an interactive shell's `PATH`, so the host also checks common
user locations:

- Linux: `~/.local/bin`, Nix profile, `/usr/local/bin`, `/usr/bin`, `/bin`
- Windows: npm's user bin directory, Scoop shims, WinGet links,
  `%USERPROFILE%\.local\bin`, `%USERPROFILE%\.opencode\bin`,
  `%USERPROFILE%\.codex\bin`, and the normal Node.js program directories
- macOS: `~/.local/bin`, `/opt/homebrew/bin` (Apple Silicon Homebrew),
  `/usr/local/bin` (Intel Homebrew), `/usr/bin`, `/bin`. A Finder launch does
  not source shell startup files, so Scope adds these locations itself and
  never executes a user's shell profile to discover tools.

On Windows, Node refuses to spawn `.cmd`/`.bat` command wrappers directly, and
Scope never enables a shell for provider commands. The shared resolver therefore
prefers a real `.exe` (in the provider's own install locations or on `PATH`)
and otherwise reads the npm command wrapper and resolves the executable or
JavaScript entry it invokes. A JavaScript entry runs through the resolved Node
executable with the script as one argument; an unresolvable wrapper is reported
as a discovery failure in Settings instead of being treated as an executable.
The same launch description is used for status, sign-in, sign-out, model
discovery, inference, and reports on every platform.

Mise shim directories are never added to the backend `PATH` and are filtered
out even when the launching session provides them, because invoking a shim
for a provider that is not installed makes mise download and install it
(mise's auto-install settings do not stop a shim). The backend also runs with
`MISE_AUTO_INSTALL=false`, `MISE_EXEC_AUTO_INSTALL=false`, and
`MISE_NOT_FOUND_AUTO_INSTALL=false`, so a `mise where`/`which` probe of an
uninstalled provider fails instead of installing it. Claude Code and
OpenCode instead resolve
a mise-managed install to its real binary (`mise where`/`mise which`, which
never install and avoid the shim's shell wrapper); `SCOPE_CLAUDE_PATH`
overrides discovery entirely. Codex uses
`SCOPE_CODEX_PATH` for both sign-in/status (the app-server account protocol)
and inference, and `SCOPE_OPENCODE_BIN` overrides the opencode binary lookup;
all three share one resolver between auth and inference so they always drive
the same installation. No credential file is copied into the app. The child
backend uses the current user's existing provider login in place.

Settings → AI providers also accepts a per-provider executable path when
automatic discovery misses an install. Use an absolute path or a bare command
name; relative paths are rejected because AI jobs run in separate directories.
The value is stored in the local
settings table, takes effect for status, sign-in, model discovery, and AI runs
through the same resolvers, and is passed as a single spawn argument — never
through a shell. Environment overrides (`SCOPE_CODEX_PATH`,
`SCOPE_CLAUDE_PATH`, `SCOPE_OPENCODE_BIN`) still win over the saved value.
Provider installation is separate from Scope: install only the one you want,
and the library and transcripts work without any provider.

## Verification commands

```bash
npm run desktop:test
npm run desktop:prepare
npm run desktop:pack
npm --prefix desktop run smoke
```

`smoke` launches the packaged executable twice against one disposable,
isolated profile. Each run checks authenticated health, rejects an
unauthenticated request, writes and reopens SQLite through the packaged
`better-sqlite3`, runs the bundled `yt-dlp` and frozen X worker, loads the
Claude Agent SDK from the packaged trace, renders the Creator library in a
hidden sandboxed renderer, then loads Settings and verifies the renderer
bridge reports the app version and exposes the Open logs folder action. The
second run proves saved data reopens. Successful runs print
`SCOPE_DESKTOP_SMOKE_OK`, plus `SCOPE_DESKTOP_SMOKE_REOPENED` on the second
run; failures retain the profile, per-run output, and desktop log under a
`scope-desktop-smoke-failure-*` directory in the system temp folder.

Pass `--exe <path>` to smoke-test a specific packaged executable (defaults:
`desktop/dist/linux-unpacked/scope`, `desktop/dist/win-unpacked/scope.exe`, or
`desktop/dist/mac-arm64/scope.app/Contents/MacOS/scope` for Apple Silicon and
`desktop/dist/mac/scope.app/Contents/MacOS/scope` for Intel).
`--minimal-path` runs with an empty `PATH` on Linux and macOS and a
`System32`-only `PATH` on Windows, preserved in the backend and its
subprocesses by a smoke-only flag. Normal desktop launches still add provider
discovery directories. This verifies that the packaged core needs no system
Node, Python, `uv`, or `yt-dlp` and matches a Finder/Start-menu launch.

`--appimage` uses `desktop/dist/scope-<version>-linux-x64.AppImage` as the
executable and additionally clicks through the real Settings buttons for
application-menu install, reinstall, and removal inside the disposable
profile; `--appimage-extract-and-run` exercises the no-FUSE fallback. The
AppImage smoke run keeps the system `PATH` because AppRun is a shell script;
the unpacked `--minimal-path` run above covers the no-system-runtimes claim.
`--check-external-links` points `PATH` at a recording `xdg-open` shim and
asserts that `window.open` on an external URL reaches the system opener
without launching a browser.

Artifact verification also compares the X worker’s source and dependency-lock
hashes and upstream metadata against the current checkout, so an unchanged
binary and matching old metadata cannot pass after its inputs change.

The regular application checks remain available with `npm test`,
`npm run test:integration`, `npm run test:e2e`, `npm run lint`, and
`npm run typecheck`.

## Updating bundled components

- Electron and electron-builder are pinned exactly in `desktop/package.json`.
- The `yt-dlp` release is pinned in `desktop/yt-dlp-version.txt`.
- `npm run desktop:prepare` refuses to package an incomplete standalone server
  or a missing SQLite native module.
- `desktop/scripts/fetch-ytdlp.cjs` reads the official release checksum list and
  rejects a binary whose SHA-256 hash does not match.

There is no automatic updater yet. New releases are built and installed over
the previous version; the data directory remains in place.
