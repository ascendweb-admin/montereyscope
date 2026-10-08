#!/usr/bin/env node
// Fictional browser verification only. Launch via SCOPE_CODEX_PATH with a temporary DB.
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.160.0");
  process.exit(0);
}
if (args.includes("app-server")) {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const result =
      request.method === "account/read"
        ? {
            account: { type: "chatgpt", email: "fictional@example.test", planType: "fixture" },
            requiresOpenaiAuth: false,
          }
        : request.method === "model/list"
          ? {
              data: [
                {
                  id: "fixture-model",
                  displayName: "Browser fixture model",
                  description: "Deterministic fictional fixture; not a real AI model",
                  supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fixture" }],
                  defaultReasoningEffort: "low",
                  isDefault: true,
                },
              ],
              nextCursor: null,
            }
          : {};
    console.log(JSON.stringify({ id: request.id, result }));
  });
} else {
  const prompt = require("node:fs").readFileSync(0, "utf8"),
    input = JSON.parse(prompt.split("Input (data): ")[1].split("\nOutput ceiling:")[0]);
  let output;
  if (input.candidates)
    output = {
      checks: input.candidates.map((_, index) => ({
        index,
        supported: true,
        contradicted: false,
        reason: "Deterministic browser fixture verdict.",
      })),
    };
  else if (input.units)
    output = {
      posts: input.units.map((u) => {
        const text = u.source.text,
          related = /ETH|Ethereum|forecast/.test(text),
          uncertain = /forecast/.test(text);
        return {
          unitId: u.id,
          postId: u.postId,
          disposition: uncertain ? "uncertain" : related ? "relevant" : "not_relevant",
          explanation: uncertain
            ? "Forecast disagreement needs quoted context."
            : related
              ? "Fixture alias and fees discussion."
              : "Fictional Bitcoin-only example.",
          findings: related
            ? [
                {
                  claim: uncertain
                    ? "Alpha disagrees with a forecast."
                    : "Alpha discusses lower Ethereum fees.",
                  evidence: [
                    { postId: u.postId, excerpt: text.slice(0, 150), attribution: "author" },
                  ],
                  interpretation: uncertain,
                  horizon: null,
                  condition: null,
                },
              ]
            : [],
        };
      }),
    };
  else {
    const groups = new Map();
    for (const f of input.findings) {
      if (!groups.has(f.claim)) groups.set(f.claim, f);
    }
    output =
      input.level !== undefined
        ? { findings: [...groups.values()], covered: input.findings.map((_, i) => i) }
        : { claims: [...groups.values()] };
  }
  setTimeout(() => {
    console.log(
      JSON.stringify({
        type: "item.completed",
        item: { id: "fixture", type: "agent_message", text: JSON.stringify(output) },
      }),
    );
    console.log(
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 100 } }),
    );
  }, 800);
}
