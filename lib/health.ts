import { getDb } from "@/lib/db/connection";
import { getYtDlpVersion } from "@/lib/ytdlp/version";

export interface HealthReport {
  status: "ok" | "degraded";
  app: {
    name: "scope";
    status: "ready";
  };
  database: {
    connected: boolean;
  };
  ytdlp: {
    available: boolean;
    /** yt-dlp version string when available. */
    version?: string;
  };
}

export interface HealthCheckDeps {
  checkDatabase: () => void;
  getYtDlpVersion: () => Promise<string | null>;
}

export const defaultHealthCheckDeps: HealthCheckDeps = {
  checkDatabase: () => {
    // Connectivity probe only; never selects user data into responses.
    getDb().prepare("SELECT 1 AS ok").get();
  },
  getYtDlpVersion: () => getYtDlpVersion(),
};

/**
 * Collects safe-to-publish health information: application readiness,
 * database connectivity, and yt-dlp availability plus version.
 * Deliberately excludes filesystem paths and any local environment detail.
 */
export async function collectHealthReport(
  deps: HealthCheckDeps = defaultHealthCheckDeps,
): Promise<HealthReport> {
  let databaseConnected = false;
  try {
    deps.checkDatabase();
    databaseConnected = true;
  } catch {
    databaseConnected = false;
  }

  let ytdlpAvailable = false;
  let ytdlpVersion: string | undefined;
  try {
    const rawVersion = await deps.getYtDlpVersion();
    if (rawVersion !== null && rawVersion.trim().length > 0) {
      ytdlpVersion = rawVersion.trim();
      ytdlpAvailable = true;
    }
  } catch {
    ytdlpAvailable = false;
  }

  const degraded = !databaseConnected || !ytdlpAvailable;

  return {
    status: degraded ? "degraded" : "ok",
    app: { name: "scope", status: "ready" },
    database: { connected: databaseConnected },
    ytdlp: {
      available: ytdlpAvailable,
      ...(ytdlpAvailable && ytdlpVersion ? { version: ytdlpVersion } : {}),
    },
  };
}
