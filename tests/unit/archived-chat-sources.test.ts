import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/ai/chat/threads/[id]/route";
import { archivedChatSources } from "@/lib/ai/thread-sources";
import { createThread, appendMessage } from "@/lib/ai/threads";
import { closeDatabase, getDb } from "@/lib/db/connection";

let root: string;
let job: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "scope-chat-archive-"));
  job = path.join(root, "job");
  mkdirSync(job);
  process.env.SCOPE_DB_PATH = path.join(root, "scope.db");
});
afterEach(() => {
  closeDatabase();
  delete process.env.SCOPE_DB_PATH;
  rmSync(root, { recursive: true, force: true });
});

const video = {
  kind: "video",
  id: "archived01",
  title: "Archived source",
  creator: "Saved creator",
  platform: "rumble",
  url: "https://rumble.com/archived-video.html",
  publishedAt: "2026-09-01T12:00:00Z",
  durationSeconds: 123,
  file: "transcripts/archived01.txt",
  readyForAnalysis: true,
  sha256: "private-file-hash",
  exclusionReason: null,
};
const write = (data: unknown) =>
  writeFileSync(path.join(job, "manifest.json"), JSON.stringify(data));

it("returns citation metadata for a saved thread even when the live caches are empty", async () => {
  const db = getDb();
  write({ version: 2, sources: [video] });
  const thread = createThread(db, {
    title: "Saved question",
    videoIds: [video.id],
    codexWorkDir: job,
    mode: "quick",
  });
  appendMessage(db, { threadId: thread.id, role: "assistant", content: "A finding." });
  const response = await GET(new Request("http://localhost/thread"), {
    params: Promise.resolve({ id: String(thread.id) }),
  });
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.sourceMetadata).toEqual([
    {
      id: video.id,
      kind: "video",
      title: video.title,
      creator: video.creator,
      platform: "rumble",
      url: video.url,
      publishedAt: video.publishedAt,
      durationSeconds: 123,
    },
  ]);
  expect(JSON.stringify(body)).not.toContain(job);
  expect(JSON.stringify(body)).not.toContain("private-file-hash");
  expect(JSON.stringify(body)).not.toContain("transcripts/");
  expect(db.prepare("SELECT count(*) AS n FROM videos").get()).toEqual({ n: 0 });
  expect(body.messages).toHaveLength(1);
});

it("limits metadata to selected, readable sources without attributing a repost to its saved account", () => {
  write({
    version: 2,
    sources: [
      video,
      { ...video, id: "unselected" },
      { ...video, id: "unreadable", readyForAnalysis: false },
      {
        ...video,
        kind: "tweet",
        id: "12345",
        title: "Reposted claim",
        creator: "Reposting account",
        url: "https://x.com/original/status/12345",
      },
      null,
    ],
  });
  const sources = archivedChatSources(job, [
    { kind: "video", id: video.id },
    { kind: "video", id: "unreadable" },
    { kind: "tweet", id: "12345" },
  ]);
  expect(sources.map((source) => source.id)).toEqual([video.id, "12345"]);
  expect(sources[1].creator).toBeUndefined();
  expect(sources[1].url).toBe("https://x.com/original/status/12345");
});

describe("appearances on another person's channel", () => {
  const appearance = {
    ...video,
    id: "guestvideo01",
    creator: "PBD Podcast",
    featuring: ["Luke Belmar"],
  };

  it("cites the featured person on the channel that hosts the video", () => {
    write({ version: 2, sources: [appearance] });
    const [source] = archivedChatSources(job, [{ kind: "video", id: appearance.id }]);
    expect(source).toMatchObject({
      id: appearance.id,
      creator: "Luke Belmar",
      channelName: "PBD Podcast",
    });
  });

  it("labels with the first featured person who is not the channel itself", () => {
    write({
      version: 2,
      sources: [{ ...appearance, creator: "Luke Belmar", featuring: ["Luke Belmar", "Maya Chen"] }],
    });
    const [source] = archivedChatSources(job, [{ kind: "video", id: appearance.id }]);
    expect(source).toMatchObject({ creator: "Maya Chen", channelName: "Luke Belmar" });
  });

  it("reads exactly as before when the channel is the only name there is", () => {
    // A person's own channel video attributed to them: not an appearance.
    write({
      version: 2,
      sources: [{ ...appearance, creator: "Luke Belmar", featuring: ["Luke Belmar"] }],
    });
    const [source] = archivedChatSources(job, [{ kind: "video", id: appearance.id }]);
    expect(source.creator).toBe("Luke Belmar");
    expect(source).not.toHaveProperty("channelName");
  });

  it.each([
    ["no featuring field (an older manifest)", { ...video }],
    ["an empty list", { ...video, featuring: [] }],
    ["a list that is not an array", { ...video, featuring: "Luke Belmar" }],
    ["a list of non-names", { ...video, featuring: [3, "", "  ", null] }],
  ])("keeps a saved thread rendering as before with %s", (_name, entry) => {
    write({ version: 2, sources: [entry] });
    const sources = archivedChatSources(job, [{ kind: "video", id: video.id }]);
    expect(sources).toHaveLength(1);
    expect(sources[0].creator).toBe(video.creator);
    expect(sources[0]).not.toHaveProperty("channelName");
  });

  it("never gives a post a channel", () => {
    write({
      version: 2,
      sources: [{ ...appearance, kind: "tweet", id: "12345", featuring: ["Luke Belmar"] }],
    });
    const [source] = archivedChatSources(job, [{ kind: "tweet", id: "12345" }]);
    expect(source.creator).toBeUndefined();
    expect(source).not.toHaveProperty("channelName");
  });
});

it("supports legacy video snapshots and ignores non-web URLs", () => {
  write({ scope: { videos: [{ ...video, hasTranscript: true, url: "javascript:alert(1)" }] } });
  const sources = archivedChatSources(job, [{ kind: "video", id: video.id }]);
  expect(sources).toHaveLength(1);
  expect(sources[0].title).toBe(video.title);
  expect(sources[0].url).toBeUndefined();
});

it("keeps missing or corrupt snapshots from breaking conversation history", () => {
  expect(archivedChatSources(job, [])).toEqual([]);
  writeFileSync(path.join(job, "manifest.json"), "broken JSON");
  expect(archivedChatSources(job, [{ kind: "video", id: video.id }])).toEqual([]);
});
