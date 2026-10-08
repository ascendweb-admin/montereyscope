import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { addCreator } from "@/lib/creators/repository";
import { saveResearchList } from "@/lib/x/research/repository";
import { POST, GET } from "@/app/api/x-research/retrieval/route";
import { POST as control } from "@/app/api/x-research/retrieval/[id]/route";

let db: Database.Database;
const start = vi.fn((input) => ({ id: "job", request: input }));
const resume = vi.fn((id) => ({ id }));
const cancel = vi.fn((id) => ({ id }));
const jobs = vi.fn(() => []);
const coverage = vi.fn(() => []);
vi.mock("@/lib/db/connection", () => ({ getDb: () => db }));
vi.mock("@/lib/x/research/retrieval", () => ({
  getRetrievalEngine: () => ({ start, resume, cancel, jobs, coverage }),
}));
function request(body: unknown, headers = {}) {
  return new Request("http://127.0.0.1:3000/api/x-research/retrieval", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
function creator(name: string) {
  return addCreator(db, {
    platform: "x",
    platformUserId: name,
    youtubeChannelId: null,
    displayName: name,
    handle: name,
    channelUrl: `https://x.com/${name}`,
    avatarUrl: null,
  }).creator.id;
}
beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
});
afterEach(() => db.close());
it("snapshots the entire list for refresh regardless of selected creators, without accepting a client label", async () => {
  const a = creator("a"),
    b = creator("b");
  const list = saveResearchList(db, { name: "Entire list", creatorIds: [a, b] });
  const result = await POST(
    request({ kind: "refresh", listId: list.id, creatorIds: [a], label: "wrong" }),
  );
  expect(result.status).toBe(202);
  expect(start.mock.calls[0][0]).toMatchObject({
    label: "Entire list",
    creatorIds: [a, b],
    initialDays: 30,
    maxPages: null,
  });
});
it("historical retrieval uses only selected list creators and inclusive timezone calendar bounds", async () => {
  const a = creator("a"),
    b = creator("b");
  const list = saveResearchList(db, { name: "History", creatorIds: [a, b] });
  const result = await POST(
    request({
      kind: "history",
      listId: list.id,
      creatorIds: [b],
      start: "2026-03-29",
      end: "2026-03-29",
      timezone: "Europe/Amsterdam",
    }),
  );
  expect(result.status).toBe(202);
  expect(start.mock.calls[0][0]).toMatchObject({
    creatorIds: [b],
    since: "2026-03-28T23:00:00.000Z",
    until: "2026-03-29T22:00:00.000Z",
  });
});
it("rejects creators outside the historical list, invalid dates and unbounded budgets", async () => {
  const a = creator("a"),
    b = creator("b");
  const list = saveResearchList(db, { name: "History", creatorIds: [a] });
  for (const body of [
    { kind: "history", listId: list.id, creatorIds: [b] },
    { kind: "history", creatorIds: [a], start: "bad", end: "bad" },
    { kind: "refresh", creatorIds: [a], maxPages: 301 },
    { kind: "refresh", creatorIds: [a], initialDays: 0 },
    { kind: "something", creatorIds: [a] },
  ])
    expect((await POST(request(body))).status).toBe(400);
  expect(start).not.toHaveBeenCalled();
});
it("rejects cross-origin and oversized mutations before starting network work", async () => {
  expect((await POST(request({}, { Origin: "https://example.com" }))).status).toBe(403);
  expect((await POST(request({ value: "a".repeat(9000) }))).status).toBe(413);
  expect(start).not.toHaveBeenCalled();
});
it("local progress reads never start or resume jobs", async () => {
  const a = creator("a");
  expect(
    GET(new Request(`http://127.0.0.1:3000/api/x-research/retrieval?creators=${a}`)).status,
  ).toBe(200);
  expect(jobs).toHaveBeenCalledOnce();
  expect(coverage).toHaveBeenCalledWith([a]);
  expect(start).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
});
it("only explicit valid controls call Cancel and Resume", async () => {
  const context = { params: Promise.resolve({ id: "job" }) };
  expect((await control(request({ action: "resume" }), context)).status).toBe(200);
  expect((await control(request({ action: "cancel" }), context)).status).toBe(200);
  expect((await control(request({ action: "automatic" }), context)).status).toBe(400);
  expect(resume).toHaveBeenCalledWith("job");
  expect(cancel).toHaveBeenCalledWith("job");
});
