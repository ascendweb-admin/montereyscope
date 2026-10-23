# Scope Intel Monterey build

Built from scope-desktop local main `16bdd44eb93b03d71a8b4225bd8c5d993b7e3cd2`. The application source is unchanged.

This separate packaging copy uses the existing Electron 43.7.7 Monterey profile,
macOS 12.0 minimum, Node.js 22.23.3 build tools, and an unsigned, unnotarized DMG.
The main source checkout is not modified.

Output: `desktop/dist/scope-0.1.9-macos-x64-monterey-main-16bdd44.dmg`.

The manual Monterey workflow checks native dependency deployment targets, the
actual packaged backend, disk image integrity, and a SHA-256 checksum on a
macOS 15 Intel runner. A successful build does not prove it runs on Monterey.
The recipient must test it on their Intel Mac running macOS 12.

Build locally on an Intel Mac with `bash BUILD-MONTEREY.command`, or run the
Monterey Intel test DMG workflow in this existing public build repository.

For this trusted unsigned build, first launch may require Control-click → Open
or System Preferences → Security & Privacy → General → Open Anyway.
No system-wide security changes are needed.
