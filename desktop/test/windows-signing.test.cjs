"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  describeWindowsSigning,
  normalizeWindowsSigningEnvironment,
  windowsSigningPlan,
} = require("../scripts/windows-signing.cjs");

test("empty CI signing secrets are absent from electron-builder's readers", () => {
  const env = {
    CSC_LINK: "",
    CSC_KEY_PASSWORD: "",
    WIN_CSC_LINK: "",
    WIN_CSC_KEY_PASSWORD: "",
  };
  normalizeWindowsSigningEnvironment(env);
  assert.deepEqual(env, {});
});

test("missing secrets select the explicit unsigned friends-beta mode", () => {
  const plan = windowsSigningPlan({});
  assert.equal(plan.mode, "unsigned-friends-beta");
  assert.equal(plan.signed, false);
  const description = describeWindowsSigning(plan);
  assert.match(description, /unsigned/i);
  assert.match(description, /SmartScreen/i);
});

test("configured secrets select the signed mode without echoing them", () => {
  const plan = windowsSigningPlan({
    CSC_LINK: "base64:very-secret-certificate",
    CSC_KEY_PASSWORD: "very-secret-password",
  });
  assert.equal(plan.mode, "signed");
  assert.equal(plan.signed, true);
  const description = describeWindowsSigning(plan);
  assert.doesNotMatch(description, /very-secret/);
});

test("the WIN_ variants are accepted alongside the generic ones", () => {
  const plan = windowsSigningPlan({
    WIN_CSC_LINK: "base64:cert",
    WIN_CSC_KEY_PASSWORD: "password",
  });
  assert.equal(plan.mode, "signed");
});

test("half-configured signing secrets are rejected", () => {
  assert.throws(() => windowsSigningPlan({ CSC_LINK: "base64:cert" }), /half-configured/);
  assert.throws(() => windowsSigningPlan({ CSC_KEY_PASSWORD: "password" }), /half-configured/);
});

test("required signing fails fast when credentials are absent", () => {
  assert.throws(
    () => windowsSigningPlan({ SCOPE_DESKTOP_WINDOWS_REQUIRE_SIGNING: "1" }),
    /signing is required/i,
  );
  const required = windowsSigningPlan({
    SCOPE_DESKTOP_WINDOWS_REQUIRE_SIGNING: "1",
    CSC_LINK: "base64:cert",
    CSC_KEY_PASSWORD: "password",
  });
  assert.equal(required.mode, "signed");
});

test("required signing accepts an explicit opt-out value", () => {
  const plan = windowsSigningPlan({ SCOPE_DESKTOP_WINDOWS_REQUIRE_SIGNING: "0" });
  assert.equal(plan.mode, "unsigned-friends-beta");
});

test("workflow gives signing requirements only to release builds", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "../../.github/workflows/desktop-build.yml"),
    "utf8",
  );
  const expressions = [
    ...workflow.matchAll(/SCOPE_DESKTOP_WINDOWS_REQUIRE_SIGNING: \$\{\{ (.+?) \}\}/g),
  ];
  assert.equal(expressions.length, 2, "build and verification must both choose a signing policy");
  for (const [, expression] of expressions) {
    // These Actions expressions also use valid JS boolean/property syntax.
    const evaluate = new Function("matrix", "inputs", "vars", `return (${expression});`);
    const vars = { SCOPE_DESKTOP_WINDOWS_REQUIRE_SIGNING: "1" };
    for (const event of ["pull_request", "push", "workflow_dispatch"]) {
      const requirement = evaluate(
        { target_platform: "win32" },
        { release_tag: event === "workflow_dispatch" ? "v1.2.3" : "" },
        vars,
      );
      if (event !== "workflow_dispatch") {
        assert.equal(
          windowsSigningPlan({ SCOPE_DESKTOP_WINDOWS_REQUIRE_SIGNING: requirement }).mode,
          "unsigned-friends-beta",
        );
      } else {
        assert.throws(
          () => windowsSigningPlan({ SCOPE_DESKTOP_WINDOWS_REQUIRE_SIGNING: requirement }),
          /signing is required/i,
        );
      }
    }
  }
});
