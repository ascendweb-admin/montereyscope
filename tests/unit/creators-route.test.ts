import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as GET_CREATORS } from "@/app/api/creators/route";
import { addCreator } from "@/lib/creators/repository";
import { closeDatabase, getDb } from "@/lib/db/connection";

/**
 * GET /api/creators: the saved-creator list. Source-only hosts (channels
 * saved only because a hand-picked video lives on them) are not creators the
 * user has, so they stay out of it.
 */

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "localtube-creators-route-"));
  process.env.LOCALTUBE_DB_PATH = path.join(tempDir, "creators.db");
});

afterEach(() => {
  closeDatabase();
  delete process.env.LOCALTUBE_DB_PATH;
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("GET /api/creators", () => {
  it("omits source-only hosts", async () => {
    const db = getDb();
    addCreator(db, {
      youtubeChannelId: null,
      handle: "dana",
      displayName: "Dana",
      channelUrl: "https://www.youtube.com/@dana",
      avatarUrl: null,
    });
    addCreator(db, {
      youtubeChannelId: null,
      handle: "hiddenhost",
      displayName: "Hidden Host",
      channelUrl: "https://www.youtube.com/@hiddenhost",
      avatarUrl: null,
      followed: false,
    });

    const response = await GET_CREATORS();
    const body = (await response.json()) as { creators: Array<{ displayName: string }> };

    expect(response.status).toBe(200);
    expect(body.creators.map((creator) => creator.displayName)).toEqual(["Dana"]);
  });
});
