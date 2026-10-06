# Installing Scope on macOS

This guide is for friends downloading Scope from GitHub Releases, not for
building it from source. Scope ships as two clearly labeled Mac downloads — one
per chip architecture. Each is a single DMG file; you do not need Node.js,
Python, or a source checkout.

| Download                                                | Who it is for                    |
| ------------------------------------------------------- | -------------------------------- |
| **Mac — Apple Silicon** `scope-VERSION-macos-arm64.dmg` | Macs with an Apple M-series chip |
| **Mac — Intel** `scope-VERSION-macos-x64.dmg`           | Macs with an Intel processor     |

Both builds are native for their architecture: the Apple Silicon build runs
without Rosetta, and the Intel build runs natively on an Intel Mac. They are
separate downloads, not a universal bundle — pick the one that matches your
chip.

**macOS 13 (Ventura) is the candidate minimum for both, not yet a tested
support guarantee.** Before publishing, each native build must verify every
bundled native library, including the frozen Python payloads, and pass testing
on the advertised minimum OS.

To check which chip your Mac has, open the Apple menu → **About This Mac**:

- "Chip: Apple M…" means Apple Silicon — download **Mac — Apple Silicon**
  (`scope-VERSION-macos-arm64.dmg`).
- "Processor: Intel…" means an Intel Mac — download **Mac — Intel**
  (`scope-VERSION-macos-x64.dmg`).

The other download will not run on your Mac.

## Download and install

1. Download the DMG for your chip from the table above.
2. Open the DMG and drag **Scope** onto the **Applications** shortcut.
3. Eject the mounted disk image, then launch Scope from Applications or
   Launchpad.

The intended release is signed and notarized; a normal first-launch confirmation
may still appear. If macOS shows "Apple could not verify …", stop and report the
artifact/version so its signing can be checked. Do not bypass Gatekeeper for a
build you did not make yourself. Unsigned ad-hoc engineering builds are for
local development and are never published as downloads.

## Using the macOS app

Scope uses the normal macOS application menu and keyboard shortcuts:

- **⌘Q** quits Scope, **⌘W** closes the window, **⌘C/⌘V/⌘X** work in text
  fields, and **About Scope** shows the version.
- Closing the window keeps Scope running in the Dock (the local backend stays
  available). Click the Dock icon to reopen the window; quit from the Dock or
  with **⌘Q** when you are done.

Scope stores its library in
`~/Library/Application Support/scope` (see [Data and backup](#data-and-backup)).

## Updating

There is no automatic updater. To update:

1. Quit Scope completely (**⌘Q**).
2. Download the newer DMG for your chip (the same one you installed).
3. Open it and drag Scope onto **Applications**, replacing the old copy when
   asked.
4. Launch Scope again from Applications.

The app identity is unchanged, so your library, reports, logs, and saved X
login are kept. If macOS refuses to replace the app because it is running,
quit Scope first and repeat the drag.

## Data and backup

| Data          | Location                              |
| ------------- | ------------------------------------- |
| App root      | `~/Library/Application Support/scope` |
| Database      | `<app root>/data/localtube.db`        |
| Reports       | `<app root>/data/ai-jobs`             |
| Desktop log   | `<app root>/logs/desktop.log`         |
| Saved X login | `<app root>/x-session.enc`            |

To back up, quit Scope completely (so SQLite is not writing), then copy the
`data` directory, including any `localtube.db-wal` and `localtube.db-shm` files
next to the database if they exist. The saved X login is encrypted with this
Mac's Keychain and is not a portable backup. To restore, put the copied `data`
directory back while Scope is closed. Downgrading Scope after a newer version
has migrated the database is not supported.

## Keychain and the saved X login

Scope saves an X login as an OS-encrypted file using the macOS Keychain. The
Settings → X card reports whether a protected store is available. If the
Keychain is locked or unavailable, Scope does not silently save a plaintext
login: it explains the one-time unlock and keeps the session for the current
run only. Scope never changes your Keychain configuration.

## AI providers (optional)

Scope ships no AI provider and never installs one. The library, feeds, and
transcripts work without any provider. To use Ask-AI, research, or reports,
install **one** of these separately and sign in with your own account:

- Codex CLI: `curl -fsSL https://chatgpt.com/codex/install.sh | sh`, or
  `brew install --cask codex`
- Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`, or
  `brew install --cask claude-code`
- OpenCode: `curl -fsSL https://opencode.ai/install | bash`, or
  `brew install opencode`

Scope is not started from a terminal, so it does not read your shell startup
files. Instead it searches these locations directly, including both Homebrew
prefixes: `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`,
and `/bin`. On an Apple Silicon Mac, Homebrew installs to `/opt/homebrew/bin`;
on an Intel Mac it installs to `/usr/local/bin`. Scope searches both, so a
Finder launch finds either one. If automatic discovery still misses your
install, use **Set
executable path** on the provider card and enter the absolute path to the
executable. **Check again** then reports the resolved path, so you can confirm
status, sign-in, model listing, and AI runs all use the same one.

Provider installation and login are always separate from Scope. Scope never
sees your tokens or API keys, and AI requests go to the provider you selected
under your account.

## Uninstalling

1. Quit Scope (**⌘Q**).
2. Drag **Scope** from Applications to the Trash.
3. Optionally delete `~/Library/Application Support/scope` to remove the
   library, reports, logs, and saved X login.

There is no installer package or system-wide files to remove; deleting the app
alone never deletes your data.
