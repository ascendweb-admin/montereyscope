"use strict";

/**
 * Windows code-signing mode selection (desktop release stage 3).
 *
 * Certificates and passwords never live in the repository: electron-builder
 * reads them from CI secrets through CSC_LINK / CSC_KEY_PASSWORD (or the
 * WIN_ variants). This helper exists so the build can:
 *
 * - fail fast when signing is required (`SCOPE_DESKTOP_WINDOWS_REQUIRE_SIGNING=1`)
 *   but no credentials are present,
 * - loudly identify an unsigned artifact as the friends-beta mode instead of
 *   letting it pass silently,
 * - reject a half-configured secret set rather than producing an unsigned
 *   build that looks intended.
 *
 * The returned plan never contains certificate material.
 */

const REQUIRE_SIGNING_ENV = "SCOPE_DESKTOP_WINDOWS_REQUIRE_SIGNING";

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function requiresSigning(env) {
  return ["1", "true", "yes"].includes((env[REQUIRE_SIGNING_ENV] ?? "").toLowerCase());
}

// electron-builder treats an empty CSC_LINK as a path to the project directory.
// Remove CI's empty secret values before its certificate discovery runs.
function normalizeWindowsSigningEnvironment(env = process.env) {
  for (const key of ["CSC_LINK", "CSC_KEY_PASSWORD", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"]) {
    if (firstNonEmpty(env[key]) === null) delete env[key];
  }
}

/**
 * @returns {{ mode: "signed" | "unsigned-friends-beta", signed: boolean,
 *             reason: string, requireSigning: boolean }}
 */
function windowsSigningPlan(env = process.env) {
  const link = firstNonEmpty(env.WIN_CSC_LINK, env.CSC_LINK);
  const password = firstNonEmpty(env.WIN_CSC_KEY_PASSWORD, env.CSC_KEY_PASSWORD);
  const requireSigning = requiresSigning(env);
  if ((link === null) !== (password === null)) {
    throw new Error(
      "Windows signing is half-configured: set both CSC_LINK (or WIN_CSC_LINK) and " +
        "CSC_KEY_PASSWORD (or WIN_CSC_KEY_PASSWORD), or neither.",
    );
  }
  if (link === null) {
    if (requireSigning) {
      throw new Error(
        `Windows signing is required (${REQUIRE_SIGNING_ENV}) but no certificate secrets are ` +
          "configured. Add the CSC_LINK and CSC_KEY_PASSWORD repository secrets, or unset the " +
          "requirement for an explicitly unsigned friends-beta build.",
      );
    }
    return {
      mode: "unsigned-friends-beta",
      signed: false,
      reason:
        "no code-signing secrets configured; this build is the explicit unsigned friends-beta " +
        "artifact",
      requireSigning,
    };
  }
  return {
    mode: "signed",
    signed: true,
    reason: "code-signing secrets are configured",
    requireSigning,
  };
}

/** One-line build log description; never includes certificate material. */
function describeWindowsSigning(plan) {
  if (plan.mode === "signed") {
    return `Windows signing: enabled (${plan.reason}).`;
  }
  return (
    "Windows signing: DISABLED - unsigned friends-beta build. " +
    "Windows SmartScreen may warn on first launch; signing would not guarantee " +
    "immediate SmartScreen reputation either."
  );
}

module.exports = {
  REQUIRE_SIGNING_ENV,
  describeWindowsSigning,
  normalizeWindowsSigningEnvironment,
  windowsSigningPlan,
};
