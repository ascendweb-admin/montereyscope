"use strict";

const fs = require("node:fs");
const path = require("node:path");

function within(file, directory) {
  return file === directory || file.startsWith(directory + path.sep);
}

// Next's standalone trace can contain absolute links back to its build tree.
// A copied app must own those files before macOS will verify its signature.
function materializeExternalLinks(bundleDirectory, sourceDirectories) {
  const bundle = fs.realpathSync(bundleDirectory);
  const sources = (Array.isArray(sourceDirectories) ? sourceDirectories : [sourceDirectories])
    .map((directory) => fs.realpathSync(directory));
  let replaced = 0;
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        if (within(target, bundle)) continue;
        if (!sources.some((source) => within(target, source))) {
          throw new Error(`Standalone link escapes the build tree: ${path.relative(bundle, file)}`);
        }
        fs.rmSync(file);
        fs.cpSync(target, file, { recursive: true, dereference: true });
        replaced += 1;
        if (fs.statSync(file).isDirectory()) visit(file);
      } else if (entry.isDirectory()) {
        visit(file);
      }
    }
  }
  visit(bundle);
  return replaced;
}

module.exports = { materializeExternalLinks };
