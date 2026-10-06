// Deterministic browser-only archive. Run against a temporary, migrated DB.
// Usage: node docs/evidence/x-research-stage4/seed-browser.cjs /tmp/scope-stage4-browser.sqlite
const Database = require("better-sqlite3");
const db = new Database(process.argv[2]);
db.pragma("foreign_keys = ON");
if (db.prepare("SELECT COUNT(*) AS n FROM creators").get().n !== 0)
  throw new Error(
    "Use an empty temporary database; this fixture never alters an existing library.",
  );
db.transaction(() => {
  const add = db.prepare(`INSERT INTO creators(platform, platform_user_id, youtube_channel_id,
    display_name, handle, channel_url) VALUES ('x', ?, NULL, ?, ?, ?)`);
  const alpha = Number(
    add.run("111", "Alpha fixture", "alpha", "https://x.com/alpha").lastInsertRowid,
  );
  const beta = Number(add.run("222", "Beta fixture", "beta", "https://x.com/beta").lastInsertRowid);
  const outside = Number(
    add.run("333", "Outside fixture", "outside", "https://x.com/outside").lastInsertRowid,
  );
  const list = Number(
    db.prepare("INSERT INTO x_research_lists(name) VALUES (?)").run("Search fixture")
      .lastInsertRowid,
  );
  const member = db.prepare(
    "INSERT INTO x_research_list_members(list_id, creator_id) VALUES (?, ?)",
  );
  member.run(list, alpha);
  member.run(list, beta);
  const insert = db.prepare(`INSERT INTO tweets(id, author_user_id, author_handle, author_name, url,
    text, published_at, content_status, quoted_tweet_id, quoted_text, in_reply_to_tweet_id)
    VALUES (@id, '111', 'alpha', 'Alpha fixture', @url, @text, @at, @status, @quoteId, @quote, @parent)`);
  const link = db.prepare(
    "INSERT INTO creator_tweets(creator_id, tweet_id, timeline_kind, timeline_at) VALUES (?, ?, ?, ?)",
  );
  function post(id, text, options = {}) {
    const at = options.at === undefined ? "2026-10-01T12:00:00.000Z" : options.at;
    insert.run({
      id: String(id),
      url: `https://x.com/alpha/status/${id}`,
      text,
      at,
      status: options.status || "complete",
      quoteId: options.quote ? "9999" : null,
      quote: options.quote || null,
      parent: options.parent || null,
    });
    link.run(options.creator || alpha, String(id), options.kind || "post", options.event || at);
  }
  for (let n = 0; n < 77; n++) {
    const alias = ["Ethereum", "ETH", "$ETH"][n % 3];
    post(1000 + n, `${alias} lower fees fixture ${n}${n % 5 === 0 ? " speculation" : ""}`, {
      status: n === 76 ? "summary" : "complete",
      parent: n === 2 ? "9988" : null,
    });
    if (n === 76) link.run(beta, String(1000 + n), "post", "2026-10-01T12:00:00.000Z");
  }
  post(1080, "I disagree with this forecast", { quote: "Ethereum lower fees" });
  post(1081, "Bitcoin unrelated body", { creator: beta });
  post(1082, "Ethereum lower fees outside scope", { creator: outside });
  post(1083, "Ethereum lower fees unknown date", { at: null });
  post(1084, "", { status: "unavailable" });
  post(2000, "Ethereum lower fees historical DST", { at: "2026-03-29T20:00:00.000Z" });
  post(2001, "Ethereum lower fees outside inclusive date", { at: "2026-03-29T22:00:00.000Z" });
  post(2002, "Ethereum lower fees shared historical author", {
    at: "2020-01-01T12:00:00.000Z",
    event: "2026-10-01T13:00:00.000Z",
    kind: "repost",
    creator: beta,
  });
})();
db.exec("INSERT INTO x_tweet_text(x_tweet_text, rank) VALUES ('integrity-check', 1)");
console.log({
  tweets: db.prepare("SELECT COUNT(*) AS n FROM tweets").get().n,
  jobs: db.prepare("SELECT COUNT(*) AS n FROM x_retrieval_jobs").get().n,
});
db.close();
