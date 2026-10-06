import fs from "node:fs";

import { getAiAuthStatus } from "@/lib/ai/auth";
import { getAuthManager } from "@/lib/ai/auth/manager";
import {
  authJson,
  crossOriginRejection,
  isSameOriginMutation,
  readBoundedJson,
} from "@/lib/ai/auth/http";
import { isAuthProviderId, type AuthOperationResult } from "@/lib/ai/auth-types";
import { resetClaudeCommandCache } from "@/lib/ai/claude";
import { resetOpencodeCommandCache } from "@/lib/ai/opencode";
import {
  MAX_PROVIDER_PATH_LENGTH,
  setProviderPathOverride,
  validateProviderPath,
} from "@/lib/ai/provider-paths";
import { getDb } from "@/lib/db/connection";
import { getAiBackend } from "@/lib/settings/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ provider: string }>;
}

/**
 * A bare command name is resolved through PATH at spawn time; a path with a
 * separator must exist now (and be executable on POSIX) so an obvious typo
 * fails with a clear message instead of a confusing status probe.
 */
function executableLooksUsable(value: string): boolean {
  if (!value.includes("/") && !value.includes("\\")) {
    return true;
  }
  try {
    fs.accessSync(value, fs.constants.F_OK);
    if (process.platform !== "win32") {
      fs.accessSync(value, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function resetResolutionCaches(provider: "codex" | "opencode" | "claude"): void {
  if (provider === "claude") {
    resetClaudeCommandCache();
  } else if (provider === "opencode") {
    resetOpencodeCommandCache();
  }
  getAuthManager().invalidateProviderResolution(provider);
}

async function snapshotResponse() {
  const backend = getAiBackend(getDb());
  const snapshot = await getAiAuthStatus(backend);
  return authJson({ ok: true, snapshot } satisfies AuthOperationResult);
}

/**
 * Sets the executable-path override for one provider. The value is passed as
 * a single spawn argument to that provider's own CLI; it never reaches a
 * shell. Saving an empty or invalid value is refused.
 */
export async function POST(request: Request, ctx: RouteParams) {
  if (!isSameOriginMutation(request)) {
    return crossOriginRejection();
  }
  const { provider } = await ctx.params;
  if (!isAuthProviderId(provider)) {
    return authJson(
      { ok: false, error: { code: "unknown_provider", message: "Unknown AI provider." } },
      404,
    );
  }
  const body = await readBoundedJson(request);
  if (!body.ok) {
    return body.response;
  }
  const raw = (body.value as Record<string, unknown>)?.path;
  const normalized = validateProviderPath(raw);
  if (normalized === null) {
    return authJson(
      {
        ok: false,
        error: {
          code: "invalid_path",
          message: `Enter an absolute executable path or a command name without directories (up to ${MAX_PROVIDER_PATH_LENGTH} characters).`,
        },
      },
      400,
    );
  }
  if (!executableLooksUsable(normalized)) {
    return authJson(
      {
        ok: false,
        error: {
          code: "invalid_path",
          message: "That file does not exist or is not executable. Check the path and try again.",
        },
      },
      400,
    );
  }
  try {
    setProviderPathOverride(getDb(), provider, normalized);
    resetResolutionCaches(provider);
    return await snapshotResponse();
  } catch (error) {
    console.error("[api/ai/auth/path] saving the provider path failed:", error);
    return authJson(
      {
        ok: false,
        error: { code: "save_failed", message: "The executable path could not be saved." },
      },
      500,
    );
  }
}

/** Clears the override and returns to automatic discovery. */
export async function DELETE(request: Request, ctx: RouteParams) {
  if (!isSameOriginMutation(request)) {
    return crossOriginRejection();
  }
  const { provider } = await ctx.params;
  if (!isAuthProviderId(provider)) {
    return authJson(
      { ok: false, error: { code: "unknown_provider", message: "Unknown AI provider." } },
      404,
    );
  }
  try {
    setProviderPathOverride(getDb(), provider, null);
    resetResolutionCaches(provider);
    return await snapshotResponse();
  } catch (error) {
    console.error("[api/ai/auth/path] clearing the provider path failed:", error);
    return authJson(
      {
        ok: false,
        error: { code: "save_failed", message: "The executable path could not be cleared." },
      },
      500,
    );
  }
}
