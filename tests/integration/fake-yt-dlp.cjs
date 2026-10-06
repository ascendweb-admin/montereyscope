#!/usr/bin/env node
"use strict";

/**
 * Deterministic fake yt-dlp executable for scope's automated tests.
 *
 * Invoked exactly like the real binary (execFile, argument array). Behavior
 * is driven ONLY by argv plus optional environment overrides, so tests stay
 * hermetic: no network access, no real YouTube, no installed yt-dlp.
 *
 * Selection rules, in order:
 * 1. Failure tokens embedded in the URL argument (see TOKENS below).
 * 2. `--version`                -> prints a fixed version string.
 * 3. `--flat-playlist` + `--dump-single-json`
 *    - URL ends in /videos      -> channel-videos fixture (bounded by
 *                                  --playlist-items, mirroring the real
 *                                  extractor's behavior).
 *    - URL ends in /streams     -> channel-streams fixture, or the real
 *                                  "does not have a streams tab" error when
 *                                  the URL carries the no-streams token.
 *    - anything else            -> resolved-channel fixture (creator
 *                                  resolution peeking at entry 1).
 * 4. `--simulate` + `--print` -> compact caption language discovery.
 * 5. `--write-subs`/`--write-auto-subs` -> writes .vtt artifacts into the
 *    directory from the -o template, named "<id>.<lang>.vtt".
 * 6. otherwise (--skip-download discovery) -> subtitle-discovery fixture.
 *
 * Diagnostics:
 * - When FAKE_YTDLP_LOG is set, every invocation appends its exact argv as
 *   one JSON line, letting tests assert the precise argument array that
 *   reached the process boundary.
 * - When FAKE_YTDLP_FIXTURES is set, fixtures load from that directory
 *   instead of the shared sanitized defaults (used by the e2e suite).
 */

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const argvLog = process.env.FAKE_YTDLP_LOG || null;
const fixturesDir = process.env.FAKE_YTDLP_FIXTURES || path.join(__dirname, "..", "fixtures");
const stateDir = process.env.FAKE_YTDLP_STATE_DIR || null;

function fixtureText(name) {
  return fs.readFileSync(path.join(fixturesDir, name), "utf8");
}

function failWith(stderrMessage) {
  writeAll(2, `${stderrMessage}\n`);
  process.exit(1);
}

/**
 * Blocking write to a file descriptor. process.exit() can drop data still
 * buffered in process.stdout/stderr, so the fake tool's responses must write
 * synchronously to be deterministic.
 */
function writeAll(fd, text) {
  try {
    fs.writeSync(fd, text);
  } catch {
    // EPIPE after the parent killed us — the verdict is already in.
  }
}

if (argvLog) {
  try {
    fs.appendFileSync(argvLog, `${JSON.stringify(args)}\n`);
  } catch {
    // Logging must never break the fake tool.
  }
}

// ---------------------------------------------------------------------------
// Failure tokens (checked first, keyed on the URL argument)
// ---------------------------------------------------------------------------

