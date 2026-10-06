import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { INITIAL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { collectHealthReport, collectReadinessReport, type HealthCheckDeps } from "@/lib/health";

const tempDirs: string[] = [];
const databases: Database.Database[] = [];

afterAll(() => {
  for (const db of databases) {
    if (db.open) db.close();
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Real SQLite probe against a migrated temp database — no mocking of the DB path. */
function makeDatabaseProbe(): HealthCheckDeps["checkDatabase"] {
  const dir = mkdtempSync(path.join(tmpdir(), "localtube-health-"));
  tempDirs.push(dir);
  const db = new Database(path.join(dir, "health.db"));
  databases.push(db);
  db.pragma("foreign_keys = ON");
  runMigrations(db, INITIAL_MIGRATIONS);
  return () => {
    db.prepare("SELECT 1 AS ok").get();
  };
}

function failingDatabaseProbe(): HealthCheckDeps["checkDatabase"] {
  return () => {
    throw new Error("simulated database outage");
  };
}

describe("collectReadinessReport", () => {
  it("reports a migrated database ready without waiting for a downloader that never finishes", () => {
    let downloaderStarted = false;
    const deps: HealthCheckDeps = {
      checkDatabase: makeDatabaseProbe(),
      getYtDlpVersion: () => {
        downloaderStarted = true;
        return new Promise(() => {});
      },
    };
    expect(collectReadinessReport(deps)).toEqual({
      status: "ok",
      app: { name: "scope", status: "ready" },
      database: { connected: true },
    });
    expect(downloaderStarted).toBe(false);
  });

  it("still blocks startup when the database cannot be opened", () => {
    expect(collectReadinessReport({ checkDatabase: failingDatabaseProbe() })).toEqual({
      status: "degraded",
      app: { name: "scope", status: "ready" },
      database: { connected: false },
    });
  });
});

describe("collectHealthReport", () => {
  it("reports ok with database connected and yt-dlp version when both are healthy", async () => {
    const report = await collectHealthReport({
      checkDatabase: makeDatabaseProbe(),
      getYtDlpVersion: async () => "2026.08.19",
    });

    expect(report.status).toBe("ok");
    expect(report.app.name).toBe("scope");
    expect(report.database.connected).toBe(true);
    expect(report.ytdlp.available).toBe(true);
    expect(report.ytdlp.version).toBe("2026.08.19");
  });

  it("degrades without a version string when yt-dlp is missing", async () => {
    const report = await collectHealthReport({
      checkDatabase: makeDatabaseProbe(),
      getYtDlpVersion: async () => {
        throw new Error("spawn yt-dlp ENOENT");
      },
    });

    expect(report.status).toBe("degraded");
    expect(report.database.connected).toBe(true);
    expect(report.ytdlp.available).toBe(false);
    expect(report.ytdlp.version).toBeUndefined();
  });

  it("degrades when the database probe throws", async () => {
    const report = await collectHealthReport({
      checkDatabase: failingDatabaseProbe(),
      getYtDlpVersion: async () => "2026.08.19",
    });

    expect(report.status).toBe("degraded");
    expect(report.database.connected).toBe(false);
    expect(report.ytdlp.available).toBe(true);
    expect(report.ytdlp.version).toBe("2026.08.19");
  });

  it("never exposes filesystem paths in the serialized report", async () => {
    const report = await collectHealthReport({
      checkDatabase: makeDatabaseProbe(),
      getYtDlpVersion: async () => "2026.08.19",
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(tmpdir());
    expect(serialized).not.toContain(process.cwd());
    expect(serialized).not.toContain("/");
  });

  it("treats an empty yt-dlp version as unavailable", async () => {
    const report = await collectHealthReport({
      checkDatabase: makeDatabaseProbe(),
      getYtDlpVersion: async () => "   ",
    });

    expect(report.ytdlp.available).toBe(false);
    expect(report.status).toBe("degraded");
  });
});
