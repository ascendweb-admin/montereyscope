"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  describeMacSigning,
  macSigningPlan,
  notarizationMode,
  normalizeMacSigningEnvironment,
} = require("../scripts/mac-signing.cjs");

test("Mac aliases reach electron-builder's actual certificate/password/name readers", () => {
  const env = {
    MAC_CSC_LINK: "certificate",
    MAC_CSC_KEY_PASSWORD: "password",
    MAC_CSC_NAME: "Developer ID Application: Scope",
    CSC_LINK: "other-platform",
  };
  normalizeMacSigningEnvironment(env);
  // Exercise the installed builder's readers rather than only our helper.
  require("app-builder-lib"); // Initialize its circular exports through the public entrypoint.
  const { PlatformPackager } = require("app-builder-lib/out/platformPackager");
  const saved = { ...process.env };
  try {
    Object.assign(process.env, env);
    const packager = Object.create(PlatformPackager.prototype);
    packager.info = { config: {} };
    packager.platformSpecificBuildOptions = {};
    assert.equal(packager.getCscLink(), "certificate");
    assert.equal(packager.getCscPassword(), "password");
    assert.equal(process.env.CSC_NAME, "Developer ID Application: Scope");
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("empty CI signing secrets are absent from electron-builder's readers", () => {
  const env = { CSC_LINK: "", CSC_KEY_PASSWORD: "", CSC_NAME: "" };
  normalizeMacSigningEnvironment(env);
  assert.equal("CSC_LINK" in env, false);
  assert.equal("CSC_KEY_PASSWORD" in env, false);
  assert.equal("CSC_NAME" in env, false);
});

test("missing secrets select the ad-hoc engineering mode", () => {
  const plan = macSigningPlan({});
  assert.equal(plan.mode, "unsigned-engineering");
  assert.equal(plan.signed, false);
  assert.equal(plan.adHoc, true);
  assert.equal(plan.notarize, false);
  const description = describeMacSigning(plan);
  assert.match(description, /ENGINEERING/);
  assert.match(description, /Gatekeeper/);
});

test("configured secrets select signed and notarized mode without echoing them", () => {
  const plan = macSigningPlan({
    CSC_LINK: "base64:very-secret-certificate",
    CSC_KEY_PASSWORD: "very-secret-password",
    APPLE_ID: "release@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "very-secret-app-password",
    APPLE_TEAM_ID: "TEAMID123",
  });
  assert.equal(plan.mode, "signed-notarized");
  assert.equal(plan.signed, true);
  assert.equal(plan.notarize, true);
  assert.equal(plan.adHoc, false);
  assert.equal(plan.hardenedRuntime, true);
  const description = describeMacSigning(plan);
  assert.doesNotMatch(description, /very-secret/);
  assert.doesNotMatch(description, /release@example/);
});

test("the MAC_ variants and API-key notarization are accepted", () => {
  const plan = macSigningPlan({
    MAC_CSC_LINK: "base64:cert",
    MAC_CSC_KEY_PASSWORD: "password",
    APPLE_API_KEY: "/tmp/AuthKey.p8",
    APPLE_API_KEY_ID: "KEYID123",
    APPLE_API_ISSUER: "issuer-uuid",
  });
  assert.equal(plan.mode, "signed-notarized");
  assert.equal(
    notarizationMode({ APPLE_API_KEY: "k", APPLE_API_KEY_ID: "i", APPLE_API_ISSUER: "u" }),
    "api-key",
  );
});

test("half-configured signing or notarization secrets are rejected", () => {
  assert.throws(() => macSigningPlan({ CSC_LINK: "base64:cert" }), /half-configured/);
  assert.throws(() => macSigningPlan({ MAC_CSC_KEY_PASSWORD: "password" }), /half-configured/);
  assert.throws(() => macSigningPlan({ APPLE_ID: "release@example.com" }), /half-configured/);
  assert.throws(
    () => macSigningPlan({ APPLE_API_KEY: "k", APPLE_API_KEY_ID: "i" }),
    /half-configured/,
  );
});

test("certificate without notarization credentials is rejected", () => {
  assert.throws(
    () => macSigningPlan({ CSC_LINK: "base64:cert", CSC_KEY_PASSWORD: "password" }),
    /no notarization credentials/,
  );
});

test("notarization credentials without a certificate are rejected", () => {
  assert.throws(
    () =>
      macSigningPlan({
        APPLE_ID: "release@example.com",
        APPLE_APP_SPECIFIC_PASSWORD: "password",
        APPLE_TEAM_ID: "TEAMID123",
      }),
    /without a signing certificate/,
  );
});

test("required signing fails fast when credentials are absent", () => {
  assert.throws(
    () => macSigningPlan({ SCOPE_DESKTOP_MAC_REQUIRE_SIGNING: "1" }),
    /signing is required/i,
  );
  const required = macSigningPlan({
    SCOPE_DESKTOP_MAC_REQUIRE_SIGNING: "1",
    CSC_LINK: "base64:cert",
    CSC_KEY_PASSWORD: "password",
    APPLE_ID: "release@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "password",
    APPLE_TEAM_ID: "TEAMID123",
  });
  assert.equal(required.mode, "signed-notarized");
});

test("workflow gives signing requirements only to release builds", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "../../.github/workflows/desktop-build.yml"),
    "utf8",
  );
  const expressions = [
    ...workflow.matchAll(/SCOPE_DESKTOP_MAC_REQUIRE_SIGNING: \$\{\{ (.+?) \}\}/g),
  ];
  assert.equal(expressions.length, 2, "build and verification must both choose a signing policy");
  for (const [, expression] of expressions) {
    // These Actions expressions also use valid JS boolean/property syntax.
    const evaluate = new Function("matrix", "inputs", "vars", `return (${expression});`);
    const vars = { SCOPE_DESKTOP_MAC_REQUIRE_SIGNING: "1" };
    for (const event of ["pull_request", "push", "workflow_dispatch"]) {
      const requirement = evaluate(
        { target_platform: "darwin" },
        { release_tag: event === "workflow_dispatch" ? "v1.2.3" : "" },
        vars,
      );
      if (event !== "workflow_dispatch") {
        assert.equal(
          macSigningPlan({ SCOPE_DESKTOP_MAC_REQUIRE_SIGNING: requirement }).mode,
          "unsigned-engineering",
        );
      } else {
        assert.throws(
          () => macSigningPlan({ SCOPE_DESKTOP_MAC_REQUIRE_SIGNING: requirement }),
          /signing is required/i,
        );
      }
    }
  }
});
