# Preparing a Scope desktop release

The release process makes a **draft** in this repository. It never publishes
one. Four native builds must pass before assembly: Omarchy Linux x64, Windows
x64, Mac Apple Silicon, and Mac Intel. Internal Actions artifacts expire; the
draft's Release assets are the durable files intended for download after
publication.

## Version and source commit

Use a stable `vX.Y.Z` tag. Both package manifests and both lockfile root
records must carry the same `X.Y.Z` version. From a clean working tree:

```bash
npm version X.Y.Z --no-git-tag-version
npm --prefix desktop version X.Y.Z --no-git-tag-version
npm ci
npm ci --prefix desktop
npm run desktop:test
npm test
npm run lint
npm run typecheck
npm run check:migration
```

Review the version diff, commit it, then tag that exact commit. An annotated
tag is useful for recording the candidate:

The [`workflow_dispatch` release workflow](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)
must already exist on the repository's default branch before GitHub will accept
a manual run, even when `--ref` points to a tag. Merge the release workflow to
`main` first, then dispatch the tag.
The checked-out release source and all four builds still come from the tag's
single commit.

```bash
git tag -a vX.Y.Z -m "Scope X.Y.Z release candidate"
git push origin <release-branch> vX.Y.Z
gh workflow run desktop-release.yml --ref vX.Y.Z -f tag=vX.Y.Z
```

The dispatch **ref must be that same tag**. Preflight checks the tag, checked
out commit, manifests, and lockfiles, and refuses an existing Release for the
tag. Rebuilding a published version with different binaries is prohibited;
make a new version. Drafts are also not silently overwritten.

The build matrix uses `ubuntu-24.04`, `windows-2025`, `macos-15` arm64, and
`macos-15-intel` x64, with Node.js `24.21.0`, uv `0.8.22`, both committed npm
lockfiles, and pinned Electron, electron-builder, and yt-dlp versions. The
macOS Intel hosted runner is scheduled for retirement in August 2027; replace
it with an Intel Mac runner before then. Runner image labels can receive
updates, so the release notes record the exact source commit and artifact
checksums rather than claiming a bit-for-bit reproducible image.

## Signing and draft assembly

The native build matrix runs only when explicitly dispatched or called by the
draft-release workflow; pushing a branch or opening a pull request does not
start hosted platform jobs. The manually dispatched release workflow calls the
matrix with release signing credentials, then a separate assembly job receives
`contents: write` only after every required job passes. The owner currently
requires zero-cost verification, so do not dispatch either workflow.

The Windows build uses `WINDOWS_CSC_LINK` and
`WINDOWS_CSC_KEY_PASSWORD` secrets when configured. Without them it is
explicitly marked `unsigned-friends-beta`. Set repository variable
`SCOPE_DESKTOP_WINDOWS_REQUIRE_SIGNING=1` to prohibit that mode. The Mac builds
use `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`; without them they are
`unsigned-engineering` builds unsuitable for distribution. Set
`SCOPE_DESKTOP_MAC_REQUIRE_SIGNING=1` to require signed and notarized DMGs.
Missing external credentials can be recorded while preparing the workflow,
but an unsigned Mac draft must not be published.

Each platform job runs its tests, target verification, and packaged smoke
checks, then stages its one versioned application file and a manifest with
target, commit, signing mode, and SHA-256. The assembly job rejects missing,
extra, duplicated, corrupt, wrong-version, or mixed-commit outputs. It adds
`SHA256SUMS.txt`, `RELEASE-NOTES.md`, `INSTALL.md`, the three platform install
guides, and `THIRD-PARTY-NOTICES.md`, then creates a draft with these assets.
No `latest/download` link is used because the application filenames include
the version. The release notes link directly to each exact filename.

## Review before publishing

Open the draft through the authenticated Releases interface. Record the
actual downloaded-asset tests in [desktop-release-progress.md](desktop-release-progress.md)
for all four targets, including supported minimum OS versions, provider
checks with opted-in accounts, signing/security prompts, upgrade, and
backup/restore. Review the four artifacts' bundled third-party notices.
Confirm that the draft's commit and `SHA256SUMS.txt` match the files tested.
The owner decides whether an unsigned Windows friends-beta installer is
acceptable. Do not publish an unsigned Mac engineering DMG.

The default destination is this repository's Releases. If this repository is
private, friends need repository access to download the files. A public
distribution repository is a later, separately configured option requiring a
narrowly scoped credential; no private-repository token belongs in the app.
Publication is a separate owner action after the clean-machine checks. The
workflow does not publish automatically. Until the four native jobs and
downloaded-asset checks can run without violating the zero-cost requirement,
there is no four-asset draft and the release is not ready to publish.

Friends can use the attached [Linux](linux-install.md),
[Windows](windows-install.md), or [Mac](macos-install.md) instructions. Updates
are manual: quit Scope; run the new Windows installer, replace Scope in Mac
Applications, or run and reintegrate the new AppImage on Omarchy. The stable app
identity retains each platform's data directory. For a file-copy backup, quit
Scope completely and copy the `data` directory, including any SQLite `-wal`
and `-shm` files. Restore only while Scope is closed. Encrypted X sessions are
bound to the original machine's credential store, and installing an older
executable may not reverse a database migration.
