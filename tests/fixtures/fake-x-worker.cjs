#!/usr/bin/env node
"use strict";

/**
 * Deterministic X read worker for tests and protocol development. Speaks the
 * Scope worker protocol (docs/x-worker-protocol.md): one JSON request on
 * stdin, one JSON envelope on stdout.
 *
 * Fault injection for tests, via FAKE_X_WORKER_MODE:
 *   ok        (default) respond normally
 *   bad-schema respond with schema_version 2
 *   garbage    print non-JSON output
 *   error      respond with a structured error envelope
 *   exit-1     exit without a response
 *   hang       stay silent until killed (timeout/cancel tests)
 */

const mode = process.env.FAKE_X_WORKER_MODE || "ok";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  if (mode === "hang") {
    // Keep the event loop alive so the runner's timeout/cancel paths fire.
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "garbage") {
    process.stdout.write("this is not json\n");
    process.exit(0);
  }
  if (mode === "exit-1") {
    process.exit(1);
  }

  let request;
  try {
    request = JSON.parse(input);
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: "invalid_response" } }) + "\n");
    process.exit(0);
  }
  if (mode === "error") {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: { code: "rate_limited", message: "slow down", retryAfterSeconds: 30 },
      }) + "\n",
    );
    process.exit(0);
  }

  const schemaVersion = mode === "bad-schema" ? 2 : 1;
  const user = {
    userId: "1234567890123456789",
    handle: "fixture_dev",
    displayName: "Fixture Dev",
    avatarUrl: "https://pbs.twimg.com/profile_images/fixture/avatar_normal.png",
  };

  const tweets = [
    {
      id: "1234567890123456701",
      author: user,
      text: "First deterministic post — unicode émoji 📈 with a line\n\nand a long-note tail.",
      language: "en",
      publishedAt: "2026-09-16T10:00:00.000Z",
      url: "https://x.com/fixture_dev/status/1234567890123456701",
      replyCount: 3,
      repostCount: null,
      likeCount: 17,
      quoteCount: null,
      contentStatus: "complete",
      isRepost: false,
      media: [],
    },
    {
      id: "1234567890123456702",
      author: {
        userId: "999",
        handle: "somebody",
        displayName: "Somebody",
        avatarUrl: null,
      },
      text: "Reposted commentary from another account.",
      language: "en",
      publishedAt: "2026-09-15T09:00:00.000Z",
      url: "https://x.com/somebody/status/1234567890123456702",
      isRepost: true,
      repostedByHandle: "fixture_dev",
      contentStatus: "complete",
      media: [],
    },
  ];

  let data;
  switch (request.operation) {
    case "status":
      data = { connected: true, canConnect: true, sessionOnly: true, user };
      break;
    case "connect":
      data = { connected: true, canConnect: true, sessionOnly: true, user };
      break;
    case "disconnect":
      data = { ok: true };
      break;
    case "user":
      data = { user, pinnedTweetId: null };
      break;
    case "user_posts": {
      const limit = Number(request.params && request.params.limit) || 20;
      const cursor = request.params && request.params.cursor;
      const start = cursor ? Number(cursor) : 0;
      const slice = tweets.slice(start, start + limit);
      const next = start + slice.length;
      data = {
        items: slice.map((tweet) => ({ tweet, timelineKind: tweet.isRepost ? "repost" : "post" })),
        nextCursor: next < tweets.length ? String(next) : null,
      };
      break;
    }
    case "tweet": {
      const tweetId = request.params && request.params.tweetId;
      const found = tweets.find((tweet) => tweet.id === tweetId) || tweets[0];
      data = { found: true, tweet: found };
      break;
    }
    default:
      process.stdout.write(
        JSON.stringify({ ok: false, error: { code: "invalid_response" } }) + "\n",
      );
      process.exit(0);
  }

  process.stdout.write(JSON.stringify({ ok: true, schema_version: schemaVersion, data }) + "\n");
  process.exit(0);
});
