/**
 * Integration tests for the caption download job (lib/ytdlp/subtitles.ts)
 * against the fake yt-dlp executable — real processes, real temporary
 * directories, no mocks, no network.
 *
 * Verifies: exact artifact discovery inside the unique job directory,
 * selection language propagation, temporary-directory cleanup on every
 * exit path, and each typed failure mode.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { discoverAvailableSubtitles, downloadCaptionTrack } from "@/lib/ytdlp/subtitles";

const FAKE_YTDLP = path.join(__dirname, "fake-yt-dlp.cjs");
const TMP_PREFIX = "localtube-captions-";
const SAMPLE_VTT = readFileSync(
  path.join(__dirname, "..", "fixtures", "sample-captions.vtt"),
  "utf8",
);

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function countJobDirectories(): number {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(TMP_PREFIX)).length;
}

function lastArgvLine(logPath: string): string[] {
  const content = readFileSync(logPath, "utf8").trim();
  const lines = content.split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("downloadCaptionTrack against a real process", () => {
  afterEach(() => {
    delete process.env.FAKE_YTDLP_LOG;
  });

  it("downloads the selected track and always removes its job directory", async () => {
    const before = countJobDirectories();

    const result = await downloadCaptionTrack(
      "https://www.youtube.com/watch?v=CapT10nedV1d",
      { kind: "manual", language: "en-US" },
      { command: FAKE_YTDLP },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The artifact content is the sanitized fixture, byte-for-byte.
      expect(result.vtt).toBe(SAMPLE_VTT);
      expect(result.artifactName).toBe("CapT10nedV1d.en-US.vtt");
      // No local temporary paths may leak into the returned text.
      expect(result.vtt).not.toContain(TMP_PREFIX);
    }

    expect(countJobDirectories()).toBe(before);
  });

  it("passes the exact selection language to --sub-langs at the process boundary", async () => {
    const logPath = path.join(makeTempDir("localtube-argv-"), "argv.jsonl");
    process.env.FAKE_YTDLP_LOG = logPath;

    await downloadCaptionTrack(
      "https://www.youtube.com/watch?v=CapT10nedV1d",
      { kind: "automatic", language: "en-orig" },
      { command: FAKE_YTDLP },
    );

    const argv = lastArgvLine(logPath);
    const langsIndex = argv.indexOf("--sub-langs");
    expect(langsIndex).toBeGreaterThanOrEqual(0);
    expect(argv[langsIndex + 1]).toBe("en-orig");
    expect(argv).toContain("--write-auto-subs");
    expect(argv).not.toContain("--write-subs");

    delete process.env.FAKE_YTDLP_LOG;
  });

  it("parses discovery output from a real process into available tracks", async () => {
    const logPath = path.join(makeTempDir("localtube-argv-"), "argv.jsonl");
    process.env.FAKE_YTDLP_LOG = logPath;

    const result = await discoverAvailableSubtitles(
      "https://www.youtube.com/watch?v=localtube-discovery-probe",
      { command: FAKE_YTDLP },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(result.videoId).toBe("CapT10nedV1d");
      expect(result.available.manual).toEqual(["en", "pt-BR"]);
      expect(result.available.automatic).toEqual(["de", "en", "en-orig"]);
    }

    const argv = lastArgvLine(logPath);
    expect(argv).toContain("--skip-download");
    expect(argv).toContain("--simulate");
    expect(argv).not.toContain("--dump-single-json");
    expect(argv[argv.indexOf("--sub-langs") + 1]).toBe("(?i:en(?:-.*)?)");
    expect(argv).not.toContain("-o");

    delete process.env.FAKE_YTDLP_LOG;
  });

  it("cleans up the job directory when yt-dlp fails mid-download", async () => {
    const before = countJobDirectories();
    const result = await downloadCaptionTrack(
      "https://www.youtube.com/watch?v=localtube-fail-network",
      { kind: "manual", language: "en" },
      { command: FAKE_YTDLP },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("command_failed");
      if (result.reason === "command_failed") {
        expect(result.commandResult.kind).toBe("nonzero_exit");
        // stderr tails stay server-side diagnostics; bounded size only.
        expect(result.commandResult.stderrTail.length).toBeLessThanOrEqual(4000);
      }
    }
    expect(countJobDirectories()).toBe(before);
  });

  it("reports artifact_not_found when yt-dlp writes nothing", async () => {
    const result = await downloadCaptionTrack(
      "https://www.youtube.com/watch?v=localtube-no-artifact",
      { kind: "manual", language: "en" },
      { command: FAKE_YTDLP },
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason !== "command_failed") {
      expect(result.reason).toBe("artifact_not_found");
    } else {
      throw new Error(`unexpected failure reason: ${JSON.stringify(result)}`);
    }
  });

  it("reports artifact_ambiguous when two vtt files appear", async () => {
    const result = await downloadCaptionTrack(
      "https://www.youtube.com/watch?v=localtube-two-artifacts",
      { kind: "manual", language: "en" },
      { command: FAKE_YTDLP },
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason !== "command_failed") {
      expect(result.reason).toBe("artifact_ambiguous");
    } else {
      throw new Error(`unexpected failure reason: ${JSON.stringify(result)}`);
    }
  });

  it("enforces the artifact size cap without reading oversized files into memory", async () => {
    const result = await downloadCaptionTrack(
      "https://www.youtube.com/watch?v=localtube-big-artifact",
      { kind: "manual", language: "en" },
      // The fake writes ~7 MB; a small cap proves the stat-based guard.
      { command: FAKE_YTDLP, artifactMaxBytes: 1024 * 1024 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason !== "command_failed") {
      expect(result.reason).toBe("artifact_too_large");
    } else {
      throw new Error(`unexpected failure reason: ${JSON.stringify(result)}`);
    }
  }, 20_000);

  it("maps a missing executable to command_failed for upstream classification", async () => {
    const result = await downloadCaptionTrack(
      "https://www.youtube.com/watch?v=CapT10nedV1d",
      { kind: "manual", language: "en" },
      { command: path.join(makeTempDir("localtube-empty-"), "nope") },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("command_failed");
    } else {
      throw new Error(`unexpected result: ${JSON.stringify(result)}`);
    }
  });
});
