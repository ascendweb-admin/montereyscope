#!/usr/bin/env bash
# Install (or uninstall) a user-local desktop entry for scope.
#
#   packaging/install-desktop-entry.sh             install
#   packaging/install-desktop-entry.sh --uninstall remove
#
# The entry is written ONLY to your user applications directory
# (${XDG_DATA_HOME:-$HOME/.local/share}/applications). It never modifies
# system files, /usr/share/omarchy, or autostart configuration. After
# installing, pin it to your dock/menu through the normal Omarchy UI if you
# want it pinned.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
TEMPLATE="${SCRIPT_DIR}/scope.desktop"
TARGET_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
TARGET="${TARGET_DIR}/scope.desktop"

mode="${1:-install}"
case $mode in
  -h | --help)
    printf 'Usage: %s [--uninstall]\n' "$0"
    exit 0
    ;;
  install | --uninstall) ;;
  *)
    printf 'Unknown argument: %s\n' "$mode" >&2
    exit 64
    ;;
esac

if [ "$mode" = "--uninstall" ]; then
  if [ -f "$TARGET" ]; then
    rm -f "$TARGET"
    command -v update-desktop-database >/dev/null 2>&1 &&
      update-desktop-database "$TARGET_DIR" 2>/dev/null || true
    printf 'Removed %s\n' "$TARGET"
    printf 'If you pinned it, unpin via the normal Omarchy UI.\n'
  else
    printf 'No desktop entry at %s — nothing to uninstall.\n' "$TARGET"
  fi
  exit 0
fi

# --- install ----------------------------------------------------------------

[ -f "$TEMPLATE" ] || {
  printf 'Error: template not found at %s\n' "$TEMPLATE" >&2
  exit 1
}
[ -x "${ROOT}/scripts/launch" ] || {
  printf 'Error: %s/scripts/launch is missing or not executable.\n' "$ROOT" >&2
  exit 1
}
if ! grep -q '@PROJECT_ROOT@' "$TEMPLATE"; then
  printf 'Error: template has no @PROJECT_ROOT@ placeholder; refusing.\n' >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

sed "s|@PROJECT_ROOT@|${ROOT}|g" "$TEMPLATE" >"$TARGET"

command -v update-desktop-database >/dev/null 2>&1 &&
  update-desktop-database "$TARGET_DIR" 2>/dev/null || true

printf 'Installed: %s\n' "$TARGET"
printf 'Exec resolved to: %s/scripts/launch\n' "$ROOT"
printf 'Uninstall anytime with: packaging/install-desktop-entry.sh --uninstall\n'
