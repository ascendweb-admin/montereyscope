import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createCategory,
  listCategoriesForProfile,
  replaceProfileCategories,
} from "@/lib/categories/repository";
import {
  detachAccountFromInput,
  linkProfilesFromInput,
  listAccountProfileRefs,
  listProfileSummaries,
  removeProfileById,
  renameProfileFromInput,
  setProfileAvatarFromInput,
} from "@/lib/creators/profile-service";
import { resolveCreatorPageTarget } from "@/lib/creators/page-target";
import {
  getProfile,
  identitiesMatch,
  listProfiles,
  moveAccountToProfile,
  normalizeIdentity,
  profilesExist,
} from "@/lib/creators/profiles";
import {
  dismissLinkSuggestion,
  listProfileLinkSuggestions,
} from "@/lib/creators/profile-suggestions";
import { addCreator, getCreator, type CreatorPlatform } from "@/lib/creators/repository";
import type { ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { attachVideoToProfile, listVideoProfileIds } from "@/lib/videos/attribution";

const tempDirs: string[] = [];
let db: ScopeDatabase;

function openDb(): ScopeDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-profiles-"));
  tempDirs.push(dir);
  const database = new Database(path.join(dir, "test.db"));
  database.pragma("foreign_keys = ON");
  return database;
}

function account(
  name: string,
  handle: string,
  platform: CreatorPlatform = "youtube",
  avatarUrl: string | null = null,
): number {
  return addCreator(db, {
    youtubeChannelId: null,
    platformUserId: platform === "x" ? `${handle}-id` : null,
    handle,
    displayName: name,
    channelUrl:
      platform === "x"
        ? `https://x.com/${handle}`
        : platform === "rumble"
          ? `https://rumble.com/c/${handle}`
          : `https://www.youtube.com/@${handle}`,
    avatarUrl,
    platform,
  }).creator.id;
}

function profileOf(creatorId: number): number {
  const record = getCreator(db, creatorId);
  if (!record) throw new Error("Account should exist");
  return record.profileId;
}

beforeEach(() => {
  if (db) db.close();
  db = openDb();
  runMigrations(db, ALL_MIGRATIONS);
});

afterAll(() => {
  if (db) db.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("migration 024", () => {
  it("gives every existing account its own profile and carries categories over", () => {
    db.close();
    db = openDb();
    runMigrations(
      db,
      ALL_MIGRATIONS.filter((migration) => migration.id < "024"),
    );
    db.exec(`
      INSERT INTO creators (id, display_name, channel_url, platform, handle)
        VALUES (4, 'BridgeMind', 'https://www.youtube.com/@bridgemind', 'youtube', 'bridgemind'),
               (107, 'Loomdart', 'https://x.com/loomdart', 'x', 'loomdart');
      INSERT INTO categories (id, name, color) VALUES (1, 'Crypto', 'sky'), (2, 'AI', 'violet');
      INSERT INTO creator_categories (creator_id, category_id) VALUES (4, 1), (4, 2), (107, 1);
    `);

    runMigrations(db, ALL_MIGRATIONS);

    expect(getCreator(db, 4)?.profileId).toBe(4);
    expect(getCreator(db, 107)?.profileId).toBe(107);
    expect(listProfiles(db).map((profile) => [profile.id, profile.displayName])).toEqual([
      [4, "BridgeMind"],
      [107, "Loomdart"],
    ]);
    expect(listCategoriesForProfile(db, 4).map((category) => category.name)).toEqual([
      "AI",
      "Crypto",
    ]);
    expect(listCategoriesForProfile(db, 107).map((category) => category.name)).toEqual(["Crypto"]);
    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    expect(tables).not.toContain("creator_categories");

    // New profiles continue after the backfilled ids.
    const next = account("Newcomer", "newcomer");
    expect(profileOf(next)).toBeGreaterThan(107);
  });

  it("files an account inserted without a profile under a new one named after it", () => {
    db.prepare(
      "INSERT INTO creators (display_name, channel_url, platform) VALUES ('Raw Insert', 'https://www.youtube.com/@raw', 'youtube')",
    ).run();
    const profiles = listProfiles(db);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ displayName: "Raw Insert" });
    expect(profiles[0]?.accounts).toHaveLength(1);
  });

  it("deletes a profile once its last account is removed", () => {
    const id = account("Solo", "solo");
    const profileId = profileOf(id);
    db.prepare("DELETE FROM creators WHERE id = ?").run(id);
    expect(getProfile(db, profileId)).toBeNull();
    const remaining = db
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM creator_profiles")
      .get();
    expect(remaining?.count).toBe(0);
  });
});