const urlArg = [...args].reverse().find((arg) => /^https?:\/\//.test(arg)) || "";

const TOKENS = {
  network: "localtube-fail-network",
  unavailable: "localtube-fail-unavailable",
  hang: "localtube-hang",
  garbage: "localtube-garbage",
  hugeOutput: "localtube-huge-output",
  hugeStderr: "localtube-huge-stderr",
  slowStart: "localtube-slow-start",
  noStreamsTab: "localtube-no-streams-tab",
  noArtifact: "localtube-no-artifact",
  twoArtifacts: "localtube-two-artifacts",
  bigArtifact: "localtube-big-artifact",
  flaky: "localtube-flaky",
};

function hasToken(token) {
  return args.some((arg) => arg.includes(token));
}

if (hasToken(TOKENS.network)) {
  failWith(
    "ERROR: unable to download webpage: <urlopen error getaddrinfo Temporary failure in name resolution>",
  );
}
if (hasToken(TOKENS.unavailable)) {
  failWith("ERROR: [youtube] CapT10nedV1d: Video unavailable. It may have been removed.");
}

if (hasToken(TOKENS.flaky) && stateDir) {
  const marker = path.join(stateDir, "flaky-seen.marker");
  if (fs.existsSync(marker)) {
    // Second attempt: fall through and behave normally.
  } else {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(marker, "failed once\n");
    failWith(
      "ERROR: unable to download webpage: <urlopen error getaddrinfo Temporary failure in name resolution>",
    );
  }
}

if (hasToken(TOKENS.hang)) {
  // Block this process forever without burning CPU; the runner's hard
  // timeout is expected to SIGTERM us.
  const never = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(never, 0, 0);
}

if (hasToken(TOKENS.slowStart)) {
  const deadline = Date.now() + 400;
  while (Date.now() < deadline) {
    // Synchronous stall, then normal behavior.
  }
}

if (hasToken(TOKENS.garbage)) {
  writeAll(1, "<html>this is definitely not json</html>");
  process.exit(0);
}

if (hasToken(TOKENS.hugeOutput)) {
  writeAll(1, Buffer.alloc(12 * 1024 * 1024, 0x78).toString("latin1"));
  process.exit(0);
}

if (hasToken(TOKENS.hugeStderr)) {
  writeAll(2, Buffer.alloc(12 * 1024 * 1024, 0x79).toString("latin1"));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Mode dispatch
// ---------------------------------------------------------------------------

function playlistItemsLimit() {
  const index = args.indexOf("--playlist-items");
  if (index === -1) {
    return null;
  }
  const raw = args[index + 1] ?? "";
  const match = /^(?:1:)?(\d+)$/.exec(raw);
  return match ? Number.parseInt(match[1], 10) : null;
}

function boundedEntries(payloadText) {
  const limit = playlistItemsLimit();
  if (limit === null) {
    return payloadText;
  }
  const payload = JSON.parse(payloadText);
  payload.entries = payload.entries.slice(0, limit);
  return JSON.stringify(payload);
}

if (args.includes("--version")) {
  writeAll(1, "2026.08.19-fake\n");
  process.exit(0);
}

const isFlatPlaylist = args.includes("--flat-playlist") && args.includes("--dump-single-json");

if (isFlatPlaylist && urlArg.endsWith("/videos")) {
  writeAll(1, boundedEntries(fixtureText("channel-videos-tab.fixture.json")));
  process.exit(0);
}

if (isFlatPlaylist && urlArg.endsWith("/streams")) {
  if (hasToken(TOKENS.noStreamsTab)) {
    failWith("ERROR: This channel does not have a streams tab");
  }
  writeAll(1, boundedEntries(fixtureText("channel-streams-tab.fixture.json")));
  process.exit(0);
}

if (isFlatPlaylist) {
  // Creator resolution: cheap peek at channel identity only.
  writeAll(1, boundedEntries(fixtureText("resolved-channel.fixture.json")));
  process.exit(0);
}

if (args.includes("--simulate") && args.includes("--print")) {
  const payload = JSON.parse(fixtureText("subtitle-discovery.fixture.json"));
  writeAll(
    1,
    JSON.stringify({
      id: payload.id,
      subtitles: Object.keys(payload.subtitles || {}).join(", "),
      automatic_captions: Object.keys(payload.automatic_captions || {}).join(", "),
    }),
  );
  process.exit(0);
}

const writeIndex = args.findIndex((arg) => arg === "--write-subs" || arg === "--write-auto-subs");

if (writeIndex !== -1) {
  const templateIndex = args.indexOf("-o");
  const template = templateIndex !== -1 ? (args[templateIndex + 1] ?? "") : "";
  const outputDir = path.dirname(template);
  const langsIndex = args.indexOf("--sub-langs");
  const language = langsIndex !== -1 ? (args[langsIndex + 1] ?? "en") : "en";
  const idMatch = /[?&]v=([A-Za-z0-9_-]+)/.exec(urlArg);
  const videoId = idMatch ? idMatch[1] : "CapT10nedV1d";
  const baseName = `${videoId}.${language}`;

  if (hasToken(TOKENS.noArtifact)) {
    process.exit(0);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  if (hasToken(TOKENS.twoArtifacts)) {
    fs.writeFileSync(path.join(outputDir, `${baseName}.a.vtt`), fixtureText("sample-captions.vtt"));
    fs.writeFileSync(path.join(outputDir, `${baseName}.b.vtt`), fixtureText("sample-captions.vtt"));
    process.exit(0);
  }

  if (hasToken(TOKENS.bigArtifact)) {
    const chunk = "00:00:01.000 --> 00:00:02.000\nfiller line\n\n".repeat(200_000);
    fs.writeFileSync(path.join(outputDir, `${baseName}.vtt`), `WEBVTT\n\n${chunk}`);
    process.exit(0);
  }

  fs.writeFileSync(path.join(outputDir, `${baseName}.vtt`), fixtureText("sample-captions.vtt"));
  writeAll(2, "[download] Writing subtitle to: (path suppressed)\n");
  process.exit(0);
}

// Default: single-video metadata discovery.
writeAll(1, fixtureText("subtitle-discovery.fixture.json"));
process.exit(0);
