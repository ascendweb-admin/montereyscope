# Scope for Intel / macOS 12: private test build

This package is a separate copy of Scope 0.1.9 from commit
`652309da75aafcdfdd9db4428d87fcbbd7b416dd`. It uses **Electron 43.7.7**
and targets **macOS 12 (Monterey), Intel x64**. Its interface and features
come from that source snapshot. The original project retains Electron 44.2.0.

The installer is intentionally **unsigned, unnotarized, and unverified**.
It is for the friend who agreed to test this build. No Apple Developer
account or signing certificate is needed. macOS 12 compatibility is a test
target, not a verified support claim.

## Build on the friend's Mac

1. Unzip the source package into a normal folder, such as Downloads.
2. Install Apple's Command Line Tools if needed. In Terminal, run
   `xcode-select --install`, finish the installation, then continue.
3. Open Terminal in the extracted folder and run:

   ```bash
   bash BUILD-MONTEREY.command
   ```

The first build needs internet access and several GB of free disk space.
It can take a while on a 2017 MacBook Air. The command downloads Node.js
22.23.3 and uv 0.8.22, installs the locked npm dependencies, downloads the
pinned yt-dlp, builds the native X worker, and creates the DMG. Node, uv,
their caches, and Python stay in `desktop/.runtime/monterey-tools` inside
this copy. It does not install Homebrew, replace a system Node installation,
or edit shell settings. Download checksums and build-input checks remain
enabled; the command does not verify or launch the completed installer.

The output folder opens when the build finishes. The installer is:

```text
desktop/dist/scope-0.1.9-macos-x64-monterey-startup-fix.dmg
```

Open the DMG, drag **scope** into **Applications**, eject it, and launch
Scope. You can also double-click `BUILD-MONTEREY.command` instead of running
it from Terminal; if macOS blocks the downloaded command, use Terminal.

## Build from Linux using GitHub Actions

GitHub can supply the Intel Mac used for the build. The included
`.github/workflows/monterey-test.yml` runs only when manually requested and
uses the standard `macos-15-intel` runner. Standard hosted runners are free
for public repositories; private repositories need remaining included usage
or paid usage. See [GitHub's runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

1. Create a separate GitHub repository and upload the contents of this
   extracted source folder, including `.github/workflows/monterey-test.yml`.
   `BUILD-MONTEREY.command` and `package.json` must be at the repository root.
   Uploading only the ZIP does not make the source available to the workflow.
2. For free public builds, make that separate repository public only if you
   are comfortable publishing this source snapshot. It contains the app's
   source code. People can copy or fork it; changing visibility later does
   not recall those copies. This avoids exposing the main repository's Git
   history. For a private build, check remaining minutes and storage first.
3. In the repository's **Actions** tab, select **Monterey Intel test DMG**,
   choose **Run workflow**, and select the branch containing this source.
   The workflow file must exist on the default branch.
4. After the build succeeds, download **scope-monterey-intel-test** under
   **Artifacts** on the run page. Extract the download to get the DMG.
   Download promptly: the artifact is kept for only one day.

The workflow builds this Monterey copy, not the main project's Electron 44
release. A completed cloud build does not verify that the app runs on
Monterey; the friend still needs to test the installer on his Mac.

The current `monterey-startup-fix` installer separates desktop readiness
from the downloader version check. Before uploading it, the cloud workflow
starts the backend using the Electron runtime from the actual app bundle,
checks the database, authenticated startup endpoint, library page, and bundled
downloader, and repeats the test with a deliberately slow downloader. These
checks run on GitHub's macOS 15 Intel host, not on Monterey. They do not
replace a full GUI test on the friend's Mac.

The macOS Claude connection check allows 15 seconds for CLI startup and
30 seconds for the sign-in status check. If the check fails or times out,
Settings shows **Status unavailable** with **Check again**, rather than
asking you to sign in again. A confirmed signed-out response still offers
sign-in. These changes apply only on macOS and never reset Claude credentials.

## Opening an unsigned test app

If macOS blocks first launch because the developer cannot be verified,
Control-click Scope in Applications, choose **Open**, and confirm. On
Monterey, **System Preferences → Security & Privacy → General → Open Anyway**
is another per-app route after attempting to launch it. Do this only for
this agreed private test; no system-wide Gatekeeper change is required.

Apple describes the per-app exception in
[Safely open apps on your Mac](https://support.apple.com/en-us/102445).

## Trying the tool and reporting problems

Try adding a YouTube creator, loading its videos, fetching a transcript,
and copying it. Quit with **⌘Q**, reopen, and check that the library remains.
AI features require a separately installed, compatible provider and the
friend's own login; basic library and transcript features do not.

If the build fails, send `monterey-build.log` from the source folder. If
the app fails, send the macOS version, the visible error, and Scope's log:

```text
~/Library/Application Support/scope/logs/desktop.log
```

Scope's normal data directory is used on this Mac. If Scope is already
installed, quit it and back up `~/Library/Application Support/scope` before
trying this build. This source package contains no library database,
personal settings, accounts, or credentials from the sender.

## What differs from the original source

- Electron is pinned to 43.7.7 in the desktop manifest, lockfile, and builder.
- The Intel target and app bundle declare a candidate minimum macOS of 12.0.
- macOS signing and notarization are disabled in this copy's builder config.
- The Intel packaging command omits the completed-installer verification.
- The output name includes `monterey-test` to distinguish the DMG.
- This guide, build script, and `MONTEREY_BUILD.json` record the test profile.

All changes are confined to this source copy. The normal four-platform
release instructions elsewhere in this snapshot describe the original
project and are not the instructions for this private build.
