import { getDb } from "@/lib/db/connection";
import { getYtDlpVersion } from "@/lib/ytdlp/version";

export interface ReadinessReport {
  status: "ok" | "degraded";
  app: {
    name: "scope";
    status: "ready";
  };
  database: {
    connected: boolean;
  };
}

export interface HealthReport extends ReadinessReport {
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

/** Startup readiness depends on the app database, without launching external tools. */
export function collectReadinessReport(
  deps: Pick<HealthCheckDeps, "checkDatabase"> = defaultHealthCheckDeps,
): ReadinessReport {
  let databaseConnected = false;
  try {
    deps.checkDatabase();
    databaseConnected = true;
  } catch {
    databaseConnected = false;
  }
  return {
    status: databaseConnected ? "ok" : "degraded",
    app: { name: "scope", status: "ready" },
    database: { connected: databaseConnected },
  };
}

/**
 * Collects safe-to-publish health information: application readiness,
 * database connectivity, and yt-dlp availability plus version.
 * Deliberately excludes filesystem paths and any local environment detail.
 */
export async function collectHealthReport(
  deps: HealthCheckDeps = defaultHealthCheckDeps,
): Promise<HealthReport> {
  const readiness = collectReadinessReport(deps);

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

  const degraded = !readiness.database.connected || !ytdlpAvailable;

  return {
    ...readiness,
    status: degraded ? "degraded" : "ok",
    ytdlp: {
      available: ytdlpAvailable,
      ...(ytdlpAvailable && ytdlpVersion ? { version: ytdlpVersion } : {}),
    },
  };
}
