"use strict";
/**
 * Rumble channel search for the local backend. Rumble serves its search
 * pages behind a Cloudflare browser check that Node's fetch never passes,
 * while Chromium's network stack does. This module runs in the Electron
 * main process and exposes exactly one capability to the backend: fetch
 * https://rumble.com/search/channel?q=<query> and return the page HTML.
 *
 * The loopback server mirrors the X broker: random per-launch token, POST /
 * only, no Origin header, tiny request bodies, and fixed response shapes.
 * Requests use a dedicated in-memory session so no app cookies, tokens, or
 * stored sessions are attached.
 */
const http = require("node:http");
const crypto = require("node:crypto");

const MAX_QUERY_LENGTH = 100;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validateQuery(query) {
  if (
    typeof query !== "string" ||
    query.trim().length === 0 ||
    query.length > MAX_QUERY_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(query)
  )
    throw failure("invalid_query");
  return query.trim();
}

function rumbleSearchUrl(query) {
  const url = new URL("https://rumble.com/search/channel");
  url.searchParams.set("q", query);
  return url.toString();
}

async function readCapped(response, limit) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw failure("too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Creates the search function. `fetchImpl` is Electron's session fetch in
 * the app and a stub in tests.
 */
function createRumbleSearch({ fetchImpl, timeoutMs = FETCH_TIMEOUT_MS }) {
  return async function search(rawQuery) {
    const query = validateQuery(rawQuery);
    let response;
    try {
      response = await fetchImpl(rumbleSearchUrl(query), {
        redirect: "follow",
        headers: { "Accept-Language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw failure(error && error.name === "TimeoutError" ? "timeout" : "network");
    }
    let finalHost = "";
    try {
      finalHost = new URL(response.url || rumbleSearchUrl(query)).hostname;
    } catch {
      throw failure("network");
    }
    if (finalHost !== "rumble.com" && finalHost !== "www.rumble.com") throw failure("network");
    if ([403, 429, 503].includes(response.status)) throw failure("throttled");
    if (response.status === 404 || response.status === 410) throw failure("unavailable");
    if (response.status !== 200) throw failure("network");
    const html = await readCapped(response, MAX_BODY_BYTES);
    if (/<title>\s*Just a moment/i.test(html)) throw failure("throttled");
    return { html };
  };
}

async function startRumbleSearchBroker(search) {
  const token = crypto.randomBytes(32).toString("hex");
  let origin;
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    const supplied = req.headers["x-scope-rumble-search"];
    if (
      req.method !== "POST" ||
      req.url !== "/" ||
      req.headers.origin ||
      req.headers.host !== new URL(origin).host ||
      typeof supplied !== "string" ||
      supplied.length !== token.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    ) {
      req.resume();
      reply(404, { ok: false });
      return;
    }
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024) {
          reply(413, { ok: false });
          return;
        }
        chunks.push(chunk);
      }
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const { html } = await search(request && request.query);
      reply(200, { ok: true, html });
    } catch (error) {
      reply(200, { ok: false, error: { code: (error && error.code) || "network" } });
    }
  });
  server.requestTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    token,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

module.exports = { createRumbleSearch, rumbleSearchUrl, startRumbleSearchBroker, validateQuery };
