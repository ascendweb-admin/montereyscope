import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCaptionDownloadArgs,
  buildSubtitleDiscoveryArgs,
  parseDiscoveryPayload,
  selectEnglishSubtitleTrack,
  type AvailableSubtitles,
  isEnglishCaptionLanguage,
} from "@/lib/ytdlp/subtitles";

const VIDEO_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

describe("buildSubtitleDiscoveryArgs", () => {
  it("simulates original English captions and prints compact language lists", () => {
    expect(buildSubtitleDiscoveryArgs(VIDEO_URL)).toEqual([
      "--print",
      '{"id":%(id)j,"subtitles":"%(subtitles|)l","automatic_captions":"%(automatic_captions|)l"}',
      "--ignore-config",
      "--no-playlist",
      "--simulate",
      "--skip-download",
      "--extractor-args",
      "youtube:skip=translated_subs",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      "(?i:en(?:-.*)?)",
      "--sub-format",
      "vtt",
      "--no-warnings",
      "--no-progress",
      VIDEO_URL,
    ]);
  });
});

describe("parseDiscoveryPayload", () => {
  it("reads compact language lists without track URLs or formats", () => {
    const payload = JSON.stringify({
      id: "abc",
      subtitles: "live_chat, en, pt-BR, de",
      automatic_captions: "en-orig, en, ja",
    });
    expect(parseDiscoveryPayload(payload)).toEqual({
      ok: true,
      videoId: "abc",
      available: { manual: ["de", "en", "pt-BR"], automatic: ["en", "en-orig", "ja"] },
    });
    expect(parseDiscoveryPayload('{"id":"abc","subtitles":"","automatic_captions":""}')).toEqual({
      ok: true,
      videoId: "abc",
      available: { manual: [], automatic: [] },
    });
  });

  it("extracts sorted language lists and drops the live_chat pseudo-track", () => {
    const payload = JSON.stringify({
      id: "jNQXAC9IVRw",
      subtitles: {
        live_chat: [{ ext: "json" }],
        en: [{ ext: "vtt" }],
        "pt-BR": [{ ext: "vtt" }],
        de: [{ ext: "vtt" }],
      },
      automatic_captions: {
        en: [{ ext: "vtt" }],
        ja: [{ ext: "vtt" }],
      },
    });

    const parsed = parseDiscoveryPayload(payload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.videoId).toBe("jNQXAC9IVRw");
      expect(parsed.available.manual).toEqual(["de", "en", "pt-BR"]);
      expect(parsed.available.automatic).toEqual(["en", "ja"]);
    }
  });

  it("treats empty track objects as absent languages", () => {
    const payload = JSON.stringify({
      id: "abc",
      subtitles: { en: [] },
      automatic_captions: {},
    });
    const parsed = parseDiscoveryPayload(payload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.available).toEqual<AvailableSubtitles>({ manual: [], automatic: [] });
    }
  });

  it("rejects non-JSON payloads and objects without an id", () => {
    expect(parseDiscoveryPayload("not json at all").ok).toBe(false);
    expect(parseDiscoveryPayload("{}").ok).toBe(false);
    expect(parseDiscoveryPayload("[1,2,3]").ok).toBe(false);
  });
});

describe("selectEnglishSubtitleTrack", () => {
  it("prefers human-written English to original automatic captions", () => {
    expect(
      selectEnglishSubtitleTrack({ manual: ["pt-BR", "en-US"], automatic: ["en-orig", "en"] }),
    ).toEqual({ kind: "manual", language: "en-US" });
  });

  it("prefers en-orig to translated en regardless of discovery order", () => {
    for (const automatic of [
      ["en", "en-orig"],
      ["en-orig", "en"],
    ]) {
      expect(selectEnglishSubtitleTrack({ manual: ["de"], automatic })).toEqual({
        kind: "automatic",
        language: "en-orig",
      });
    }
  });

  it("recognizes regional original tracks and case-insensitive English codes", () => {
    expect(selectEnglishSubtitleTrack({ manual: [], automatic: ["en", "EN-us-orig"] })).toEqual({
      kind: "automatic",
      language: "EN-us-orig",
    });
    expect(selectEnglishSubtitleTrack({ manual: ["EN-us"], automatic: [] })).toEqual({
      kind: "manual",
      language: "EN-us",
    });
  });

  it("supports native English tracks without an orig suffix", () => {
    expect(selectEnglishSubtitleTrack({ manual: [], automatic: ["en-GB", "en"] })).toEqual({
      kind: "automatic",
      language: "en",
    });
  });

  it("does not select other languages", () => {
    expect(selectEnglishSubtitleTrack({ manual: ["pt-BR"], automatic: ["de", "ja"] })).toBeNull();
    expect(selectEnglishSubtitleTrack({ manual: [], automatic: [] })).toBeNull();
    for (const language of ["pt-BR", "de", "english", "en.*", "en,pt-BR", "live_chat"]) {
      expect(isEnglishCaptionLanguage(language)).toBe(false);
    }
  });
});

describe("buildCaptionDownloadArgs", () => {
  const outputDirectory = "/tmp/localtube-captions-abc123";

  it("rejects non-English tracks before starting a download", () => {
    expect(() =>
      buildCaptionDownloadArgs(VIDEO_URL, { kind: "manual", language: "pt-BR" }, outputDirectory),
    ).toThrow(/English captions only/);
  });

  it("writes only the selected human subtitle as vtt into the unique job directory", () => {
    const args = buildCaptionDownloadArgs(
      VIDEO_URL,
      { kind: "manual", language: "en" },
      outputDirectory,
    );
    expect(args).toEqual([
      "--skip-download",
      "--ignore-config",
      "--no-playlist",
      "--extractor-args",
      "youtube:skip=translated_subs",
      "--write-subs",
      "--sub-langs",
      "en",
      "--sub-format",
      "vtt",
      "--no-warnings",
      "--no-progress",
      "-o",
      path.join(outputDirectory, "%(id)s"),
      VIDEO_URL,
    ]);
  });

  it("switches to --write-auto-subs for automatic tracks without ever enabling download", () => {
    const args = buildCaptionDownloadArgs(
      VIDEO_URL,
      { kind: "automatic", language: "en-orig" },
      outputDirectory,
    );
    expect(args).toContain("--write-auto-subs");
    expect(args).not.toContain("--write-subs");
    expect(args).toContain("--skip-download");
    expect(args.join(" ")).not.toMatch(/(-f|--format)\b/);
    expect(args[args.length - 1]).toBe(VIDEO_URL);
    expect(args).not.toContain("-o=");
  });
});
