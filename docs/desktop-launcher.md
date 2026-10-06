# Stage 7 — Desktop-style launching on Omarchy

scope stays a local web app, but stage 7 lets you open it like a desktop
application: one launcher action starts (or reuses) the production server on
**127.0.0.1:3000**, waits for it to be ready, and opens the dashboard in your
browser — in **app mode** when your browser supports it. No Electron, no
Tauri, no services, no autostart: everything is opt-in scripts inside this
repository.

## What gets added where

| Path                                 | Purpose                                              |
| ------------------------------------ | ---------------------------------------------------- |
| `scripts/launch`                     | Start server if needed + open browser                |
| `scripts/server status` / `stop`     | Report / stop the launcher-managed server            |
| `packaging/scope.desktop`            | Sample freedesktop entry (template with placeholder) |
| `packaging/install-desktop-entry.sh` | Installs/uninstalls the entry user-locally           |
| `logs/launcher.log`                  | Non-sensitive launcher/server log (git-ignored)      |
| `data/run/localtube.pid`             | PID of the launcher-managed server (git-ignored)     |

Nothing outside the repository is touched until you explicitly run the
desktop-entry installer. `/usr/share/omarchy` is never modified.

## Option A — manual launch

```bash
./scripts/launch          # start if needed + open browser
./scripts/server status   # what is running?
./scripts/server stop     # stop the tracked server
```

The first run builds the production bundle once (`npm run build`) if missing.
Later runs reuse a healthy server instead of starting duplicates. The
database is created/migrated automatically: reaching readiness proves
migrations ran, because `/api/health` opens (and migrates) the database
before responding.

Useful environment overrides:

- `SCOPE_BROWSER=/path/to/browser` — force a specific browser
  (`SCOPE_BROWSER=none` skips opening anything)
- `SCOPE_LAUNCH_TIMEOUT=60` — readiness wait in seconds

## Option B — desktop-like entry (requires your approval to install)

1. Review what will be written:

   ```bash
   cat packaging/scope.desktop
   ```

2. Install it into your **user-local** applications directory only:

   ```bash
   ./packaging/install-desktop-entry.sh
   ```

   This resolves `@PROJECT_ROOT@` to the absolute project path at install
   time and writes `~/.local/share/applications/scope.desktop`. Nothing
   else changes; there is no autostart, keybinding, or window rule.

3. Launch scope from your normal Omarchy app launcher/menu. Optionally
   pin it through that UI (right-click → pin, or drag from the app grid) —
   whatever the current Omarchy shell supports.

### Uninstall

```bash
./packaging/install-desktop-entry.sh --uninstall
./scripts/server stop        # if a server is still running
```

Then optionally delete runtime artifacts: `rm -rf logs data/run`.

## How browser choice works

`scripts/launch` asks `xdg-settings get default-web-browser` (the same
source Omarchy's `omarchy default browser` configures), resolves its
`Exec=` from the desktop file, and:

- launches `<browser> --app=http://127.0.0.1:3000` for Chromium-family
  browsers (Chrome, Chromium, Brave, Edge, Vivaldi, Opera, Helium), giving a
  clean window without tabs or the address bar;
- falls back to opening the URL normally (`xdg-open`) for browsers without
  app mode — Firefox removed `--app` support in 2016-era versions (Firefox
  49+), so it always uses the fallback;
- never fails the launch because of browser problems: if no opener can be
  found it prints the URL so you can open it yourself.

Two behaviors worth knowing:

- **Version-managed Node**: desktop-launched apps may not inherit your
  terminal's `PATH`. If `node` comes from a version manager (mise, nix), the
  launcher re-adds those shim directories automatically; if none is found it
  exits with instructions instead of failing silently.
- **Repeat launches**: each launch opens a fresh app window rather than
  focusing an existing one (browsers key windows by profile, not URL). Close
  extra windows normally — they are all views of the same local server.

## Logs

`logs/launcher.log` (rotated at ~1 MiB to `launcher.log.old`) records
timestamps of launch requests, build attempts, server PIDs, readiness
results, and stop/refusal events. It contains **no private data**: no
database contents, no cookies, no URLs beyond `http://127.0.0.1:3000`.
Delete the file anytime; it is recreated.

## Safety properties

- The server binds to `127.0.0.1` only — never LAN, never exposed.
- Repeated launches never spawn duplicate servers (readiness probe first).
- `stop` signals **only** the exact PID recorded in `data/run/localtube.pid`,
  and only after verifying via `/proc` that the PID currently belongs to this
  project's `next start` process. PID reuse, foreign processes, and
  name/port-based kills are all refused.
- Stopping the server (or closing the app-mode window) cannot corrupt the
  SQLite database: WAL mode plus transactional migrations keep the file
  consistent across ungraceful exits.
- yt-dlp runs only while a requested job executes — the launcher never
  starts background extraction.

## Troubleshooting

| Symptom                                | Fix                                                                   |
| -------------------------------------- | --------------------------------------------------------------------- |
| "Next.js binary not found"             | Run `npm install` in the project root                                 |
| Build fails during first launch        | Read the printed log tail / `logs/launcher.log`; fix, then relaunch   |
| "did not become ready within 60s"      | Check `logs/launcher.log`; another app may hold port 3000             |
| Something else already listens on 3000 | Stop that app; scope deliberately uses the fixed loopback port        |
| Status says "unmanaged"                | Server was started by plain `npm start`; Ctrl-C it in its terminal    |
| App-mode window missing                | Your browser lacks `--app`; the URL opens as a normal tab instead     |
| Health shows degraded                  | Install/verify `yt-dlp` (`yt-dlp --version`); see README Requirements |

## Not included (by design)

No autostart, systemd/user services, Hyprland keybindings, or window rules.
If you later want any of these, they are separate opt-in changes to your
user-owned `~/.config` files made only with your explicit approval.
