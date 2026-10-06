import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INITIAL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import {
  resolveTranscript,
  resetInFlightExtractions,
  classifyCommandFailure,
  getCachedTranscript,
} from "@/lib/transcripts/service";
import { getTranscript, saveTranscript } from "@/lib/transcripts/repository";
import type { ExecFileResult } from "@/lib/ytdlp/runner";

const VIDEO_ID = "jNQXAC9IVRw";
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

const DISCOVERY_PAYLOAD = JSON.stringify({
  id: VIDEO_ID,
  subtitles: "en",
  automatic_captions: "en, fr",
});

function discoveryRun(stdout: string): ExecFileResult {
  return { ok: true, stdout, stderr: "" };
}

type YtDlpFailure = Extract<ExecFileResult, { ok: false }>;

function commandFailure(kind: string, extra: Record<string, unknown> = {}): YtDlpFailure {
  return {
    ok: false,
    kind: kind as YtDlpFailure["kind"],
    stderrTail: "",
    ...extra,
  } as YtDlpFailure;
}

interface RunCall {
  file: string;
  args: readonly string[];
}

type RunBehavior = (callIndex: number, call: RunCall) => ExecFileResult;

/**
 * Builds an injectable `run` that mimics yt-dlp without spawning it:
 * discovery calls return canned JSON; caption jobs actually create the
 * expected .vtt artifact inside the requested unique job directory.
 */
function makeRun(behavior: RunBehavior) {
  const calls: RunCall[] = [];
  const createdDirs: string[] = [];
  const run = (file: string, args: readonly string[]): Promise<ExecFileResult> => {
    const call = { file, args };
    calls.push(call);
    const index = calls.indexOf(call);
    if (args.includes("--simulate")) {
      return Promise.resolve(behavior(index, call));
    }
    // Caption job: honor -o <dir>/%(id)s and materialize the artifact.
    const outputIndex = args.indexOf("-o");
    const jobDir = path.dirname(args[outputIndex + 1]);
    createdDirs.push(jobDir);
    const result = behavior(index, call);
    if (result.ok) {
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(path.join(jobDir, `${VIDEO_ID}.en.vtt`), SAMPLE_VTT);
    }
    return Promise.resolve(result);
  };
  return { run, calls, createdDirs };
}

const SAMPLE_VTT = [
  "WEBVTT",
  "",
  "00:00:00.000 --> 00:00:02.000",
  "All right, so here we are, in front of the elephants.",
].join("\n");

function createDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "localtube-transcript-tests-"));
  const db = new Database(path.join(dir, "test.db"));
  db.pragma("foreign_keys = ON");
  runMigrations(db, INITIAL_MIGRATIONS);
  db.prepare(
    "INSERT INTO creators (id, display_name, channel_url) VALUES (1, 'Test', 'https://www.youtube.com/channel/x')",
  ).run();
  db.prepare(
    `INSERT INTO videos (id, creator_id, title, url, live_status)
     VALUES (?, 1, 'Me at the zoo', ?, 'not_live')`,
  ).run(VIDEO_ID, VIDEO_URL);
  return { db, dir };
}

