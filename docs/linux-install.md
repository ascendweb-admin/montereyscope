# Installing Scope on Omarchy Linux

This guide is for friends downloading Scope from GitHub Releases, not for
building it from source. The Linux download is a single AppImage file; you do
not need Node.js, Python, or a source checkout.

Scope for Linux is built and tested for **Omarchy Linux x64** (Arch-based,
current glibc). It is not advertised for every Linux distribution just
because the AppImage format is portable; other distributions may work but are
not validated.

## Download and first run

1. Download `scope-VERSION-linux-x64.AppImage` from the release.
2. Make it executable (some file managers do this when you choose to run it):
   `chmod +x scope-VERSION-linux-x64.AppImage`
3. Launch it by double-clicking, or from a terminal: `./scope-VERSION-linux-x64.AppImage`

Running the AppImage directly does not install anything system-wide and does
not require `sudo`. Scope stores its library under
`~/.local/share/scope` (see [Data and backup](#data-and-backup)).

### If the AppImage does not start

AppImage type-2 files need FUSE 2 (`fuse2` on Arch/Omarchy, usually already
installed). If FUSE is missing you can run the same file without FUSE:

```bash
./scope-VERSION-linux-x64.AppImage --appimage-extract-and-run
```

The extraction fallback is tested in CI and is the supported workaround.
If you add Scope to the application menu from this mode, the menu also uses
extraction, so subsequent launches do not require FUSE.
Never disable Electron's sandbox (`--no-sandbox`) as a way to make Scope
start; that weakens the isolation between the app and your system. If neither
mode starts, collect the log (`~/.local/share/scope/logs/desktop.log`) and
report it.

## Add Scope to the application menu (optional)

Open **Settings → Desktop app → Application menu** and choose **Add to
application menu**. Scope then:

- copies the running AppImage to `~/.local/share/scope/app/scope.AppImage`
  (or `$XDG_DATA_HOME/scope/app/scope.AppImage`);
- installs its icon under `$XDG_DATA_HOME/icons/hicolor/512x512/apps/`; and
- writes a menu entry at `$XDG_DATA_HOME/applications/scope.desktop`.

After that you can delete the downloaded file: the menu launches the managed
copy, and Scope opens with the same library, reports, and saved X login. No
`sudo`, Hyprland, keybinding, or theme changes are involved. If another Scope
menu entry already exists that Scope did not create (for example the legacy
source-tree launcher), Scope refuses to overwrite it and says so; remove the
old entry first.

Choose **Remove from application menu** to delete only the managed AppImage,
icon, and menu entry. Your library, reports, logs, and saved X login are kept.

## Updating

1. Download the newer AppImage and make it executable.
2. Quit the currently running Scope completely, then run the downloaded file
   (with `--appimage-extract-and-run` if needed).
3. Open **Settings → Desktop app → Application menu** and choose **Update
   application-menu copy**.
4. Quit Scope and launch it from the application menu to use the updated copy.

The managed copy is replaced atomically and the menu entry stays the same. If
you did not add Scope to the menu, just run the newer download; you can delete
the older file.

## Keyring and the saved X login

Scope saves an X login as an OS-encrypted file using your system keyring
(Secret Service, for example gnome-keyring on Omarchy). The Settings → X card
reports whether a protected store is available. If the keyring is missing or
locked, Scope does not silently save a plaintext login: it explains the
one-time keyring setup and keeps the session for the current run only. Scope
never changes your keyring configuration.

## AI providers (optional)

Scope ships no AI provider and never installs one. The library, feeds, and
transcripts work without any provider. To use Ask-AI, research, or reports,
install **one** of these separately and sign in with your own account:

- Codex CLI: `curl -fsSL https://chatgpt.com/codex/install.sh | sh`
- Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`
- OpenCode: `curl -fsSL https://opencode.ai/install | bash`

Scope searches `~/.local/bin`, Nix profile, `/usr/local/bin`, `/usr/bin`, and
`/bin` even when launched from the menu, and resolves mise-managed installs
through mise itself (without ever installing or updating a provider). If
automatic discovery still misses your install, use **Set executable path** on
the provider card and enter the absolute path to the executable. **Check
again** then reports the resolved path, so you can confirm status, sign-in,
model listing, and AI runs all use the same one.

Provider installation and login are always separate from Scope. Scope never
sees your tokens or API keys, and AI requests go to the provider you selected
under your account.

## Data and backup

| Data             | Location                                        |
| ---------------- | ----------------------------------------------- |
| App root         | `~/.local/share/scope` (`$XDG_DATA_HOME/scope`) |
| Database         | `<app root>/data/localtube.db`                  |
| Reports          | `<app root>/data/ai-jobs`                       |
| Desktop log      | `<app root>/logs/desktop.log`                   |
| Saved X login    | `<app root>/x-session.enc`                      |
| Managed AppImage | `<app root>/app/scope.AppImage`                 |

To back up, quit Scope completely (so SQLite is not writing), then copy the
`data` directory, including any `localtube.db-wal` and `localtube.db-shm`
files next to the database if they exist. The saved X login is encrypted with
this machine's keyring and is not a portable backup. To restore, put the
copied `data` directory back while Scope is closed. Downgrading Scope after a
newer version has migrated the database is not supported.

## Uninstalling

1. Open **Settings → Desktop app → Application menu** and choose **Remove
   from application menu** (if you added it).
2. Delete the downloaded AppImage.
3. Optionally delete `~/.local/share/scope` to remove the library, reports,
   logs, and saved X login. Deleting the managed AppImage alone never deletes
   your data.

There is no system package to uninstall and no system-wide files to remove.
The legacy source-tree launcher (`packaging/install-desktop-entry.sh`) is a
separate, older integration; uninstall it with
`packaging/install-desktop-entry.sh --uninstall`.