describe("linking accounts into one person", () => {
  it("merges people, orders accounts by platform, and unions categories", () => {
    const markets = createCategory(db, { name: "Markets", color: "emerald" });
    const ai = createCategory(db, { name: "AI", color: "violet" });
    const x = account("Jane", "jane", "x", "https://pbs.twimg.com/jane.jpg");
    const youtube = account("Jane Doe", "janedoe", "youtube");
    const rumble = account("Jane Doe", "janedoe", "rumble");
    replaceProfileCategories(db, profileOf(youtube), [markets.id]);
    replaceProfileCategories(db, profileOf(x), [ai.id]);

    const target = profileOf(youtube);
    expect(linkProfilesFromInput(db, target, [profileOf(x), profileOf(rumble)])).toEqual({
      ok: true,
      linkedCount: 2,
    });

    const [person] = listProfileSummaries(db);
    expect(listProfileSummaries(db)).toHaveLength(1);
    expect(person).toMatchObject({ id: target, displayName: "Jane Doe" });
    expect(person?.accounts.map((entry) => entry.platform)).toEqual(["youtube", "rumble", "x"]);
    expect(person?.categories.map((category) => category.name)).toEqual(["AI", "Markets"]);
    // The only account with an avatar represents the person.
    expect(person).toMatchObject({
      avatarUrl: "https://pbs.twimg.com/jane.jpg",
      avatarCreatorId: x,
    });

    const refs = listAccountProfileRefs(db);
    expect(refs.get(x)).toMatchObject({
      profileId: target,
      profileName: "Jane Doe",
      accountCount: 3,
    });
  });

  it("rejects invalid or unknown link requests", () => {
    const a = profileOf(account("A", "aaa"));
    expect(linkProfilesFromInput(db, a, [])).toMatchObject({ ok: false });
    expect(linkProfilesFromInput(db, a, [a])).toMatchObject({ ok: false });
    expect(linkProfilesFromInput(db, a, [999])).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(linkProfilesFromInput(db, "1", [a])).toMatchObject({ ok: false });
  });

  it("detaches an account into its own person with a copy of the categories", () => {
    const markets = createCategory(db, { name: "Markets", color: "emerald" });
    const youtube = account("Jane Doe", "janedoe", "youtube");
    const clips = account("Jane Clips", "janeclips", "youtube");
    const person = profileOf(youtube);
    replaceProfileCategories(db, person, [markets.id]);
    linkProfilesFromInput(db, person, [profileOf(clips)]);

    const detached = detachAccountFromInput(db, clips);
    expect(detached).toMatchObject({ ok: true, previousProfileId: person });
    if (!detached.ok) throw new Error("Detach should succeed");
    expect(getProfile(db, detached.profileId)).toMatchObject({ displayName: "Jane Clips" });
    expect(listCategoriesForProfile(db, detached.profileId)).toHaveLength(1);
    expect(getProfile(db, person)?.accounts.map((entry) => entry.id)).toEqual([youtube]);

    // A lone account has nothing to detach from.
    expect(detachAccountFromInput(db, youtube)).toMatchObject({
      ok: false,
      error: { code: "not_linked" },
    });
  });

  it("moves an already-saved lone account into a person and keeps its categories", () => {
    const ai = createCategory(db, { name: "AI", color: "violet" });
    const youtube = account("Jane Doe", "janedoe", "youtube");
    const x = account("Jane", "jane", "x");
    const loneProfile = profileOf(x);
    replaceProfileCategories(db, loneProfile, [ai.id]);

    moveAccountToProfile(db, x, profileOf(youtube));

    expect(getProfile(db, loneProfile)).toBeNull();
    expect(
      listCategoriesForProfile(db, profileOf(youtube)).map((category) => category.name),
    ).toEqual(["AI"]);
  });

  it("renames, picks an avatar account, and removes a whole person", () => {
    const youtube = account("Jane Doe", "janedoe", "youtube", "https://yt3.ggpht.com/jane");
    const x = account("Jane", "jane", "x", "https://pbs.twimg.com/jane.jpg");
    const person = profileOf(youtube);
    linkProfilesFromInput(db, person, [profileOf(x)]);

    expect(renameProfileFromInput(db, person, "  Jane   Doe  ")).toEqual({
      ok: true,
      displayName: "Jane Doe",
    });
    expect(renameProfileFromInput(db, person, " ")).toMatchObject({ ok: false });
    expect(renameProfileFromInput(db, person, "x".repeat(101))).toMatchObject({ ok: false });

    expect(getProfile(db, person)?.avatarCreatorId).toBe(youtube);
    expect(setProfileAvatarFromInput(db, person, x)).toEqual({ ok: true });
    expect(getProfile(db, person)?.avatarCreatorId).toBe(x);
    const stranger = account("Someone", "someone");
    expect(setProfileAvatarFromInput(db, person, stranger)).toMatchObject({ ok: false });

    expect(removeProfileById(db, person)).toEqual({ ok: true, removedAccounts: 2 });
    expect(getCreator(db, youtube)).toBeNull();
    expect(getCreator(db, x)).toBeNull();
    expect(getProfile(db, person)).toBeNull();
    expect(removeProfileById(db, person)).toMatchObject({ ok: false });
  });
});

