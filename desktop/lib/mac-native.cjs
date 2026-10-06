"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  readBinaryArchitecture,
  readMachOMinimumOS,
  compareVersionStrings,
} = require("./target.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const frozenPython = path.join(desktopRoot, ".runtime", "x-worker", "venv", "bin", "python");
const frozenScript = path.join(desktopRoot, "scripts", "mac-frozen.py");

function frozenExecutables(resources) {
  return [
    path.join(resources, "bin", "yt-dlp"),
    path.join(resources, "x-worker", "scope-x-worker"),
  ];
}

function nativeFiles(root) {
  const result = [];
  const seen = new Set();
  const boundary = fs.realpathSync(root);
  function visit(file) {
    const real = fs.realpathSync(file);
    if (real !== boundary && !real.startsWith(boundary + path.sep)) {
      throw new Error(`Bundle symlink escapes native inventory: ${file}`);
    }
    if (seen.has(real)) return;
    seen.add(real);
    if (fs.statSync(real).isDirectory()) {
      for (const child of fs.readdirSync(real)) visit(path.join(real, child));
    } else {
      const label = path.relative(boundary, real);
      if (readBinaryArchitecture(real).format === "macho") {
        result.push({ label, file: real });
      } else if ([".node", ".dylib", ".so"].includes(path.extname(real))) {
        throw new Error(`Native dependency is not Mach-O: ${label}`);
      }
    }
  }
  visit(root);
  return result;
}

function nativeMinimum(component, arch, declared) {
  const minimum = readMachOMinimumOS(component.file, arch);
  // For a universal file this also proves that the requested slice exists.
  if (minimum === null) throw new Error(`${component.label}: missing ${arch} Mach-O minimum OS`);
  if (compareVersionStrings(minimum, declared) > 0) {
    throw new Error(`${component.label} requires macOS ${minimum}, above declared ${declared}`);
  }
  return minimum;
}

function collectMacNative(appPath, scratch) {
  const components = nativeFiles(appPath);
  const resources = path.join(appPath, "Contents", "Resources");
  for (const [index, executable] of frozenExecutables(resources).entries()) {
    const entries = JSON.parse(
      execFileSync(
        frozenPython,
        [frozenScript, "extract", executable, "--output", path.join(scratch, String(index))],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      ),
    );
    for (const entry of entries) {
      components.push({
        label: `${path.relative(appPath, executable)} :: ${entry.label}`,
        file: entry.file,
      });
    }
  }
  return components;
}

module.exports = {
  collectMacNative,
  frozenExecutables,
  frozenPython,
  frozenScript,
  nativeFiles,
  nativeMinimum,
};
