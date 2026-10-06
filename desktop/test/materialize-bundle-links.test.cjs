"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { materializeExternalLinks } = require("../lib/materialize-bundle-links.cjs");

const posixTest = process.platform === "win32" ? test.skip : test;

posixTest("materializes a traced absolute link inside the bundle", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-bundle-links-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "standalone");
  const bundle = path.join(root, "app-server");
  fs.mkdirSync(path.join(source, "node_modules", "better-sqlite3"), { recursive: true });
  fs.mkdirSync(path.join(bundle, ".next", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(source, "node_modules", "better-sqlite3", "package.json"), "{}");
  const link = path.join(bundle, ".next", "node_modules", "better-sqlite3-trace");
  fs.symlinkSync(path.join(source, "node_modules", "better-sqlite3"), link);

  assert.equal(materializeExternalLinks(bundle, source), 1);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(link, "package.json"), "utf8"), "{}");
});

posixTest("rejects a traced link outside the standalone build tree", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-bundle-links-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "standalone");
  const bundle = path.join(root, "app-server");
  fs.mkdirSync(source);
  fs.mkdirSync(bundle);
  fs.symlinkSync(root, path.join(bundle, "escape"));
  assert.throws(() => materializeExternalLinks(bundle, source), /escapes the build tree/);
});

posixTest("accepts a traced module from the installed dependency tree", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-bundle-links-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "standalone");
  const modules = path.join(root, "node_modules");
  const bundle = path.join(root, "app-server");
  fs.mkdirSync(source);
  fs.mkdirSync(modules);
  fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(modules, "native.node"), "native fixture");
  const link = path.join(bundle, "native.node");
  fs.symlinkSync(path.join(modules, "native.node"), link);
  assert.equal(materializeExternalLinks(bundle, [source, modules]), 1);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(link, "utf8"), "native fixture");
});
