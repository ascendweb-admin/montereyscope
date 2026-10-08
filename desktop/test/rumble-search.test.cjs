"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  createRumbleSearch,
  rumbleSearchUrl,
  startRumbleSearchBroker,
  validateQuery,
} = require("../lib/rumble-search.cjs");
const { validateParams } = require("../lib/x-broker.cjs");

function page(body, { status = 200, url = "https://rumble.com/search/channel?q=x" } = {}) {
  const response = new Response(body, { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function post(origin, headers, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${origin}/`,
      { method: "POST", headers: { "Content-Type": "application/json", ...headers } },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

test("only plain, bounded queries reach Rumble", () => {
  assert.equal(validateQuery("  dan bongino "), "dan bongino");
  for (const bad of ["", "   ", "x".repeat(101), "a\nb", 42, null]) {
    assert.throws(() => validateQuery(bad), { code: "invalid_query" });
  }
  assert.equal(rumbleSearchUrl("a&b c"), "https://rumble.com/search/channel?q=a%26b+c");
});

test("search fetches the fixed search URL and returns the page", async () => {
  const calls = [];
  const search = createRumbleSearch({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return page("<main>No channels found</main>");
    },
  });
  assert.deepEqual(await search("bongino"), { html: "<main>No channels found</main>" });
  assert.equal(calls[0].url, "https://rumble.com/search/channel?q=bongino");
  assert.equal(calls[0].options.redirect, "follow");
});

test("edge refusals, missing pages, and off-site redirects map to typed failures", async () => {
  const cases = [
    [page("blocked", { status: 403 }), "throttled"],
    [page("slow down", { status: 429 }), "throttled"],
    [page("<title>Just a moment...</title>"), "throttled"],
    [page("gone", { status: 404 }), "unavailable"],
    [page("oops", { status: 500 }), "network"],
    [page("<main></main>", { url: "https://evil.example/" }), "network"],
  ];
  for (const [response, code] of cases) {
    const search = createRumbleSearch({ fetchImpl: async () => response });
    await assert.rejects(search("bongino"), { code });
  }
  const failing = createRumbleSearch({
    fetchImpl: async () => {
      throw Object.assign(new Error("boom"), { name: "TypeError" });
    },
  });
  await assert.rejects(failing("bongino"), { code: "network" });
});

test("oversized pages are refused", async () => {
  const search = createRumbleSearch({
    fetchImpl: async () => page("x".repeat(9 * 1024 * 1024)),
  });
  await assert.rejects(search("bongino"), { code: "too_large" });
});

test("the broker requires its token and returns fixed envelopes", async () => {
  const broker = await startRumbleSearchBroker(async (query) => {
    if (query === "fail") throw Object.assign(new Error("x"), { code: "throttled" });
    return { html: `<main>${query}</main>` };
  });
  try {
    const refused = await post(
      broker.origin,
      { "x-scope-rumble-search": "wrong" },
      '{"query":"a"}',
    );
    assert.equal(refused.status, 404);
    const withOrigin = await post(
      broker.origin,
      { "x-scope-rumble-search": broker.token, Origin: "http://evil.example" },
      '{"query":"a"}',
    );
    assert.equal(withOrigin.status, 404);
    const ok = await post(
      broker.origin,
      { "x-scope-rumble-search": broker.token },
      '{"query":"bongino"}',
    );
    assert.deepEqual(ok.body, { ok: true, html: "<main>bongino</main>" });
    const failed = await post(
      broker.origin,
      { "x-scope-rumble-search": broker.token },
      '{"query":"fail"}',
    );
    assert.deepEqual(failed.body, { ok: false, error: { code: "throttled" } });
    const huge = await post(
      broker.origin,
      { "x-scope-rumble-search": broker.token },
      JSON.stringify({ query: "x".repeat(2048) }),
    );
    assert.equal(huge.status, 413);
  } finally {
    await broker.close();
  }
});

test("the X broker accepts only bounded people-search queries", () => {
  assert.doesNotThrow(() => validateParams("user_search", { query: "pewdiepie" }));
  for (const query of ["", "  ", "x".repeat(101), "a\u0000b", 7]) {
    assert.throws(() => validateParams("user_search", { query }), { code: "invalid_response" });
  }
});
