"use strict";

/**
 * macOS code-signing and notarization mode selection (desktop release stages 4-5).
 *
 * Certificates, passwords, and Apple credentials never live in the
 * repository: electron-builder reads the certificate from CI secrets through
 * CSC_LINK / CSC_KEY_PASSWORD (or the MAC_ variants) and the notarization
 * credentials from the standard APPLE_* environment variables. This helper
 * exists so the build can:
 *
 * - fail fast when a signed distribution build is required
 *   (`SCOPE_DESKTOP_MAC_REQUIRE_SIGNING=1`) but credentials are absent,
 * - fail fast on a half-configured secret set instead of silently producing
 *   an artifact that looks signed,
 * - clearly identify the ad-hoc engineering build, which can launch only on
 *   the build Mac and is not notarized for other machines.
 *
 * The returned plan never contains certificate or credential material.
 */

const REQUIRE_SIGNING_ENV = "SCOPE_DESKTOP_MAC_REQUIRE_SIGNING";
const NOTARIZE_ENV_VARS = [
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_KEYCHAIN",
  "APPLE_KEYCHAIN_PROFILE",
];

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

// Keep secrets in the environment, not builder config (which is written to
// builder-effective-config.yaml). Match the precedence used by macSigningPlan.
function normalizeMacSigningEnvironment(env = process.env) {
  for (const key of ["CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME"]) {
    const value = firstNonEmpty(env[`MAC_${key}`], env[key]);
    if (value !== null) env[key] = value;
    else delete env[key];
  }
}

/**
 * The notarization credential mode electron-builder's @electron/notarize
 * integration accepts, or null when none is configured. A partial set is an
 * error: notarization must never be skipped silently after credentials were
 * provided.
 */
function notarizationMode(env) {
  const appleId = firstNonEmpty(env.APPLE_ID);
  const applePassword = firstNonEmpty(env.APPLE_APP_SPECIFIC_PASSWORD);
  const teamId = firstNonEmpty(env.APPLE_TEAM_ID);
  const apiKey = firstNonEmpty(env.APPLE_API_KEY);
  const apiKeyId = firstNonEmpty(env.APPLE_API_KEY_ID);
  const apiIssuer = firstNonEmpty(env.APPLE_API_ISSUER);
  const keychainProfile = firstNonEmpty(env.APPLE_KEYCHAIN_PROFILE);

  const configured = [
    appleId,
    applePassword,
    teamId,
    apiKey,
    apiKeyId,
    apiIssuer,
    keychainProfile,
  ].filter((value) => value !== null).length;
  if (configured === 0) {
    return null;
  }
  if (appleId !== null || applePassword !== null || teamId !== null) {
    if (appleId === null || applePassword === null || teamId === null) {
      throw new Error(
        "macOS notarization is half-configured: set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, " +
          "and APPLE_TEAM_ID together (or use the APPLE_API_KEY credentials, or an " +
          "APPLE_KEYCHAIN_PROFILE).",
      );
    }
    return "apple-id";
  }
  if (apiKey !== null || apiKeyId !== null || apiIssuer !== null) {
    if (apiKey === null || apiKeyId === null || apiIssuer === null) {
      throw new Error(
        "macOS notarization is half-configured: set APPLE_API_KEY, APPLE_API_KEY_ID, and " +
          "APPLE_API_ISSUER together.",
      );
    }
    return "api-key";
  }
  return "keychain-profile";
}

/**
 * @returns {{ mode: "signed-notarized" | "unsigned-engineering", signed: boolean,
 *             notarize: boolean, adHoc: boolean, hardenedRuntime: boolean,
 *             reason: string, requireSigning: boolean }}
 */
function macSigningPlan(env = process.env) {
  const link = firstNonEmpty(env.MAC_CSC_LINK, env.CSC_LINK);
  const password = firstNonEmpty(env.MAC_CSC_KEY_PASSWORD, env.CSC_KEY_PASSWORD);
  const name = firstNonEmpty(env.MAC_CSC_NAME, env.CSC_NAME);
  const requireSigning = requiresSigning(env);
  const notarization = notarizationMode(env);

  if ((link === null) !== (password === null)) {
    throw new Error(
      "macOS signing is half-configured: set both CSC_LINK (or MAC_CSC_LINK) and " +
        "CSC_KEY_PASSWORD (or MAC_CSC_KEY_PASSWORD), or neither.",
    );
  }
  const hasCertificate = link !== null || name !== null;
  if (!hasCertificate && notarization !== null) {
    throw new Error(
      "macOS notarization credentials are configured without a signing certificate. " +
        "Notarization requires a Developer ID signature; set CSC_LINK/CSC_KEY_PASSWORD " +
        "(or CSC_NAME) or remove the APPLE_* variables.",
    );
  }
  if (hasCertificate && notarization === null) {
    throw new Error(
      "macOS signing is half-configured: a Developer ID certificate is configured but " +
        "no notarization credentials are. Set APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/" +
        "APPLE_TEAM_ID, the APPLE_API_KEY credentials, or an APPLE_KEYCHAIN_PROFILE; " +
        "otherwise build without the signing secrets for an engineering build.",
    );
  }
  if (!hasCertificate) {
    if (requireSigning) {
      throw new Error(
        `macOS signing is required (${REQUIRE_SIGNING_ENV}) but no certificate secrets are ` +
          "configured. Add the CSC_LINK and CSC_KEY_PASSWORD repository secrets (and the " +
          "Apple notarization credentials), or unset the requirement for an ad-hoc " +
          "engineering build.",
      );
    }
    return {
      mode: "unsigned-engineering",
      signed: false,
      notarize: false,
      adHoc: true,
      hardenedRuntime: false,
      reason:
        "no signing or notarization secrets configured; this is an ad-hoc engineering build " +
        "that is not notarized for other Macs",
      requireSigning,
    };
  }
  return {
    mode: "signed-notarized",
    signed: true,
    notarize: true,
    adHoc: false,
    hardenedRuntime: true,
    reason: "a Developer ID certificate and notarization credentials are configured",
    requireSigning,
  };
}

/** One-line build log description; never includes certificate material. */
function describeMacSigning(plan) {
  if (plan.mode === "signed-notarized") {
    return `macOS signing: Developer ID + notarization enabled (${plan.reason}).`;
  }
  return (
    "macOS signing: ENGINEERING AD-HOC BUILD - not signed with a Developer ID and not " +
    "notarized. Gatekeeper will block this artifact on other Macs; use it only for local " +
    "checks. The release build requires the Apple signing and notarization credentials."
  );
}

module.exports = {
  NOTARIZE_ENV_VARS,
  REQUIRE_SIGNING_ENV,
  describeMacSigning,
  macSigningPlan,
  notarizationMode,
  normalizeMacSigningEnvironment,
};
