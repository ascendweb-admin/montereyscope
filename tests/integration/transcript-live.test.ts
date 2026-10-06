import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { runMigrations } from "@/lib/db/migrator";
import { INITIAL_MIGRATIONS } from "@/lib/db/migrations";
import { resolveTranscript } from "@/lib/transcripts/service";
import { discoverAvailableSubtitles, selectEnglishSubtitleTrack } from "@/lib/ytdlp/subtitles";
import { runCommand } from "@/lib/ytdlp/runner";

const VIDEO_ID = "Z6KpIF8K5r0";
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

// Opt-in: real public video, real yt-dlp, no mocked network or captions.
it.skipIf(process.env.SCOPE_LIVE_TRANSCRIPTS !== "1")(
  "discovers compact original English tracks for the previously failing stream",
  async () => {
    let outputBytes = 0;
    const outcome = await discoverAvailableSubtitles(VIDEO_URL, {
      run: async (...args) => {
        const result = await runCommand(...args);
        if (result.ok) {
          outputBytes = Buffer.byteLength(result.stdout);
          expect(result.stdout).not.toContain("https://");
        }
        return result;
      },
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(outputBytes).toBeGreaterThan(0);
    expect(outputBytes).toBeLessThan(64 * 1024);
    if (outcome.ok) {
      expect(selectEnglishSubtitleTrack(outcome.available)?.language).toBe("en-orig");
    }
  },
  120_000,
);

it.skipIf(process.env.SCOPE_LIVE_TRANSCRIPTS !== "1")(
  "extracts and caches original English captions for the previously rate-limited stream",
  async () => {
    const db = new Database(":memory:");
    runMigrations(db, INITIAL_MIGRATIONS);
    db.prepare(
      "INSERT INTO creators (id, display_name, channel_url) VALUES (1, 'Live test', 'https://www.youtube.com/@YouTube')",
    ).run();
    db.prepare(
      "INSERT INTO videos (id, creator_id, title, url, live_status) VALUES (?, 1, 'Live test', ?, 'was_live')",
    ).run(VIDEO_ID, VIDEO_URL);
    db.prepare("INSERT INTO settings(key,value) VALUES('preferred_caption_languages', ?)").run(
      '["pt-br","en-us"]',
    );
    try {
      const outcome = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, { intent: "refresh" });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      if (outcome.ok) {
        expect(outcome.transcript.language).toBe("en-orig");
        expect(outcome.transcript.captionSource).toBe("automatic");
        expect(outcome.transcript.text.length).toBeGreaterThan(1000);
      }
      const cached = await resolveTranscript(db, VIDEO_ID, VIDEO_URL);
      expect(cached.ok && cached.transcript.fromCache).toBe(true);
    } finally {
      db.close();
    }
  },
  180_000,
);
