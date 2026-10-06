# X authentication feasibility

Updated 2026-09-18.

## Implemented

- Electron owns an isolated, in-memory X session and a sandboxed sign-in window.
  The renderer receives only connection status and a verified identity through
  a narrow preload bridge. The backend uses a token-protected loopback broker.
- Cookies reach the worker through stdin only. The verified session is saved by
  `desktop/lib/x-session-store.cjs` as a versioned, validated, OS-encrypted file
  (`x-session.enc`) with restrictive permissions and atomic replacement. The old
  raw cookie-array format is read and migrated only after a successful validated
  rewrite; storage failures never delete or overwrite an existing saved login.
  Disconnect is the only operation that clears it.
- Session persistence is tracked separately from the X connection
  (`checking`, `saved`, `locked`, `unavailable`, `save_failed`, `delete_failed`, `unreadable`,
  `not_saved`). A verified session stays usable when saving fails, and a narrow
  `retry-storage` bridge operation retries storage without another X sign-in.
  Valid session-cookie updates received while connected are saved after a
  debounce.
- The read-only adapter pins `public-clis/twitter-cli` commit
  `7c634e0d396b1e7af9f63315b414925fe4f29ae7` (0.8.6, Apache-2.0).
  It implements identity verification, public user lookup, bounded user timelines,
  and individual post reads. Posting, liking, following, private feeds and browser
  cookie extraction are not exposed.
- CI builds a frozen executable on Linux and Windows using a hash-locked Python
  environment. Packaging includes the executable outside asar, dependency license
  notices, the upstream license, and source/lock/executable hashes in `build.json`.
  Installed apps do not invoke Python or download a worker at runtime.

## Linux protected-storage root cause

On Omarchy/Hyprland, Chromium does not recognize the compositor and Electron
44.2.0 auto-selects the insecure `basic_text` password store, so
`safeStorage.isEncryptionAvailable()` is false. This was measured directly, not
inferred: `gnome-keyring` held `org.freedesktop.secrets` on the session bus, so
the service was present and the failure was backend selection, not a missing
keyring. The startup log originally read
`{"backend":"basic_text","protected":false,"available":false}`.

`desktop/lib/x-storage-policy.cjs` now selects a supported backend before the
`ready` event: an explicit supported choice wins (`SCOPE_X_STORAGE_BACKEND` or
`x-storage.json` in the profile), KDE sessions keep Chromium's own detection,
and otherwise a reachable freedesktop Secret Service selects
`--password-store=gnome-libsecret`. Chromium spells that switch value with a
hyphen even though Electron reports the backend as `gnome_libsecret`; using the
Electron spelling silently fell back to `basic_text`. Each startup logs a
bounded diagnostic (platform, Electron version, backend, availability, profile
kind, selection source, failure reason) and no credential material.

## Evidence and remaining verification

- Follow-up regression fixes cancel the login deadline after verification,
  refresh the worker's in-memory credentials when cookies change, and expose
  saved-session retry after a temporary startup network failure. Failed file
  deletion now reports `delete_failed`, disconnects the active session, and offers
  removal retry rather than claiming the saved login was removed. Until deletion
  succeeds, the UI warns that restarting could restore the retained file.
- A running Secret Service alone is no longer labelled as a locked keyring.
  `basic_text` is reported as an unavailable secure backend; supported but unusable
  services are reported as temporarily unavailable without guessing their lock state.
- Follow-up validation passed 43 desktop tests and 27 targeted application tests,
  typecheck, lint, production build, and the Linux packaged smoke test. Browser
  tests used a temporary database and synthetic broker to exercise offline restore,
  failed deletion, removal retry, and inline recovery without another sign-in.

- Offline tests cover the store (save/load, 0600 permissions, atomic
  replacement, Windows rename retry, legacy migration including its failure
  path, corrupt/truncated files, unavailable storage, plaintext
  rejection, bounded diagnostics) and the connection lifecycle (restore requires
  worker verification, save failure keeps the live connection, retry-storage
  saves without reopening X sign-in, disconnect/restore/cancel/save races,
  debounced cookie updates, broker authentication and operation rejection).
  Component tests cover saved, unsaved, retrying, restoring, and expired states.
- On this Linux desktop the app now logs
  `"backend":"gnome_libsecret","protected":true,"available":true` with
  `switchSource:"secret_service"`. A store probe under the same Electron runtime
  saved a synthetic cookie payload in one process and decrypted it in a second
  process using the same profile and OS keyring; a raw legacy cookie-array file
  migrated to `version: 2` with cookies preserved. The encrypted file contains no
  plaintext cookie values.
- Browser checks with `agent-browser` drove the packaged renderer through
  Settings → X: the card shows `saved`/`not_saved` plus the secure-storage
  diagnostics disclosure, Connect X opens the isolated X window, Cancel returns
  to the verified state without creating a file, and an explicit
  `SCOPE_X_STORAGE_BACKEND=auto` run showed the `unavailable` recovery card and
  the `retry-storage` action without page errors.
- The production Next build, `desktop:prepare` worker build, `desktop:pack`, and
  the packaged smoke test all passed. The packaged build logged the same
  `gnome_libsecret`/protected diagnostic and loaded its bundled X worker.
- Live X sign-in restore across a real restart still requires the user's X
  account and is the remaining release check on Linux: sign in, observe Saved,
  quit all Scope processes, reopen the same profile, and confirm the same
  account returns without X sign-in. Lock/keyring recovery on a real locked
  keyring, desktop logout/reboot, packaged upgrade, and Windows DPAPI
  persistence also remain manual release checks.
- Live long-note fidelity, multi-page cursor continuity, challenges, rate
  limiting, and installed Windows operation remain release checks. Passing
  offline tests does not remove them.

## Development

`SCOPE_X_FAKE_PROVIDER=1 npm run dev` enables explicitly labelled offline fixtures
only outside production. `npm run desktop:prepare` builds the standalone app and
worker; `npm --prefix desktop run pack` packages them. Desktop startup disables fake
provider and external-worker overrides. Plain web mode without a desktop broker
keeps cached posts available but cannot initiate real X sign-in.

Development and packaged builds keep separate profiles
(`scope-desktop-dev` and `scope`, or `SCOPE_DESKTOP_USER_DATA`). Session
persistence is only guaranteed within one profile; temporary test profiles are
never imported automatically.
