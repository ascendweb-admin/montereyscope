#!/bin/bash
set -euo pipefail

cd -- "$(dirname -- "$0")"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "x86_64" ]]; then
  echo "Run this command on an Intel Mac running macOS 12 or newer."
  exit 1
fi
mac_version="$(/usr/bin/sw_vers -productVersion)"
if [[ "${mac_version%%.*}" -lt 12 ]]; then
  echo "This test build targets macOS 12 (Monterey) or newer."
  exit 1
fi
if [[ ! -f MONTEREY_BUILD.json ]]; then
  echo "Run this script from the extracted Monterey source package."
  exit 1
fi
if ! /usr/bin/xcode-select -p >/dev/null 2>&1; then
  echo "Install Apple's Command Line Tools first: xcode-select --install"
  echo "After installation finishes, run this command again."
  exit 1
fi

exec > >(tee "monterey-build.log") 2>&1
trap 'result=$?; if [[ "$result" -ne 0 ]]; then echo "Build stopped. Send monterey-build.log to the person who shared Scope with you."; fi' EXIT

tools="$PWD/desktop/.runtime/monterey-tools"
mkdir -p "$tools/downloads"

# Tools stay inside this copy; no system Node, Homebrew, or shell changes.
download() {
  /usr/bin/curl --proto '=https' --tlsv1.2 --fail --location \
    --retry 3 --connect-timeout 30 --output "$2" "$1"
}
check_download() {
  local actual
  actual="$(/usr/bin/shasum -a 256 "$1")"
  actual="${actual%% *}"
  if [[ "$actual" != "$2" ]]; then
    echo "Download checksum mismatch: $1"
    exit 1
  fi
}

node_version="22.23.3"
node_archive="$tools/downloads/node-v${node_version}-darwin-x64.tar.gz"
node_home="$tools/node-v${node_version}"
if [[ ! -x "$node_home/bin/node" ]]; then
  echo "Downloading local Node.js ${node_version}..."
  download "https://nodejs.org/dist/v${node_version}/node-v${node_version}-darwin-x64.tar.gz" "$node_archive"
  check_download "$node_archive" "8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8"
  mkdir -p "$node_home"
  /usr/bin/tar -xzf "$node_archive" --strip-components=1 -C "$node_home"
fi

uv_version="0.8.22"
uv_archive="$tools/downloads/uv-x86_64-apple-darwin.tar.gz"
uv_home="$tools/uv-${uv_version}"
if [[ ! -x "$uv_home/uv" ]]; then
  echo "Downloading local uv ${uv_version}..."
  download "https://github.com/astral-sh/uv/releases/download/${uv_version}/uv-x86_64-apple-darwin.tar.gz" "$uv_archive"
  check_download "$uv_archive" "76638fdcfa91357858771551a1c88de1f7c3b270b33ab1866f8a0618d9e442d8"
  mkdir -p "$uv_home"
  /usr/bin/tar -xzf "$uv_archive" --strip-components=1 -C "$uv_home"
fi

export PATH="$node_home/bin:$uv_home:$PATH"
export npm_config_cache="$tools/npm-cache"
export UV_CACHE_DIR="$tools/uv-cache"
export UV_PYTHON_INSTALL_DIR="$tools/python"
export UV_PYTHON_PREFERENCE="only-managed"
export UV_NO_CONFIG="1"
export SCOPE_DESKTOP_TARGET_PLATFORM="darwin"
export SCOPE_DESKTOP_TARGET_ARCH="x64"
export MACOSX_DEPLOYMENT_TARGET="12.0"
export SCOPE_NEXT_DIST_DIR=".next"
export NEXT_TELEMETRY_DISABLED="1"

# Never discover or use a certificate, even if the Mac has one installed.
unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME MAC_CSC_LINK MAC_CSC_KEY_PASSWORD MAC_CSC_NAME
unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
unset APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_KEYCHAIN APPLE_KEYCHAIN_PROFILE
export CSC_IDENTITY_AUTO_DISCOVERY="false"
export SCOPE_DESKTOP_MAC_REQUIRE_SIGNING="0"
unset ELECTRON_SKIP_BINARY_DOWNLOAD ELECTRON_MIRROR ELECTRON_CUSTOM_DIR ELECTRON_CUSTOM_FILENAME
export ELECTRON_CACHE="$tools/electron-cache"
export ELECTRON_BUILDER_CACHE="$tools/electron-builder-cache"

echo "Building Scope 0.1.9 for Intel / Monterey with Electron 43.7.7..."
echo "The DMG will be unsigned, unnotarized, and unverified."
npm ci --no-audit --no-fund
npm ci --prefix desktop --no-audit --no-fund

# This command checks build inputs, but deliberately does not run verify:mac
# or launch/test the packaged installer. The recipient will test it himself.
npm run desktop:dist:mac:x64

echo ""
echo "Build finished. Open desktop/dist/scope-0.1.9-macos-x64-monterey-test.dmg"
echo "Drag scope into Applications, then launch it to begin your test."
if [[ "${CI:-}" != "true" ]]; then
  /usr/bin/open "$PWD/desktop/dist"
fi
