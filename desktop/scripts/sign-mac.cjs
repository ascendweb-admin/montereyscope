"use strict";

const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { signAsync } = require("@electron/osx-sign");
const { macSigningPlan } = require("./mac-signing.cjs");
const { frozenExecutables, frozenPython, frozenScript } = require("../lib/mac-native.cjs");

function reportBundleSymlinks(app) {
  const fs = require("node:fs");
  const links = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        const resolved = path.resolve(path.dirname(file), target);
        const outside = !resolved.startsWith(app + path.sep);
        links.push({ file: path.relative(app, file), target, outside, missing: !fs.existsSync(file) });
      } else if (entry.isDirectory()) {
        visit(file);
      }
    }
  };
  visit(app);
  for (const link of links.slice(0, 200)) {
    console.error(`macOS bundle symlink: ${link.file} -> ${link.target} (outside=${link.outside}, missing=${link.missing})`);
  }
  console.error(`macOS bundle symlinks inspected: ${links.length}`);
}

// electron-builder calls this after importing the certificate and resolving its
// identity/keychain, but before notarization. Do not create another keychain or
// pass certificate material to Python. Only mutate copies inside the .app;
// downloaded assets keep their upstream checksums.
exports.sign = async function sign(options) {
  const plan = macSigningPlan();
  if (plan.signed) {
    if (!options.identity || options.identity === "-") {
      throw new Error("Developer ID signing requested without a resolved identity");
    }
    for (const file of frozenExecutables(path.join(options.app, "Contents", "Resources"))) {
      const args = [frozenScript, "sign", file, "--identity", options.identity];
      if (options.keychain) args.push("--keychain", options.keychain);
      execFileSync(frozenPython, args, { stdio: "inherit" });
    }
  }
  try {
    await signAsync(options);
  } catch (error) {
    reportBundleSymlinks(options.app);
    throw error;
  }
};