describe("identity matching", () => {
  it("normalizes case, accents, and punctuation", () => {
    expect(normalizeIdentity("Jané Doe!")).toBe("janedoe");
    expect(normalizeIdentity("@jane_doe")).toBe("janedoe");
    expect(normalizeIdentity(null)).toBe("");
  });

  it("matches on names or shared handles, never on short keys", () => {
    expect(
      identitiesMatch(
        { displayName: "Jane Doe", handles: ["jane"] },
        { displayName: "J.D.", handles: ["janedoe"] },
      ),
    ).toBe(true);
    expect(
      identitiesMatch(
        { displayName: "Jane Doe", handles: [] },
        { displayName: "JANE DOE", handles: [] },
      ),
    ).toBe(true);
    expect(
      identitiesMatch({ displayName: "Al", handles: ["al"] }, { displayName: "AL", handles: [] }),
    ).toBe(false);
    expect(
      identitiesMatch(
        { displayName: "Jane Doe", handles: ["janedoe"] },
        { displayName: "John Roe", handles: ["johnroe"] },
      ),
    ).toBe(false);
  });
});

describe("link suggestions", () => {
  it("groups people who share a name or handle and points at the fullest one", () => {
    const youtube = account("Jane Doe", "janedoe", "youtube");
    const clips = account("Jane Doe Clips", "janedoeclips", "youtube");
    const x = account("Jane 🇺🇸", "janedoe", "x");
    const rumble = account("JANE DOE", "jd_rumble", "rumble");
    account("Someone Else", "someone", "youtube");
    linkProfilesFromInput(db, profileOf(youtube), [profileOf(clips)]);

    expect(listProfileLinkSuggestions(db)).toEqual([
      {
        targetId: profileOf(youtube),
        profileIds: [profileOf(youtube), profileOf(x), profileOf(rumble)],
      },
    ]);
  });

  it("never suggests a group again once it is marked as different people", () => {
    const youtube = account("Jane Doe", "janedoe", "youtube");
    const x = account("Jane Doe", "janedoe", "x");
    expect(listProfileLinkSuggestions(db)).toHaveLength(1);

    dismissLinkSuggestion(db, [profileOf(youtube), profileOf(x)]);
    expect(listProfileLinkSuggestions(db)).toEqual([]);

    // A third match still surfaces, but never regrouped with the pair the
    // user already said are different people.
    const rumble = account("Jane Doe", "janedoe", "rumble");
    const [suggestion] = listProfileLinkSuggestions(db);
    expect(listProfileLinkSuggestions(db)).toHaveLength(1);
    expect(suggestion).toEqual({
      targetId: profileOf(youtube),
      profileIds: [profileOf(youtube), profileOf(rumble)],
    });
  });
});

