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
  listProfileCategoryAssignments,
  replaceCategoryProfiles,
  replaceProfileCategories,
  updateCategory,
} from "@/lib/categories/repository";
import { createCategoryFromInput, setProfileCategoryIds } from "@/lib/categories/service";
import { addCreator, getCreator } from "@/lib/creators/repository";
import { mergeProfiles } from "@/lib/creators/profiles";
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

/** The person a saved account is filed under. */
function profileOf(creatorId: number): number {
  const record = getCreator(db, creatorId);
  if (!record) throw new Error("Creator should exist");
  return record.profileId;
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
    replaceProfileCategories(db, profileOf(creatorId), [finance.id]);

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

    replaceProfileCategories(db, profileOf(alpha), [technology.id, interviews.id]);
    replaceCategoryProfiles(db, interviews.id, [profileOf(alpha), profileOf(beta)]);

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
    replaceProfileCategories(db, profileOf(creatorId), [category.id]);

    expect(deleteCategory(db, category.id)).toBe(true);
    expect(getCreator(db, creatorId)?.displayName).toBe("Safe Creator");
    expect(listCategoriesForCreator(db, creatorId)).toEqual([]);

    const next = createCategory(db, { name: "Second", color: "slate" });
    replaceProfileCategories(db, profileOf(creatorId), [next.id]);
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
    expect(setProfileCategoryIds(db, profileOf(creatorId), [999])).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(setProfileCategoryIds(db, 9999, [])).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(setProfileCategoryIds(db, profileOf(creatorId), ["bad"])).toMatchObject({
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

  it("files categories on the person, so every linked account shares them", () => {
    const markets = createCategory(db, { name: "Markets", color: "emerald" });
    const interviews = createCategory(db, { name: "Interviews", color: "violet" });
    const channel = creator("Jane Doe", "janedoe");
    const clips = creator("Jane Doe Clips", "janedoeclips");
    replaceProfileCategories(db, profileOf(channel), [markets.id]);
    replaceProfileCategories(db, profileOf(clips), [interviews.id]);

    mergeProfiles(db, profileOf(channel), [profileOf(clips)]);

    // Both accounts now carry the union, counted once for the one person.
    expect(listCategoriesForCreator(db, clips).map((category) => category.name)).toEqual([
      "Interviews",
      "Markets",
    ]);
    expect(listCreatorCategoryAssignments(db).get(channel)).toHaveLength(2);
    expect(listProfileCategoryAssignments(db).get(profileOf(channel))).toHaveLength(2);
    expect(listCategories(db).map((category) => category.creatorCount)).toEqual([1, 1]);
  });
});
