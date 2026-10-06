# Installing Scope on Windows

This guide is for friends downloading Scope from GitHub Releases, not for
building it from source. The Windows download is a single installer file; you
do not need Node.js, Python, or a source checkout.

The Windows target is **Windows x64**. Native build, installer lifecycle, and
clean-machine verification are still pending; this guide describes the intended
installation flow, not a claim of release readiness. ARM Windows is not part of
the initial release. A tested minimum Windows version has not yet been established.

## Download and install

1. Download `scope-VERSION-windows-x64-setup.exe` from the release.
2. Run the installer. It is a per-user installer: it installs to
   `%LOCALAPPDATA%\Programs\scope` and does **not** ask for administrator
   rights. You can choose a different installation directory. A desktop
   shortcut is created on first install; delete it if you do not want it —
   upgrades will not recreate it. The Start menu entry is always created.
3. Launch Scope from the Start menu (or the desktop shortcut).

Scope stores its library under `%LOCALAPPDATA%\scope` (see
[Data and backup](#data-and-backup)). Uninstalling never deletes that data.

### Unsigned friends-beta builds and SmartScreen

Early builds may be unsigned. Windows SmartScreen can then show an
"unknown publisher" warning on first launch. This is expected for the unsigned
friends-beta mode; the installer and app still run normally after you choose
**More info → Run anyway**. The build log and the release notes state whether
the artifact was signed. Signing improves the publisher identity shown by
Windows, but it does **not** guarantee that SmartScreen warnings disappear
immediately: reputation accumulates over time.

If you are unsure whether a build is signed, check the release notes. A signed
`scope-...-setup.exe` shows a valid Authenticode signature in its file
properties; the release also records the artifact SHA-256 checksum.

## Updating

1. Quit Scope completely by closing its window.
2. Run the newer `scope-VERSION-windows-x64-setup.exe`.
3. Launch Scope from the Start menu again.

The installer upgrades the existing per-user installation in place. Your
library, reports, logs, and saved X login stay in `%LOCALAPPDATA%\scope`.
There is no automatic updater; download each new version manually. Do not
install an older version over a newer one: the database may already have been
migrated forward.

## AI providers (optional)

Scope ships no AI provider and never installs one. The library, feeds, and
transcripts work without any provider. To use Ask-AI, research, or reports,
install **one** of these separately and sign in with your own account. Native
installers are recommended on Windows; npm installs are also supported.

- Codex CLI (standalone installer, recommended):
  `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`
- Claude Code (native installer, recommended):
  `irm https://claude.ai/install.ps1 | iex`
- OpenCode: `scoop install opencode`, or `npm install -g opencode-ai`, or the
  installer from the OpenCode install guide.

Scope searches the common install locations even when launched from the Start
menu (`%APPDATA%\npm`, Scoop shims, WinGet links, `%USERPROFILE%\.local\bin`,
`%USERPROFILE%\.opencode\bin`, `%USERPROFILE%\.codex\bin`, and the Node.js
program directories). Windows does not let programs spawn `.cmd`/`.bat` command
wrappers directly, so Scope resolves an npm wrapper to the real executable or
JavaScript entry it starts — it never enables a shell for provider commands and
never runs a wrapper as a script.

If automatic discovery still misses your install (this can happen with an npm
install or a PATH change made after Scope started), use **Set executable path**
on the provider card and enter the absolute path to the real executable
(`...\claude.exe`, `...\codex.exe`, or `...\opencode.exe`). Restart Scope if a
fresh install still is not found, then choose **Check again**; the card reports
the resolved path so you can confirm status, sign-in, model listing, and AI
runs all use the same one.

Provider installation and login are separate from Scope. Codex and Claude
manage their account credentials through their CLIs. If you connect OpenCode
Go in Scope, Scope saves the key in the local OpenCode credential store. AI
requests go to the provider you selected under your account.

## Data and backup

| Data          | Location                       |
| ------------- | ------------------------------ |
| App root      | `%LOCALAPPDATA%\scope`         |
| Database      | `<app root>\data\localtube.db` |
| Reports       | `<app root>\data\ai-jobs`      |
| Desktop log   | `<app root>\logs\desktop.log`  |
| Saved X login | `<app root>\x-session.enc`     |

To back up, quit Scope completely (so SQLite is not writing), then copy the
`data` directory, including any `localtube.db-wal` and `localtube.db-shm` files
next to the database if they exist. The saved X login is encrypted for this
machine and is not a portable backup. To restore, put the copied `data`
directory back while Scope is closed. Downgrading Scope after a newer version
has migrated the database is not supported.

## Uninstalling

1. Open **Settings → Apps → Installed apps** (or **Add or remove programs**),
   find **scope**, and choose **Uninstall**.
2. The uninstaller removes the application, the Start menu entry, and the
   optional desktop shortcut.
3. Your library, reports, logs, and saved X login remain in
   `%LOCALAPPDATA%\scope`. Delete that directory manually if you want to remove
   them too.

The uninstaller never requests administrator rights and never deletes data as
part of a normal uninstall.
