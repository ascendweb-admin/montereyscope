/**
 * End-to-end core-flow test for scope's MVP scenario, driven over real
 * HTTP against a PRODUCTION server (`next start` bound to 127.0.0.1):
 *
 *   add a creator → open it → refresh its feed → open a video →
 *   get a transcript → copy-ready payload → restart the server →
 *   everything persisted.
 *
 * yt-dlp is replaced by a deterministic fake executable (no network, no
 * installed yt-dlp). One representative failure-and-retry path is exercised:
 * the first transcript extraction for one video fails with a network-style
 * error, and retrying the SAME request succeeds.
 *
 * The browser-only clipboard write itself is covered by the clipboard unit
 * tests; here we verify the exact copy-ready transcript payload the client
 * receives.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(__dirname, "..", "..");
const NEXT_BIN = path.join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next");
const FAKE_YTDLP = path.join(__dirname, "fake-yt-dlp.cjs");

interface ServerHandle {
  proc: ChildProcess;
  port: number;
  baseUrl: string;
}

let workDir: string;
let dbFile: string;
let stateDir: string;
let argvLog: string;
let server: ServerHandle;

/** Bodies seen over HTTP, kept so the privacy sweep runs at the end. */
const responseBodies: string[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function startServer(): Promise<ServerHandle> {
  return freePort().then(
    (port) =>
      new Promise<ServerHandle>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env };
        delete env.FAKE_YTDLP_LOG;
        delete env.FAKE_YTDLP_FIXTURES;
        Object.assign(env, {
          LOCALTUBE_DB_PATH: dbFile,
          LOCALTUBE_YTDLP_PATH: FAKE_YTDLP,
          FAKE_YTDLP_STATE_DIR: stateDir,
          FAKE_YTDLP_FIXTURES: path.join(__dirname, "fixtures"),
          FAKE_YTDLP_LOG: argvLog,
          NODE_ENV: "production",
        });

        const proc = spawn(
          process.execPath,
          [NEXT_BIN, "start", "-H", "127.0.0.1", "-p", String(port)],
          { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
        );

        let output = "";
        const capture = (chunk: Buffer) => {
          output += chunk.toString("utf8");
        };
        proc.stdout?.on("data", capture);
        proc.stderr?.on("data", capture);

        let settled = false;
        proc.once("exit", (code, signal) => {
          if (!settled) {
            settled = true;
            reject(
              new Error(`next start exited early (${code}/${signal}):\n${output.slice(-2000)}`),
            );
          }
        });

        const handle: ServerHandle = {
          proc,
          port,
          baseUrl: `http://127.0.0.1:${port}`,
        };

        const deadline = Date.now() + 60_000;
        const poll = async (): Promise<void> => {
          while (Date.now() < deadline && !settled) {
            try {
              const res = await fetch(`${handle.baseUrl}/api/health`);
              if (res.status === 200) {
                if (!settled) {
                  settled = true;
                  resolve(handle);
                }
                return;
              }
            } catch {
              // Not accepting connections yet.
            }
            await new Promise((r) => setTimeout(r, 300));
          }
          if (!settled) {
            settled = true;
            proc.kill("SIGKILL");
            reject(new Error(`server never became healthy:\n${output.slice(-2000)}`));
          }
        };
        void poll();
      }),
  );
}

async function stopServer(handle: ServerHandle): Promise<void> {
  if (handle.proc.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    handle.proc.once("exit", () => resolve());
    handle.proc.kill("SIGTERM");
  });
}

/** Loose shapes for the JSON endpoints the flow touches. */
interface CreatorPayload {
  creator: {
    id: number;
    displayName: string;
    youtubeChannelId: string | null;
  };
  status?: string;
}

interface RefreshPayload {
  status: string;
  refreshedAt: string;
  videoCount: number;
  livestreamCount: number;
}

interface FeedVideo {
  id: string;
}

interface FeedPayload {
  videos: FeedVideo[];
  livestreams: FeedVideo[];
  lastRefreshedAt: string | null;
}

interface TranscriptPayload {
  transcript: {
    text: string;
    language: string;
    captionSource: string;
    fromCache: boolean;
  };
  error?: { code: string; message: string };
}

interface HealthPayload {
  status: string;
  ytdlp: { available: boolean };
}

interface CreatorsListPayload {
  creators: Array<{ displayName: string }>;
}

