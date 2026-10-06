"use strict";

// Next.js output tracing keeps runtime code but usually omits package license
// files. Restore license texts from the exact npm install used to build the
// standalone server and record every package actually present in that trace.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const sourceModules = path.join(root, "node_modules");
const standalone = path.join(root, process.env.SCOPE_NEXT_DIST_DIR || ".next", "standalone");
const targetModules = path.join(standalone, "node_modules");

function licenseFiles(folder) {
  return fs.readdirSync(folder).filter((name) => {
    const file = path.join(folder, name);
    return /^(LICENSE|LICENCE|COPYING|NOTICE)([.-]|$)/i.test(name) && fs.statSync(file).isFile();
  });
}

function prepareNotices(source, target) {
  const rows = [];
  function walk(folder) {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.name === "package.json") {
        const relative = path.relative(target, path.dirname(file));
        const sourceFolder = path.join(source, relative);
        if (!fs.existsSync(sourceFolder))
          throw new Error(`Missing installed source package ${relative}`);
        const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
        const licenses = licenseFiles(sourceFolder);
        for (const name of licenses) {
          if (!fs.existsSync(path.join(path.dirname(file), name))) {
            fs.copyFileSync(path.join(sourceFolder, name), path.join(path.dirname(file), name));
          }
        }
        rows.push({
          name: pkg.name || relative,
          version: pkg.version || "bundled in parent",
          license: pkg.license || "see license text",
          files: licenses.map((name) => path.posix.join(relative.split(path.sep).join("/"), name)),
        });
      }
    }
  }
  if (!fs.existsSync(target)) throw new Error(`Standalone node_modules is missing: ${target}`);
  walk(target);
  rows.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  const lines = [
    "# Bundled Node.js package notices",
    "",
    "This inventory comes from the packages present in the standalone server. License files are copied from the locked npm install used for this build. Packages with no source license file retain their declared license identifier for review.",
    "",
    "| Package | Version | Declared license | Included notice files |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.name} | ${row.version} | ${row.license} | ${row.files.length ? row.files.join(", ") : "No source license file; review declared license"} |`,
    ),
    "",
  ];
  fs.writeFileSync(path.join(path.dirname(target), "THIRD_PARTY_NOTICES.md"), lines.join("\n"));
  return rows;
}

if (require.main === module) {
  try {
    const rows = prepareNotices(sourceModules, targetModules);
    console.log(
      `Bundled notices for ${rows.length} standalone Node.js packages (${rows.filter((row) => row.files.length === 0).length} without source license files).`,
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { prepareNotices };