describe("transcript service", () => {
  let db: Database.Database;
  let dbDir: string;

  beforeEach(() => {
    resetInFlightExtractions();
    const created = createDb();
    db = created.db;
    dbDir = created.dir;
  });

  afterEach(() => {
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  /** Every job directory this test's fake run created must be gone. */
  function expectAllJobDirsRemoved(mocked: { createdDirs: string[] }): void {
    for (const dir of mocked.createdDirs) {
      expect(existsSync(dir), `job dir should be removed: ${dir}`).toBe(false);
    }
  }

  it("extracts, parses, caches, and leaves no temporary directory behind", async () => {
    const mocked = makeRun((index) =>
      index === 0 ? discoveryRun(DISCOVERY_PAYLOAD) : { ok: true, stdout: "", stderr: "" },
    );

    const outcome = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
      run: mocked.run,
      cacheEnabled: true,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.transcript.text).toContain("in front of the elephants.");
    expect(outcome.transcript.language).toBe("en");
    expect(outcome.transcript.captionSource).toBe("manual");
    expect(outcome.transcript.fromCache).toBe(false);

    const cached = getTranscript(db, VIDEO_ID);
    expect(cached?.plainText).toBe(outcome.transcript.text);
    expect(cached?.source).toBe("manual");

    // The artifact existed while the job ran...
    expect(mocked.createdDirs.length).toBeGreaterThan(0);
    // ...and every job directory was cleaned up afterwards.
    expectAllJobDirsRemoved(mocked);
  });

  it("cleans up temporary directories on yt-dlp failure and on timeout", async () => {
    const failing = makeRun((index) =>
      index === 0 ? discoveryRun(DISCOVERY_PAYLOAD) : commandFailure("nonzero_exit"),
    );
    const failed = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
      run: failing.run,
      cacheEnabled: true,
    });
    expect(failed.ok).toBe(false);
    expectAllJobDirsRemoved(failing);

    const timingOut = makeRun((index) =>
      index === 0 ? discoveryRun(DISCOVERY_PAYLOAD) : commandFailure("timeout"),
    );
    const timedOut = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
      run: timingOut.run,
      cacheEnabled: true,
    });
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) {
      expect(timedOut.error.code).toBe("timeout");
    }
    expectAllJobDirsRemoved(timingOut);
  });

  it("serves a cache hit without invoking yt-dlp", async () => {
    saveTranscript(
      db,
      { videoId: VIDEO_ID, language: "en", source: "manual", plainText: "Cached words." },
      "2026-08-24T10:00:00.000Z",
    );
    const mocked = makeRun(() => {
      throw new Error("yt-dlp must not run on a cache hit");
    });

    const outcome = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
      run: mocked.run,
      cacheEnabled: true,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.transcript.fromCache).toBe(true);
      expect(outcome.transcript.text).toBe("Cached words.");
    }
    expect(mocked.calls.length).toBe(0);
  });

  it("refresh bypasses the cache and replaces it only on success", async () => {
    saveTranscript(
      db,
      { videoId: VIDEO_ID, language: "en", source: "manual", plainText: "Old text." },
      "2026-08-24T09:00:00.000Z",
    );
    const mocked = makeRun((index) =>
      index === 0 ? discoveryRun(DISCOVERY_PAYLOAD) : { ok: true, stdout: "", stderr: "" },
    );

    const outcome = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
      run: mocked.run,
      cacheEnabled: true,

      intent: "refresh",
    });

    expect(outcome.ok).toBe(true);
    expect(mocked.calls.length).toBe(2);
    const refreshed = getTranscript(db, VIDEO_ID);
    expect(refreshed?.plainText).toContain("in front of the elephants.");

    // A failed refresh keeps the previous successful transcript intact.
    const brokenRefresh = makeRun(() => commandFailure("nonzero_exit"));
    const failed = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
      run: brokenRefresh.run,
      cacheEnabled: true,
      intent: "refresh",
    });
    expect(failed.ok).toBe(false);
    expect(getTranscript(db, VIDEO_ID)?.plainText).toContain("in front of the elephants.");
    expectAllJobDirsRemoved(brokenRefresh);
  });

  it("never reads or writes the cache when caching is disabled", async () => {
    saveTranscript(
      db,
      { videoId: VIDEO_ID, language: "en", source: "manual", plainText: "Cached words." },
      "2026-08-24T10:00:00.000Z",
    );
    const mocked = makeRun((index) =>
      index === 0 ? discoveryRun(DISCOVERY_PAYLOAD) : { ok: true, stdout: "", stderr: "" },
    );

    const outcome = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
      run: mocked.run,
      cacheEnabled: false,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error("expected success with caching disabled");
    }
    expect(outcome.transcript.fromCache).toBe(false);
    expect(getTranscript(db, VIDEO_ID)?.plainText).toBe("Cached words.");
  });

  it("reports no_captions and never touches yt-dlp's caption job", async () => {
    const nonePayload = JSON.stringify({ id: VIDEO_ID, subtitles: "", automatic_captions: "" });
    const mocked = makeRun(() => discoveryRun(nonePayload));

    const outcome = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
      run: mocked.run,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("no_captions");
    }
    expect(mocked.calls.length).toBe(1);
  });

  it("reports unavailable English captions without offering other languages", async () => {
    const foreignPayload = JSON.stringify({
      id: VIDEO_ID,
      subtitles: "de, pt-BR",
      automatic_captions: "ja, es",
    });
    const mocked = makeRun(() => discoveryRun(foreignPayload));

    const outcome = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
      run: mocked.run,
      cacheEnabled: false,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("no_captions");
      expect(outcome.error.message).toContain("English");
      expect(outcome.error.availableManualLanguages).toBeUndefined();
      expect(outcome.error.availableAutomaticLanguages).toBeUndefined();
    }
    expect(mocked.calls.length).toBe(1);
  });

  it("downloads exactly the track the user selected without re-discovering", async () => {
    saveTranscript(
      db,
      { videoId: VIDEO_ID, language: "en", source: "manual", plainText: "Old English transcript" },
      "2026-08-24T10:00:00.000Z",
    );
    const mocked = makeRun(() => ({ ok: true, stdout: "", stderr: "" }));

    const outcome = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
      run: mocked.run,
      cacheEnabled: true,
      selection: { language: "en-GB", kind: "manual" },
      intent: "select",
    });

    expect(outcome.ok).toBe(true);
    expect(getTranscript(db, VIDEO_ID)?.language).toBe("en-GB");
    expect(mocked.calls.length).toBe(1);
    const args = mocked.calls[0].args;
    expect(args).toContain("--write-subs");
    expect(args[args.indexOf("--sub-langs") + 1]).toBe("en-GB");
  });

  it("falls back to the automatic track when only it matches", async () => {
    const autoOnlyPayload = JSON.stringify({
      id: VIDEO_ID,
      subtitles: "",
      automatic_captions: "en",
    });
    const mocked = makeRun((index) =>
      index === 0 ? discoveryRun(autoOnlyPayload) : { ok: true, stdout: "", stderr: "" },
    );

    const outcome = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
      run: mocked.run,
      cacheEnabled: false,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.transcript.captionSource).toBe("automatic");
      expect(outcome.transcript.language).toBe("en");
    }
    expect(mocked.calls[1].args).toContain("--write-auto-subs");
  });

  it("uses original English despite legacy non-English settings", async () => {
    db.prepare("INSERT INTO settings(key, value) VALUES('preferred_caption_languages', ?)").run(
      '["pt-br", "de"]',
    );
    const payload = JSON.stringify({
      id: VIDEO_ID,
      subtitles: "pt-BR",
      automatic_captions: "en, en-orig",
    });
    const mocked = makeRun((index) =>
      index === 0 ? discoveryRun(payload) : { ok: true, stdout: "", stderr: "" },
    );
    const outcome = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
      run: mocked.run,
      cacheEnabled: true,
    });
    expect(outcome.ok).toBe(true);
    expect(mocked.calls[0].args[mocked.calls[0].args.indexOf("--sub-langs") + 1]).toBe(
      "(?i:en(?:-.*)?)",
    );
    expect(mocked.calls[1].args[mocked.calls[1].args.indexOf("--sub-langs") + 1]).toBe("en-orig");
    if (outcome.ok) expect(outcome.transcript.language).toBe("en-orig");
    expect(getTranscript(db, VIDEO_ID)?.language).toBe("en-orig");
    expectAllJobDirsRemoved(mocked);
  });

  it("rejects an explicit non-English selection without invoking yt-dlp", async () => {
    const mocked = makeRun(() => {
      throw Error("must not run");
    });
    const outcome = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
      run: mocked.run,
      selection: { language: "pt-BR", kind: "manual" },
      intent: "select",
    });
    expect(outcome.ok).toBe(false);
    expect(mocked.calls).toHaveLength(0);
  });

  it("ignores a cached non-English transcript and replaces it only after English extraction succeeds", async () => {
    saveTranscript(
      db,
      { videoId: VIDEO_ID, language: "pt-BR", source: "manual", plainText: "Old text" },
      "2026-08-24T10:00:00.000Z",
    );
    expect(getCachedTranscript(db, VIDEO_ID)).toBeNull();
    expect(getTranscript(db, VIDEO_ID)?.language).toBe("pt-BR");
    const mocked = makeRun((index) =>
      index === 0 ? discoveryRun(DISCOVERY_PAYLOAD) : { ok: true, stdout: "", stderr: "" },
    );
    const outcome = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, { run: mocked.run });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.transcript.fromCache).toBe(false);
    expect(getTranscript(db, VIDEO_ID)?.language).toBe("en");
    expectAllJobDirsRemoved(mocked);
  });

  it("maps tool failures to specific typed errors", async () => {
    const cases: Array<{ failure: YtDlpFailure; expected: string }> = [
      { failure: commandFailure("missing_executable"), expected: "ytdlp_missing" },
      { failure: commandFailure("timeout"), expected: "timeout" },
      { failure: commandFailure("output_limit"), expected: "local_tool" },
      {
        failure: {
          ok: false,
          kind: "nonzero_exit",
          stderrTail: "ERROR: [youtube] abc: This video is unavailable",
        },
        expected: "unavailable_video",
      },
      {
        failure: {
          ok: false,
          kind: "nonzero_exit",
          stderrTail: "ERROR: unable to download webpage: Temporary failure in name resolution",
        },
        expected: "network",
      },
    ];

    const caseMocks: Array<{ createdDirs: string[] }> = [];
    for (const testCase of cases) {
      const mocked = makeRun(() => testCase.failure);
      caseMocks.push(mocked);
      const outcome = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
        run: mocked.run,
        cacheEnabled: false,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code).toBe(testCase.expected);
      }
    }
    for (const mocked of caseMocks) {
      expectAllJobDirsRemoved(mocked);
    }
  });

  it("treats unusable, unreadable, ambiguous, and malformed artifacts as failures without caching", async () => {
    // Unusable discovery payload.
    const badJson = makeRun(() => discoveryRun("<html>not json</html>"));
    const badOutcome = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
      run: badJson.run,
      cacheEnabled: false,
    });
    expect(badOutcome.ok).toBe(false);
    if (!badOutcome.ok) {
      expect(badOutcome.error.code).toBe("unexpected_response");
    }

    // Command exits cleanly but no subtitle artifact appears.
    const noArtifactRun = (_file: string, args: readonly string[]): Promise<ExecFileResult> => {
      if (args.includes("--simulate")) {
        return Promise.resolve(discoveryRun(DISCOVERY_PAYLOAD));
      }
      return Promise.resolve({ ok: true, stdout: "", stderr: "" });
    };
    const emptyOutcome = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
      run: noArtifactRun,
      cacheEnabled: false,
    });
    expect(emptyOutcome.ok).toBe(false);
    if (!emptyOutcome.ok) {
      expect(emptyOutcome.error.message.toLowerCase()).toContain("did not return");
    }

    // Artifact exists but is not parseable WebVTT — nothing may be cached.
    let malformedJobDir = "";
    const malformedRun = (_file: string, args: readonly string[]): Promise<ExecFileResult> => {
      if (args.includes("--simulate")) {
        return Promise.resolve(discoveryRun(DISCOVERY_PAYLOAD));
      }
      malformedJobDir = path.dirname(args[args.indexOf("-o") + 1]);
      mkdirSync(malformedJobDir, { recursive: true });
      writeFileSync(
        path.join(malformedJobDir, `${VIDEO_ID}.en.vtt`),
        "<html>definitely not vtt</html>",
      );
      return Promise.resolve({ ok: true, stdout: "", stderr: "" });
    };
    const malformedOutcome = await resolveTranscript(db, VIDEO_ID, VIDEO_URL, {
      run: malformedRun,
      cacheEnabled: true,
    });
    expect(malformedOutcome.ok).toBe(false);
    if (!malformedOutcome.ok) {
      expect(malformedOutcome.error.code).toBe("parse");
    }
    expect(getTranscript(db, VIDEO_ID)).toBeNull();
    expect(existsSync(malformedJobDir)).toBe(false);
  });

  it("collapses concurrent requests for one video into a single extraction", async () => {
    let releaseDiscovery!: (result: ExecFileResult) => void;
    const gate = new Promise<ExecFileResult>((resolve) => {
      releaseDiscovery = resolve;
    });

    let callsSeen = 0;
    let sharedJobDir = "";
    const run = (_file: string, args: readonly string[]): Promise<ExecFileResult> => {
      callsSeen += 1;
      if (args.includes("--simulate")) {
        return gate.then(() => discoveryRun(DISCOVERY_PAYLOAD));
      }
      sharedJobDir = path.dirname(args[args.indexOf("-o") + 1]);
      writeFileSync(path.join(sharedJobDir, `${VIDEO_ID}.en.vtt`), SAMPLE_VTT);
      return Promise.resolve({ ok: true, stdout: "", stderr: "" });
    };

    const shared = {
      run,
      cacheEnabled: true,
    };
    const first = resolveTranscript(db, VIDEO_ID, VIDEO_URL, shared);
    const second = resolveTranscript(db, VIDEO_ID, VIDEO_URL, shared);
    releaseDiscovery(discoveryRun(DISCOVERY_PAYLOAD));
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(firstOutcome.ok).toBe(true);
    expect(secondOutcome.ok).toBe(true);
    // Exactly one discovery invocation despite two concurrent callers.
    expect(callsSeen).toBe(2);
    expect(existsSync(sharedJobDir)).toBe(false);
  });

  it("classifies raw command failures deterministically", () => {
    expect(classifyCommandFailure(commandFailure("missing_executable")).code).toBe("ytdlp_missing");
    expect(classifyCommandFailure(commandFailure("timeout")).code).toBe("timeout");
    expect(classifyCommandFailure(commandFailure("spawn_failed")).code).toBe("local_tool");
    expect(
      classifyCommandFailure({
        ok: false,
        kind: "nonzero_exit",
        stderrTail: "ERROR: [youtube] x: Private video. Sign in if you've been granted access",
      }).code,
    ).toBe("unavailable_video");
    expect(
      classifyCommandFailure({
        ok: false,
        kind: "nonzero_exit",
        stderrTail: "some totally unexpected crash",
      }).code,
    ).toBe("unexpected_response");
  });
});
