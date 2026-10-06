import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createCategory,
  deleteCategory,
  listCategories,
  listCategoriesForCreator,
  listCreatorCategoryAssignments,
  replaceCategoryCreators,
  replaceCreatorCategories,
  updateCategory,
} from "@/lib/categories/repository";
import { createCategoryFromInput, setCreatorCategoryIds } from "@/lib/categories/service";
import { addCreator, getCreator } from "@/lib/creators/repository";
import { saveResolvedCreator } from "@/lib/creators/service";
import type { ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";

const tempDirs: string[] = [];
let db: ScopeDatabase;

function makeDb(): ScopeDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "localtube-categories-"));
  tempDirs.push(dir);
  const database = new Database(path.join(dir, "test.db"));
  database.pragma("foreign_keys = ON");
  runMigrations(database, ALL_MIGRATIONS);
  return database;
}

function creator(name: string, suffix: string): number {
  return addCreator(db, {
    youtubeChannelId: null,
    handle: suffix,
    displayName: name,
    channelUrl: `https://www.youtube.com/@${suffix}`,
    avatarUrl: null,
  }).creator.id;
}

beforeEach(() => {
  if (db) db.close();
  db = makeDb();
});

afterAll(() => {
  if (db) db.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("creator categories", () => {
  it("creates, lists, and updates categories with creator counts", () => {
    const finance = createCategory(db, { name: "Finance", color: "emerald" });
    const creatorId = creator("A Channel", "a-channel");
    replaceCreatorCategories(db, creatorId, [finance.id]);

    expect(listCategories(db)).toEqual([
      expect.objectContaining({ name: "Finance", color: "emerald", creatorCount: 1 }),
    ]);
    expect(updateCategory(db, finance.id, { name: "Markets", color: "amber" })).toMatchObject({
      name: "Markets",
      color: "amber",
      creatorCount: 1,
    });
  });

  it("supports several categories per creator and several creators per category", () => {
    const technology = createCategory(db, { name: "Technology", color: "sky" });
    const interviews = createCategory(db, { name: "Interviews", color: "violet" });
    const alpha = creator("Alpha", "alpha-channel");
    const beta = creator("Beta", "beta-channel");

    replaceCreatorCategories(db, alpha, [technology.id, interviews.id]);
    replaceCategoryCreators(db, interviews.id, [alpha, beta]);

    expect(listCategoriesForCreator(db, alpha).map((category) => category.name)).toEqual([
      "Interviews",
      "Technology",
    ]);
    expect(listCategoriesForCreator(db, beta).map((category) => category.name)).toEqual([
      "Interviews",
    ]);
    expect(listCreatorCategoryAssignments(db).get(alpha)).toHaveLength(2);
  });

  it("deleting a category preserves creators while deleting a creator cleans membership", () => {
    const category = createCategory(db, { name: "Keep creator", color: "rose" });
    const creatorId = creator("Safe Creator", "safe-creator");
    replaceCreatorCategories(db, creatorId, [category.id]);

    expect(deleteCategory(db, category.id)).toBe(true);
    expect(getCreator(db, creatorId)?.displayName).toBe("Safe Creator");
    expect(listCategoriesForCreator(db, creatorId)).toEqual([]);

    const next = createCategory(db, { name: "Second", color: "slate" });
    replaceCreatorCategories(db, creatorId, [next.id]);
    db.prepare("DELETE FROM creators WHERE id = ?").run(creatorId);
    expect(listCategories(db)[0]?.creatorCount).toBe(0);
  });

  it("validates names, colors, duplicates, and membership ids", () => {
    expect(createCategoryFromInput(db, "", "sky").ok).toBe(false);
    expect(createCategoryFromInput(db, "Valid", "orange").ok).toBe(false);
    expect(createCategoryFromInput(db, "Markets", "amber").ok).toBe(true);
    const duplicate = createCategoryFromInput(db, "markets", "sky");
    expect(duplicate).toMatchObject({ ok: false, error: { code: "duplicate_name" } });

    const creatorId = creator("Alpha", "alpha-category");
    expect(setCreatorCategoryIds(db, creatorId, [999])).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(setCreatorCategoryIds(db, creatorId, ["bad"])).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("categorizes new creators and adds memberships when saving a duplicate", () => {
    const markets = createCategory(db, { name: "Markets", color: "emerald" });
    const interviews = createCategory(db, { name: "Interviews", color: "violet" });
    const payload = {
      youtubeChannelId: "UC1234567890123456789012",
      handle: "market-talk",
      displayName: "Market Talk",
      channelUrl: "https://www.youtube.com/@market-talk",
      avatarUrl: null,
    };

    const created = saveResolvedCreator(db, payload, [markets.id]);
    expect(created).toMatchObject({ ok: true, status: "created" });
    if (!created.ok) throw new Error("Creator should have been saved");
    expect(created.creator.categories.map((category) => category.name)).toEqual(["Markets"]);

    const duplicate = saveResolvedCreator(db, payload, [interviews.id]);
    expect(duplicate).toMatchObject({ ok: true, status: "already_saved" });
    if (!duplicate.ok) throw new Error("Duplicate should have been returned");
    expect(
      listCategoriesForCreator(db, duplicate.creator.id).map((category) => category.name),
    ).toEqual(["Interviews", "Markets"]);
  });
});
