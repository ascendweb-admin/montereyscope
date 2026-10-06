# Desktop bundle notices and review

Scope's desktop download contains more than the application source. Review the
notices in the **actual four packaged artifacts** before publishing a release.
The draft release carries this inventory so missing notices stay visible.

| Component                                                                                           | Shipped notice or license source                                                                                                              | Review status                                                                                                           |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Electron and Chromium                                                                               | `LICENSE.electron.txt` and `LICENSES.chromium.html` at the unpacked application root                                                          | Present in the local Linux package; confirm in Windows and both Mac packages.                                           |
| Next.js standalone server and its npm dependencies, including `better-sqlite3` and Claude Agent SDK | `resources/app-server/THIRD_PARTY_NOTICES.md` inventories each traced package; available source license files are copied into those packages  | Review entries whose installed source package has no license file, and confirm each platform's trace.                   |
| Frozen X worker and Python dependencies                                                             | `resources/x-worker/THIRD_PARTY_NOTICES.txt`, generated from installed Python distributions, plus `TWITTER-CLI-LICENSE`                       | Present in the local Linux package; confirm in all final packages.                                                      |
| yt-dlp standalone binary                                                                            | `resources/licenses/yt-dlp/LICENSE` and `THIRD_PARTY_LICENSES.txt`, fetched from the pinned `2026.08.19` source tag and included in every app | The PyInstaller binaries include GPLv3+ components. Confirm the exact release's notice requirements before publication. |

The four builds use different native libraries and optional npm packages. A
Linux-only notice check is not sufficient for Windows or either Mac chip. The
owner's publication review must inspect each assembled download and resolve
the open items above. A draft with this file is preparation, not a completed
license audit or permission to publish.
