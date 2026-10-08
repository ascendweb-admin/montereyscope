#!/usr/bin/env node
"use strict";

/**
 * E2E-only fake yt-dlp: identical contract to the shared integration fake,
 * with a dedicated fixtures directory (tests/e2e/fixtures) and one extra
 * behavior — the `localtube-flaky` token fails the FIRST invocation for a
 * given video (tracked by a marker file) and succeeds on retry, powering
 * the failure-and-retry leg of the core-flow test.
 */

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const fixturesDir = path.join(__dirname, "fixtures");
const stateDir = process.env.FAKE_YTDLP_STATE_DIR || null;

function fixtureText(name) {
  return fs.readFileSync(path.join(fixturesDir, name), "utf8");
}

function failWith(message) {
  fs.writeSync(2, `${message}\n`);
  process.exit(1);
}

const urlArg = [...args].reverse().find((arg) => /^https?:\/\//.test(arg)) || "";

if (
  urlArg.includes("localtube-flaky") &&
  stateDir &&
  args.some((a) => a === "--write-subs" || a === "--write-auto-subs" || a === "--skip-download")
) {
  const idMatch = /[?&]v=([A-Za-z0-9_-]+)/.exec(urlArg);
  const marker = path.join(stateDir, `flaky-${idMatch ? idMatch[1] : "video"}.marker`);
  if (!fs.existsSync(marker)) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(marker, "first attempt failed\n");
    failWith(
      "ERROR: unable to download webpage: <urlopen error getaddrinfo Temporary failure in name resolution>",
    );
  }
}

if (args.includes("--version")) {
  fs.writeSync(1, "2026.08.19-e2e-fake\n");
  process.exit(0);
}

const isFlatPlaylist = args.includes("--flat-playlist") && args.includes("--dump-single-json");

if (isFlatPlaylist && urlArg.endsWith("/videos")) {
  fs.writeSync(1, fixtureText("channel-videos-tab.fixture.json"));
  process.exit(0);
}
if (isFlatPlaylist && urlArg.endsWith("/streams")) {
  // This e2e channel has no streams tab content; serve an empty playlist.
  fs.writeSync(
    1,
    JSON.stringify({
      id: "UCe2e00000000000000001",
      _type: "playlist",
      channel_id: "UCe2e00000000000000001",
      entries: [],
    }),
  );
  process.exit(0);
}
if (isFlatPlaylist) {
  fs.writeSync(1, fixtureText("resolved-channel.fixture.json"));
  process.exit(0);
}

if (args.includes("--simulate") && args.includes("--print")) {
  const payload = JSON.parse(fixtureText("discovery.fixture.json"));
  fs.writeSync(
    1,
    JSON.stringify({
      id: payload.id,
      subtitles: Object.keys(payload.subtitles || {}).join(", "),
      automatic_captions: Object.keys(payload.automatic_captions || {}).join(", "),
    }),
  );
  process.exit(0);
}

const writeIndex = args.findIndex((a) => a === "--write-subs" || a === "--write-auto-subs");
if (writeIndex !== -1) {
  const templateIndex = args.indexOf("-o");
  const template = templateIndex !== -1 ? (args[templateIndex + 1] ?? "") : "";
  const outputDir = path.dirname(template);
  const langsIndex = args.indexOf("--sub-langs");
  const language = langsIndex !== -1 ? (args[langsIndex + 1] ?? "en") : "en";
  const idMatch = /[?&]v=([A-Za-z0-9_-]+)/.exec(urlArg);
  const videoId = idMatch ? idMatch[1] : "E2eG00dV1d0";
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, `${videoId}.${language}.vtt`),
    fixtureText("sample-captions.vtt"),
  );
  process.exit(0);
}

fs.writeSync(1, fixtureText("discovery.fixture.json"));
process.exit(0);
