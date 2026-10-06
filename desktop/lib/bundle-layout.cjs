"use strict";

/**
 * Packaged bundle layout helpers shared by the electron-builder config and the
 * verification scripts. macOS app bundles keep their resources under
 * `.app/Contents/Resources`; Linux and Windows use a sibling `resources`
 * directory next to the executable.
 */

const path = require("node:path");

function packagedMacAppPath(distRoot, arch) {
  if (!["x64", "arm64"].includes(arch)) {
    throw new Error(`Unsupported macOS package architecture: ${arch}`);
  }
  // electron-builder omits the suffix for its default architecture (x64).
  return path.join(distRoot, arch === "x64" ? "mac" : "mac-arm64", "scope.app");
}

function packagedResourcesDirectory(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
      "Resources",
    );
  }
  return path.join(context.appOutDir, "resources");
}

module.exports = { packagedMacAppPath, packagedResourcesDirectory };