async function getJson<T>(pathname: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server.baseUrl}${pathname}`);
  const body = (await res.json()) as T;
  responseBodies.push(JSON.stringify(body));
  return { status: res.status, body };
}

beforeAll(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "localtube-e2e-"));
  dbFile = path.join(workDir, "localtube.db");
  stateDir = path.join(workDir, "state");
  argvLog = path.join(workDir, "argv.jsonl");
  server = await startServer();
});

afterAll(async () => {
  await stopServer(server);
  rmSync(workDir, { recursive: true, force: true });
});

describe("scope core flow (production server, fake yt-dlp)", () => {
  let creatorId: number;
  const goodVideoId = "E2eG00dV1d0";
  const flakyVideoId = "E2eFl4kyV1d";

  it("adds a creator from a pasted channel URL", async () => {
    const added = await fetch(`${server.baseUrl}/api/creators`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.youtube.com/@e2esample?si=tracking" }),
    });
    const body = (await added.json()) as CreatorPayload;
    responseBodies.push(JSON.stringify(body));

    expect(added.status).toBe(201);
    expect(body.creator.displayName).toBe("E2E Sample Channel");
    expect(body.creator.youtubeChannelId).toBe("UCe2e00000000000000001");
    creatorId = body.creator.id;

    // Adding the same channel again resolves to the saved creator.
    const again = await fetch(`${server.baseUrl}/api/creators`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.youtube.com/@e2esample" }),
    });
    const againBody = (await again.json()) as CreatorPayload;
    responseBodies.push(JSON.stringify(againBody));
    expect(again.status).toBe(200);
    expect(againBody.status).toBe("already_saved");
  });

  it("opens the library page and the creator page", async () => {
    const library = await fetch(`${server.baseUrl}/`);
    expect(library.status).toBe(200);
    const libraryHtml = await library.text();
    expect(libraryHtml).toContain("E2E Sample Channel");

    const channel = await fetch(`${server.baseUrl}/channels/${creatorId}`);
    expect(channel.status).toBe(200);
    const channelHtml = await channel.text();
    expect(channelHtml).toContain("Videos");

    const unknown = await fetch(`${server.baseUrl}/channels/424242`);
    expect(unknown.status).toBe(404);
  });

  it("refreshes the cached feed through yt-dlp", async () => {
    const res = await fetch(`${server.baseUrl}/api/creators/${creatorId}/refresh`, {
      method: "POST",
    });
    const body = (await res.json()) as RefreshPayload;
    responseBodies.push(JSON.stringify(body));

    expect(res.status).toBe(200);
    expect(body.status).toBe("refreshed");
    expect(body.videoCount).toBe(2);
    expect(typeof body.refreshedAt).toBe("string");

    const feed = await getJson<FeedPayload>(`/api/creators/${creatorId}/feed`);
    expect(feed.body.videos).toHaveLength(2);
    expect(feed.body.livestreams).toHaveLength(0);
    expect(feed.body.lastRefreshedAt).not.toBeNull();
    const ids = feed.body.videos.map((video) => video.id);
    expect(ids).toContain(goodVideoId);
    expect(ids).toContain(flakyVideoId);
  });

  it("opens a cached video page", async () => {
    const page = await fetch(`${server.baseUrl}/channels/${creatorId}/videos/${goodVideoId}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("An ordinary upload with captions");
  });

  it("extracts a transcript and serves the cache on the second call", async () => {
    const first = await getJson<TranscriptPayload>(
      `/api/creators/${creatorId}/videos/${goodVideoId}/transcript`,
    );
    expect(first.status).toBe(200);
    expect(first.body.transcript.fromCache).toBe(false);
    expect(first.body.transcript.language).toBe("en");
    expect(first.body.transcript.captionSource).toBe("manual");
    expect(first.body.transcript.text).toContain("end-to-end sample transcript");
    expect(first.body.transcript.text).not.toContain("WEBVTT");

    // Copy step: this text payload is exactly what the client puts on the
    // clipboard (the browser write itself is covered by clipboard tests).
    expect(first.body.transcript.text.length).toBeGreaterThan(20);

    const second = await getJson<TranscriptPayload>(
      `/api/creators/${creatorId}/videos/${goodVideoId}/transcript`,
    );
    expect(second.status).toBe(200);
    expect(second.body.transcript.fromCache).toBe(true);
    expect(second.body.transcript.text).toBe(first.body.transcript.text);
  });

  it("recovers from a failed extraction by retrying the same action", async () => {
    const failed = await getJson<TranscriptPayload>(
      `/api/creators/${creatorId}/videos/${flakyVideoId}/transcript`,
    );
    expect(failed.status).toBe(502);
    if (!failed.body.error) {
      throw new Error("expected a structured error");
    }
    expect(failed.body.error.code).toBe("network");
    expect(failed.body.error.message).toContain("internet connection");

    // Nothing partial may have been cached by the failed attempt.
    const feed = await getJson<FeedPayload>(`/api/creators/${creatorId}/feed`);
    expect(feed.body.videos).toHaveLength(2);

    const retried = await getJson<TranscriptPayload>(
      `/api/creators/${creatorId}/videos/${flakyVideoId}/transcript`,
    );
    expect(retried.status).toBe(200);
    expect(retried.body.transcript.fromCache).toBe(false);
    expect(retried.body.transcript.text).toContain("sample transcript");
  });

  it("keeps creators, feeds, transcripts, and settings across a server restart", async () => {
    // Persist one setting change before the restart so its survival can be
    // asserted afterwards.
    const putSetting = await fetch(`${server.baseUrl}/api/settings/recent-items-per-tab`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: 55 }),
    });
    expect(putSetting.status).toBe(200);

    await stopServer(server);
    const restarted = await startServer();
    Object.assign(server, restarted);

    const health = await getJson<HealthPayload>("/api/health");
    expect(health.status).toBe(200);
    expect(health.body.ytdlp.available).toBe(true);

    const library = await getJson<CreatorsListPayload>("/api/creators");
    expect(library.body.creators).toHaveLength(1);
    expect(library.body.creators[0].displayName).toBe("E2E Sample Channel");

    const feed = await getJson<FeedPayload>(`/api/creators/${creatorId}/feed`);
    expect(feed.body.videos).toHaveLength(2);
    expect(feed.body.lastRefreshedAt).not.toBeNull();

    const setting = await getJson<{ value: number }>("/api/settings/recent-items-per-tab");
    expect(setting.body.value).toBe(55);

    // Cached transcripts are served without running yt-dlp again.
    const transcript = await getJson<TranscriptPayload>(
      `/api/creators/${creatorId}/videos/${goodVideoId}/transcript`,
    );
    expect(transcript.status).toBe(200);
    expect(transcript.body.transcript.fromCache).toBe(true);
  });

  it("never leaks local filesystem details in any API response", () => {
    const everything = responseBodies.join("\n");
    expect(everything).not.toContain(workDir);
    expect(everything).not.toContain(tmpdir());
    expect(everything).not.toContain("stderr");
    expect(everything).not.toContain(REPO_ROOT);
  });
});