describe("source-only hosts", () => {
  /** A channel saved only because a hand-picked video lives on it. */
  function hiddenHost(name: string, handle: string): number {
    return addCreator(db, {
      youtubeChannelId: null,
      handle,
      displayName: name,
      channelUrl: `https://www.youtube.com/@${handle}`,
      avatarUrl: null,
      followed: false,
    }).creator.id;
  }

  function video(creatorId: number, id: string): string {
    db.prepare("INSERT INTO videos (id, creator_id, title, url) VALUES (?, ?, ?, ?)").run(
      id,
      creatorId,
      `Video ${id}`,
      `https://www.youtube.com/watch?v=${id}`,
    );
    return id;
  }

  it("never shows a hidden host's profile as a person", () => {
    const visible = account("Jane Doe", "janedoe");
    // Same name as the visible person, so it would be offered for linking if it were listed.
    const host = hiddenHost("Jane Doe", "janedoehost");
    const hiddenProfile = profileOf(host);

    expect(hiddenProfile).not.toBe(profileOf(visible));
    expect(listProfiles(db).map((profile) => profile.id)).toEqual([profileOf(visible)]);
    expect(getProfile(db, hiddenProfile)).toBeNull();
    expect(listProfileSummaries(db).map((profile) => profile.id)).toEqual([profileOf(visible)]);
    expect(listProfileLinkSuggestions(db)).toEqual([]);
    expect([...listAccountProfileRefs(db).keys()]).toEqual([visible]);
  });

  it("does not count a hidden profile as an existing person", () => {
    const visible = profileOf(account("Jane Doe", "janedoe"));
    const hiddenProfile = profileOf(hiddenHost("Some Host", "somehost"));

    expect(profilesExist(db, [visible])).toBe(true);
    expect(profilesExist(db, [hiddenProfile])).toBe(false);
    expect(profilesExist(db, [visible, hiddenProfile])).toBe(false);
    expect(linkProfilesFromInput(db, visible, [hiddenProfile])).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(linkProfilesFromInput(db, hiddenProfile, [visible])).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(getCreator(db, visible)).not.toBeNull();
  });

  it("treats a hidden profile as not found when removing a person", () => {
    const host = hiddenHost("Some Host", "somehost");
    expect(removeProfileById(db, profileOf(host))).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(getCreator(db, host)).not.toBeNull();
  });

  it("shows a host as a person once it is followed", () => {
    const host = hiddenHost("Some Host", "somehost");
    addCreator(db, {
      youtubeChannelId: null,
      handle: "somehost",
      displayName: "Some Host",
      channelUrl: "https://www.youtube.com/@somehost",
      avatarUrl: null,
    });
    expect(listProfiles(db).map((profile) => profile.id)).toEqual([profileOf(host)]);
    expect(profilesExist(db, [profileOf(host)])).toBe(true);
  });

  it("carries a person's attributed videos along when people are linked", () => {
    const host = hiddenHost("Some Host", "somehost");
    const kept = video(host, "hostVid0001");
    const shared = video(host, "hostVid0002");
    const jane = profileOf(account("Jane Doe", "janedoe"));
    const janeX = profileOf(account("Jane", "jane", "x"));
    attachVideoToProfile(db, janeX, kept);
    attachVideoToProfile(db, janeX, shared);
    attachVideoToProfile(db, jane, shared);

    expect(linkProfilesFromInput(db, jane, [janeX])).toMatchObject({ ok: true });

    expect(getProfile(db, janeX)).toBeNull();
    expect(listVideoProfileIds(db, kept)).toEqual([jane]);
    expect(listVideoProfileIds(db, shared)).toEqual([jane]);
    expect(getCreator(db, host)).not.toBeNull();
  });

  it("carries attributed videos along when a lone account moves into a person", () => {
    const host = hiddenHost("Some Host", "somehost");
    const appearance = video(host, "hostVid0001");
    const jane = account("Jane Doe", "janedoe");
    const janeX = account("Jane", "jane", "x");
    attachVideoToProfile(db, profileOf(janeX), appearance);

    moveAccountToProfile(db, janeX, profileOf(jane));

    expect(listVideoProfileIds(db, appearance)).toEqual([profileOf(jane)]);
  });

  describe("resolveCreatorPageTarget", () => {
    it("shows a visible person, with or without one of their accounts", () => {
      const jane = account("Jane Doe", "janedoe");
      const profile = profileOf(jane);
      expect(resolveCreatorPageTarget(db, profile, null)).toEqual({ kind: "show" });
      expect(resolveCreatorPageTarget(db, profile, jane)).toEqual({ kind: "show" });
    });

    it("is not found for a hidden host's profile and never redirects to itself", () => {
      const host = hiddenHost("Some Host", "somehost");
      const hiddenProfile = profileOf(host);
      expect(resolveCreatorPageTarget(db, hiddenProfile, null)).toEqual({ kind: "notFound" });
      // The old rule followed the account to its owner: the same hidden profile, forever.
      expect(resolveCreatorPageTarget(db, hiddenProfile, host)).toEqual({ kind: "notFound" });
      expect(resolveCreatorPageTarget(db, 9999, null)).toEqual({ kind: "notFound" });
      expect(resolveCreatorPageTarget(db, 9999, 8888)).toEqual({ kind: "notFound" });
    });

    it("does not redirect to a hidden profile", () => {
      const jane = account("Jane Doe", "janedoe");
      const host = hiddenHost("Some Host", "somehost");
      // A visible profile asked for a hidden account stays on the visible profile.
      expect(resolveCreatorPageTarget(db, profileOf(jane), host)).toEqual({ kind: "show" });
      // A profile that no longer exists, asked for a hidden account, is simply gone.
      expect(resolveCreatorPageTarget(db, 9999, host)).toEqual({ kind: "notFound" });
    });

    it("follows an account to the visible person it now belongs to", () => {
      const youtube = account("Jane Doe", "janedoe");
      const x = account("Jane", "jane", "x");
      const oldProfile = profileOf(x);
      linkProfilesFromInput(db, profileOf(youtube), [oldProfile]);

      // The profile that no longer exists, and a profile that never held the account.
      expect(resolveCreatorPageTarget(db, oldProfile, x)).toEqual({
        kind: "redirect",
        profileId: profileOf(youtube),
        accountId: x,
      });
      const other = profileOf(account("Someone", "someone"));
      expect(resolveCreatorPageTarget(db, other, x)).toEqual({
        kind: "redirect",
        profileId: profileOf(youtube),
        accountId: x,
      });
      expect(resolveCreatorPageTarget(db, oldProfile, null)).toEqual({ kind: "notFound" });
    });
  });
});
