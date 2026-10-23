/**
 * /api/x-dashboard/sync as the source pickers use it: a status read for just
 * their accounts, and a start that does nothing while X can't be read —
 * saying why once, instead of a read per account that can only fail.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/x-dashboard/sync/route";
import { addCreator } from "@/lib/creators/repository";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { connectionProblem } from "@/lib/x/dashboard/sync";
import type { XConnectionStatus } from "@/lib/x/model";
import type { RetrievalCreatorState } from "@/lib/x/research/retrieval-model";

let db: Database.Database;
let connection: XConnectionStatus;
const start = vi.fn((input: { creatorIds: number[] }) => ({ id: "job", request: input }));
const resumeBackfills = vi.fn(() => 0);
const creatorStates = vi.fn((ids: number[]): RetrievalCreatorState[] =>
  ids.map((creatorId) => ({
    creatorId,
    initialized: true,
    lastSuccessfulRefresh: "2026-10-20T10:00:00.000Z",
    coveredSince: null,
    head: null,
    history: null,
  })),
);
vi.mock("@/lib/db/connection", () => ({ getDb: () => db }));
vi.mock("@/lib/x/research/retrieval", () => ({
  getRetrievalEngine: () => ({ start, resumeBackfills, creatorStates }),
}));
vi.mock("@/lib/x/service", () => ({ getXConnectionStatus: async () => connection }));

function status(change: Partial<XConnectionStatus>): XConnectionStatus {
  return {
    capability: "connected",
    providerId: "desktop",
    user: null,
    errorCode: null,
    sessionOnly: false,
    ...change,
  };
}

function creator(handle: string): number {
  return addCreator(db, {
    platform: "x",
    platformUserId: `${handle}-id`,
    youtubeChannelId: null,
    displayName: handle,
    handle,
    channelUrl: `https://x.com/${handle}`,
    avatarUrl: null,
  }).creator.id;
}

function post(body: unknown): Request {
  return new Request("http://127.0.0.1:3000/api/x-dashboard/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  connection = status({});
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
});
afterEach(() => db.close());

describe("connectionProblem", () => {
  it("says why X can't be read, in the sync states' words", () => {
    expect(connectionProblem(status({}))).toBeNull();
    expect(connectionProblem(status({ capability: "session_only" }))).toBeNull();
    expect(
      connectionProblem(status({ capability: "unavailable", errorCode: "unsupported_runtime" })),
    ).toBe("Getting posts from X needs the Scope desktop app.");
    expect(connectionProblem(status({ capability: "disconnected" }))).toBe(
      "Connect your X account in Settings to get new posts.",
    );
    expect(
      connectionProblem(status({ capability: "disconnected", errorCode: "session_expired" })),
    ).toBe("Your X session expired. Reconnect in Settings.");
  });
});

describe("/api/x-dashboard/sync", () => {
  it("reads the sync state of just the accounts asked about", async () => {
    const a = creator("a");
    creator("b");
    const response = GET(new Request(`http://127.0.0.1:3000/api/x-dashboard/sync?creators=${a}`));
    const body = (await response.json()) as { sync: { creators: Array<{ creatorId: number }> } };
    expect(response.status).toBe(200);
    expect(body.sync.creators.map((state) => state.creatorId)).toEqual([a]);
  });

  it("starts nothing while X can't be read, and says why", async () => {
    const a = creator("a");
    connection = status({ capability: "disconnected" });
    const response = await POST(post({ creatorIds: [a], listId: null, ifConnected: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      started: false,
      reason: "disconnected",
      message: "Connect your X account in Settings to get new posts.",
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("starts the sync when X is connected", async () => {
    const a = creator("a");
    const b = creator("b");
    const response = await POST(post({ creatorIds: [a, b], listId: null, ifConnected: true }));
    expect(response.status).toBe(202);
    expect(start.mock.calls[0][0]).toMatchObject({ kind: "refresh", creatorIds: [a, b] });
  });
});
