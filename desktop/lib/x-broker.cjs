"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const { failure } = require("./x-worker.cjs");
const OPERATIONS = new Set([
  "status",
  "connect",
  "cancel",
  "disconnect",
  "focus",
  "retry-storage",
  "user",
  "user_search",
  "user_posts",
  "tweet",
]);
function validateParams(operation, params) {
  if (!params || typeof params !== "object" || Array.isArray(params))
    throw failure("invalid_response");
  if (
    ["user", "user_posts"].includes(operation) &&
    !/^[A-Za-z0-9_]{1,15}$/.test(params.handle || "")
  )
    throw failure("invalid_response");
  if (operation === "tweet" && !/^\d{1,20}$/.test(params.tweetId || ""))
    throw failure("invalid_response");
  if (
    operation === "user_search" &&
    (typeof params.query !== "string" ||
      params.query.trim().length === 0 ||
      params.query.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(params.query))
  )
    throw failure("invalid_response");
  if (operation === "user_posts") {
    if (
      !/^\d{1,20}$/.test(params.userId || "") ||
      !Number.isInteger(params.limit) ||
      params.limit < 1 ||
      params.limit > 100
    )
      throw failure("invalid_response");
    if (params.cursor != null && (typeof params.cursor !== "string" || params.cursor.length > 4096))
      throw failure("invalid_response");
  }
}
async function startXBroker(connection) {
  const token = crypto.randomBytes(32).toString("hex");
  let origin;
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    const supplied = req.headers["x-scope-x-broker"];
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
        if (size > 8192) {
          reply(413, { ok: false });
          return;
        }
        chunks.push(chunk);
      }
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        request.protocol !== 1 ||
        !OPERATIONS.has(request.operation) ||
        request.credentials !== undefined
      )
        throw failure("invalid_response");
      const params = request.params ?? {};
      validateParams(request.operation, params);
      const data = ["user", "user_search", "user_posts", "tweet"].includes(request.operation)
        ? await connection.read(request.operation, params)
        : request.operation === "retry-storage"
          ? await connection.retryStorage()
          : await connection[request.operation]();
      reply(200, { ok: true, schema_version: 1, data });
    } catch (error) {
      reply(200, {
        ok: false,
        error: {
          code: error.code || "invalid_response",
          retryAfterSeconds: error.retryAfterSeconds ?? null,
        },
      });
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
module.exports = { startXBroker, validateParams };
