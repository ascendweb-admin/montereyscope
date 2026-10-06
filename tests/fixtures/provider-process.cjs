#!/usr/bin/env node
// Offline protocol fixture. Never contacts a provider or reads real credentials.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const provider = path.basename(__dirname);
const args = process.argv.slice(2);
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const record = (value) =>
  fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify(value) + "\n");
record({ args, entry: __filename });

if (args.includes("--version")) {
  console.log(provider === "claude" ? "2.1.241 (Claude Code)" : "1.0.0");
} else if (args[0] === "app-server") {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    record({ method: request.method });
    if (request.id === undefined) return;
    const responses = {
      initialize: {},
      "account/read": {
        account: { type: "chatgpt", email: "fixture@example.invalid", planType: "plus" },
        requiresOpenaiAuth: true,
      },
      "account/login/start": {
        loginId: "fixture-login",
        authUrl: "https://auth.openai.com/authorize?fixture=1",
      },
      "account/logout": {},
      "model/list": {
        data: [
          { id: "fixture-model", displayName: "Fixture model", supportedReasoningEfforts: [] },
        ],
        nextCursor: null,
      },
    };
    if (!(request.method in responses)) throw new Error(`Unexpected RPC: ${request.method}`);
    emit({ id: request.id, result: responses[request.method] });
  });
} else if (provider === "claude" && args[0] === "auth") {
  if (args[1] === "status") emit({ loggedIn: true, authMethod: "claudeai" });
  else if (args[1] === "login") console.log("https://claude.ai/oauth/authorize?fixture=1");
  else if (args[1] !== "logout") throw new Error("Unexpected auth operation");
} else if (provider === "claude" && args.includes("--input-format")) {
  // The real Claude SDK initialization/control protocol, with no user turns.
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type !== "control_request" || message.request.subtype !== "initialize") {
      throw new Error("Model listing must only initialize the control protocol");
    }
    record({ method: "sdk-initialize" });
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          models: [
            {
              value: "fixture-model",
              displayName: "Fixture model",
              description: "Offline fixture",
            },
          ],
          commands: [],
          agents: [],
        },
      },
    });
  });
} else if (provider === "opencode" && args[0] === "models") {
  emit({
    id: "fixture-model",
    providerID: "opencode-go",
    name: "Fixture model",
    variants: {},
    capabilities: { reasoning: false },
  });
} else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    prompt += chunk;
  });
  process.stdin.on("end", () => {
    record({ prompt, cwd: process.cwd() });
    if (prompt.includes("report.html"))
      fs.writeFileSync(
        "report.html",
        "<!doctype html><title>Fixture report</title><h1>Offline report</h1>",
      );
    if (provider === "codex") {
      emit({ type: "thread.started", thread_id: "fixture-session" });
      emit({
        type: "item.completed",
        item: { id: "one", type: "agent_message", text: "Offline answer" },
      });
      emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    } else if (provider === "claude") {
      emit({ type: "system", subtype: "init", session_id: "fixture-session" });
      emit({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "fixture-session",
        result: "Offline answer",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    } else {
      emit({
        type: "text",
        sessionID: "fixture-session",
        part: { type: "text", id: "one", text: "Offline answer" },
      });
      emit({
        type: "step_finish",
        sessionID: "fixture-session",
        part: { tokens: { input: 1, output: 1 } },
      });
    }
  });
}
