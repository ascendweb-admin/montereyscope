# Stage 7 handoff — 2026-09-23

This is a historical pause checkpoint. See
[desktop-release-readiness.md](desktop-release-readiness.md) for the current
zero-cost decision.

Work paused at the owner's request. No Release has been published and no draft
exists yet.

- The original `main` is preserved on remote branch
  `main-backup-2026-09-22` at `4a697a0424596b51b620547fddc38800b32fc368`.
- Remote `main` and tag `v0.1.8` point to
  `137ad62ddf605c1574b235b55ec58c33b8335e26`.
- The v0.1.8 [native release run](https://github.com/ascendweb-admin/scope-desktop/actions/runs/35791540775)
  was canceled on request after Linux passed. Apple Silicon built and verified
  its DMG but timed out during packaged smoke. Windows had passed its unit
  suite and was preparing the runtime; Intel was preparing the runtime. Their
  remaining gates were not completed in that run.
- Both Mac architectures in v0.1.7 timed out shortly after logging startup.
  In v0.1.8, Apple Silicon logged successful menu, window, and loopback setup,
  then timed out before the X storage diagnostic. This points to the renderer
  session or synchronous native storage probe. It is not yet a confirmed cause.
- The paused source change defers the macOS native storage probe at startup,
  where Keychain can synchronously prompt, and logs when renderer session
  setup completes. Desktop tests pass locally (125); this change has not had a
  native Mac smoke run. It needs a new version, clean commit, tag, and all four
  native jobs before it can become a release candidate.

The Windows v0.1.6 installer lifecycle was stopped by a missing registry path
on a fresh runner; v0.1.7 guarded that lookup but failed earlier on a slow unit
test setup hook. v0.1.8 passed that unit suite but was canceled before its
installer lifecycle ran. Keep the lifecycle gate enabled on the next run.

After resuming, inspect the latest job results and local diff, rerun the test
gates, bump both manifests and lockfiles to the next version, tag the exact
clean commit, and dispatch `desktop-release.yml` on the tag. Once all four
jobs pass, download the draft assets through the authenticated Release
interface, record their checksums, and finish
[desktop-release-readiness.md](desktop-release-readiness.md). Physical Windows
and Mac checks, real account checks, and Apple signing/notarization remain
open; leave the Release as a draft.
