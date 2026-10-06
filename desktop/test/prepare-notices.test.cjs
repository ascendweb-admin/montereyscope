"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { prepareNotices } = require("../scripts/prepare-notices.cjs");

test("standalone notices include each traced package and copy omitted license texts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-notices-test-"));
  try {
    const source = path.join(root, "node_modules");
    const target = path.join(root, ".next", "standalone", "node_modules");
    for (const [name, license, text] of [
      ["@scope/example", "MIT", "Example license"],
      ["no-text", "CC0-1.0", null],
    ]) {
      const sourceDir = path.join(source, name);
      const targetDir = path.join(target, name);
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, "package.json"),
        JSON.stringify({ name, version: "1.0.0", license }),
      );
      if (text) fs.writeFileSync(path.join(sourceDir, "LICENSE"), text);
    }
    const rows = prepareNotices(source, target);
    assert.equal(rows.length, 2);
    assert.equal(
      fs.readFileSync(path.join(target, "@scope/example/LICENSE"), "utf8"),
      "Example license",
    );
    const inventory = fs.readFileSync(
      path.join(root, ".next", "standalone", "THIRD_PARTY_NOTICES.md"),
      "utf8",
    );
    assert.match(inventory, /@scope\/example.*MIT.*@scope\/example\/LICENSE/);
    assert.match(inventory, /no-text.*CC0-1\.0.*No source license file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
