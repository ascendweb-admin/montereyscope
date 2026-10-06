import type { CodexAccountTransport } from "@/lib/ai/auth/codex-account-client";
import {
  CodexAccountClient,
  CodexAccountError,
  MAX_CODEX_MODEL_PAGES,
  isMissingCodexBinaryError,
  isUnsupportedCodexAccountError,
  parseAccountState,
  parseCodexModelListPage,
  parseLoginCompleted,
  sanitizeProviderError,
  validateCodexAuthorizationUrl,
} from "@/lib/ai/auth/codex-account-client";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Fake stdio transport
// ---------------------------------------------------------------------------

interface PushStream {
  push(text: string): void;
  close(): void;
  [Symbol.asyncIterator](): AsyncGenerator<string>;
}

function createPushStream(): PushStream {
  const queue: string[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  return {
    push(text: string): void {
      queue.push(text);
      notify?.();
      notify = null;
    },
    close(): void {
      closed = true;
      notify?.();
      notify = null;
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<string> {
      for (;;) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) {
          return;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
  };
}

interface Harness {
  transport: CodexAccountTransport;
  writes: Array<Record<string, unknown>>;
  stdout: PushStream;
  stderr: PushStream;
  respond(id: number, result: unknown): void;
  respondError(id: number, code: number, message: string): void;
  notify(method: string, params: unknown): void;
  exit(exitCode?: number): void;
  waitForWrite(
    method: string,
    occurrence?: number,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
}

function createHarness(): Harness {
  const stdout = createPushStream();
  const stderr = createPushStream();
  const writes: Array<Record<string, unknown>> = [];
  let resolveExit!: (value: { exitCode: number | null; signal: string | null }) => void;
  let exited = false;
  const exitPromise = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    resolveExit = resolve;
  });
  const finish = (exitCode: number | null, signal: string | null): void => {
    if (exited) {
      return;
    }
    exited = true;
    resolveExit({ exitCode, signal });
    stdout.close();
    stderr.close();
  };
  const transport: CodexAccountTransport = {
    stdin: {
      write: (chunk) => {
        for (const line of chunk.split("\n")) {
          if (line.trim().length > 0) {
            writes.push(JSON.parse(line) as Record<string, unknown>);
          }
        }
      },
      end: () => {},
    },
    stdout,
    stderr,
    wait: () => exitPromise,
    kill: () => finish(null, "SIGKILL"),
  };
  return {
    transport,
    writes,
    stdout,
    stderr,
    respond: (id, result) => stdout.push(`${JSON.stringify({ id, result })}\n`),
    respondError: (id, code, message) =>
      stdout.push(`${JSON.stringify({ id, error: { code, message } })}\n`),
    notify: (method, params) => stdout.push(`${JSON.stringify({ method, params })}\n`),
    exit: (exitCode = 0) => finish(exitCode, null),
    async waitForWrite(
      method: string,
      occurrence = 1,
      timeoutMs = 2_000,
    ): Promise<Record<string, unknown>> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const matches = writes.filter((message) => message.method === method);
        if (matches.length >= occurrence) {
          return matches[occurrence - 1] as Record<string, unknown>;
        }
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${method} #${occurrence}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

async function connectHarness(
  overrides: { requestTimeoutMs?: number } = {},
): Promise<Harness & { client: CodexAccountClient }> {
  const harness = createHarness();
  const connecting = CodexAccountClient.connect({
    spawner: () => harness.transport,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 2_000,
    initializeTimeoutMs: 2_000,
  });
  const initialize = await harness.waitForWrite("initialize");
  harness.respond(initialize.id as number, { userAgent: "scope/test" });
  const client = await connecting;
  return { ...harness, client };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("codex account parsing", () => {
  it("maps chatgpt, apiKey, bedrock, unknown, and absent accounts", () => {
    expect(
      parseAccountState({
        account: { type: "chatgpt", email: "analyst@example.com", planType: "plus" },
        requiresOpenaiAuth: true,
      }),
    ).toEqual({
      account: { type: "chatgpt", email: "analyst@example.com", planType: "plus" },
      requiresOpenaiAuth: true,
    });
    expect(parseAccountState({ account: { type: "apiKey" }, requiresOpenaiAuth: true })).toEqual({
      account: { type: "apiKey" },
      requiresOpenaiAuth: true,
    });
    expect(
      parseAccountState({ account: { type: "amazonBedrock" }, requiresOpenaiAuth: true }),
    ).toEqual({ account: { type: "amazonBedrock" }, requiresOpenaiAuth: true });
    expect(
      parseAccountState({ account: { type: "somethingNew" }, requiresOpenaiAuth: true }),
    ).toEqual({ account: { type: "unknown" }, requiresOpenaiAuth: true });
    expect(parseAccountState({ account: null, requiresOpenaiAuth: true })).toEqual({
      account: null,
      requiresOpenaiAuth: true,
    });
  });

  it("validates authorization URLs against https and OpenAI hosts", () => {
    expect(validateCodexAuthorizationUrl("https://auth.openai.com/oauth/authorize?x=1")).toBe(
      "https://auth.openai.com/oauth/authorize?x=1",
    );
    expect(validateCodexAuthorizationUrl("https://chatgpt.com/codex/device")).toBe(
      "https://chatgpt.com/codex/device",
    );
    expect(validateCodexAuthorizationUrl("http://auth.openai.com/x")).toBeNull();
    expect(validateCodexAuthorizationUrl("https://evil.example.com/x")).toBeNull();
    expect(validateCodexAuthorizationUrl("https://openai.com.evil.example/x")).toBeNull();
    expect(validateCodexAuthorizationUrl("not a url")).toBeNull();
    expect(validateCodexAuthorizationUrl(null)).toBeNull();
  });

  it("parses login completion notifications and sanitizes provider errors", () => {
    expect(
      parseLoginCompleted({ loginId: "abc", success: false, error: "bad\nthing\u0007" }),
    ).toEqual({ loginId: "abc", success: false, error: "bad thing" });
    expect(parseLoginCompleted({ success: true })).toEqual({
      loginId: null,
      success: true,
      error: null,
    });
    expect(parseLoginCompleted({ nope: true })).toBeNull();
    expect(sanitizeProviderError("line1\nline2")).toBe("line1 line2");
    expect(sanitizeProviderError("  ")).toBeNull();
    expect(sanitizeProviderError("x".repeat(500))?.length).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Protocol client
// ---------------------------------------------------------------------------

describe("CodexAccountClient", () => {
  it("handshakes and reads the account", async () => {
    const harness = await connectHarness();
    expect(harness.writes.map((message) => message.method)).toEqual(["initialize", "initialized"]);
    const read = harness.client.readAccount();
    const request = await harness.waitForWrite("account/read");
    expect(request.params).toEqual({ refreshToken: false });
    harness.respond(request.id as number, {
      account: { type: "chatgpt", email: "analyst@example.com", planType: "pro" },
      requiresOpenaiAuth: true,
    });
    await expect(read).resolves.toEqual({
      account: { type: "chatgpt", email: "analyst@example.com", planType: "pro" },
      requiresOpenaiAuth: true,
    });
    await harness.client.close();
  });

  it("reassembles split protocol lines and dispatches notifications", async () => {
    const harness = await connectHarness();
    const seen: string[] = [];
    harness.client.onNotification((method) => seen.push(method));
    const read = harness.client.readAccount();
    const request = await harness.waitForWrite("account/read");
    const payload = JSON.stringify({
      id: request.id,
      result: { account: null, requiresOpenaiAuth: true },
    });
    harness.stdout.push(payload.slice(0, 12));
    harness.stdout.push(payload.slice(12) + "\n");
    harness.notify("account/login/completed", { loginId: "x", success: false });
    await expect(read).resolves.toEqual({ account: null, requiresOpenaiAuth: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual(["account/login/completed"]);
    await harness.client.close();
  });

  it("starts browser and device logins with validated URLs", async () => {
    const harness = await connectHarness();
    const browser = harness.client.startBrowserLogin();
    const browserRequest = await harness.waitForWrite("account/login/start");
    expect(browserRequest.params).toEqual({ type: "chatgpt" });
    harness.respond(browserRequest.id as number, {
      type: "chatgpt",
      loginId: "login-1",
      authUrl: "https://auth.openai.com/oauth/authorize?x=1",
    });
    await expect(browser).resolves.toEqual({
      loginId: "login-1",
      authorizationUrl: "https://auth.openai.com/oauth/authorize?x=1",
    });

    const device = harness.client.startDeviceCodeLogin();
    const deviceRequest = await harness.waitForWrite("account/login/start", 2);
    expect(deviceRequest.params).toEqual({ type: "chatgptDeviceCode" });
    harness.respond(deviceRequest.id as number, {
      type: "chatgptDeviceCode",
      loginId: "login-2",
      verificationUrl: "https://chatgpt.com/codex/device",
      userCode: "ABCD-1234",
    });
    await expect(device).resolves.toEqual({
      loginId: "login-2",
      verificationUrl: "https://chatgpt.com/codex/device",
      userCode: "ABCD-1234",
    });
    await harness.client.close();
  });

  it("rejects a login response carrying an untrusted URL", async () => {
    const harness = await connectHarness();
    const browser = harness.client.startBrowserLogin();
    const request = await harness.waitForWrite("account/login/start");
    harness.respond(request.id as number, {
      type: "chatgpt",
      loginId: "login-1",
      authUrl: "https://evil.example.com/steal",
    });
    await expect(browser).rejects.toMatchObject({ kind: "protocol" });
    await harness.client.close();
  });

  it("maps method-not-found to an unsupported error", async () => {
    const harness = await connectHarness();
    const read = harness.client.readAccount();
    const request = await harness.waitForWrite("account/read");
    harness.respondError(request.id as number, -32601, "Method not found");
    const error = await read.catch((caught: unknown) => caught);
    expect(isUnsupportedCodexAccountError(error)).toBe(true);
    await harness.client.close();
  });

  it("times out a request that never gets an answer", async () => {
    const harness = await connectHarness({ requestTimeoutMs: 50 });
    const read = harness.client.readAccount();
    await harness.waitForWrite("account/read");
    const error = await read.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexAccountError);
    expect((error as CodexAccountError).kind).toBe("timeout");
    await harness.client.close();
  });

  it("rejects pending requests and notifies exit listeners when the transport dies", async () => {
    const harness = await connectHarness();
    const exits: Array<{ exitCode: number | null }> = [];
    harness.client.onExit((info) => exits.push(info));
    const read = harness.client.readAccount();
    await harness.waitForWrite("account/read");
    harness.exit(9);
    await expect(read).rejects.toMatchObject({ kind: "transport" });
    expect(exits).toEqual([{ exitCode: 9, signal: null }]);
  });

  it("reports a missing binary as a spawn failure", async () => {
    const error = await CodexAccountClient.connect({
      spawner: () => {
        throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
      },
    }).catch((caught: unknown) => caught);
    expect(isMissingCodexBinaryError(error)).toBe(true);
  });

  it("cancels and logs out with the expected method payloads", async () => {
    const harness = await connectHarness();
    const cancel = harness.client.cancelLogin("login-1");
    const cancelRequest = await harness.waitForWrite("account/login/cancel");
    expect(cancelRequest.params).toEqual({ loginId: "login-1" });
    harness.respond(cancelRequest.id as number, { status: "canceled" });
    await expect(cancel).resolves.toBe("canceled");

    const logout = harness.client.logout();
    const logoutRequest = await harness.waitForWrite("account/logout");
    harness.respond(logoutRequest.id as number, {});
    await expect(logout).resolves.toBeUndefined();
    await harness.client.close();
  });

  it("declines unexpected server requests instead of stalling", async () => {
    const harness = await connectHarness();
    harness.stdout.push(`${JSON.stringify({ id: 99, method: "approval/request", params: {} })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const reply = harness.writes.find((message) => message.id === 99);
    expect(reply).toMatchObject({ error: { code: -32601 } });
    await harness.client.close();
  });
});

describe("codex model discovery", () => {
  it("parses picker entries, hidden flags, upgrades, and unknown capabilities", () => {
    const page = parseCodexModelListPage({
      data: [
        {
          id: "gpt-6-astra",
          displayName: "GPT-6-Astra",
          description: "Most capable.",
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "ultra", description: "Delegating" },
          ],
          defaultReasoningEffort: "low",
        },
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5",
          description: "Previous generation.",
          hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          defaultReasoningEffort: "medium",
          upgradeInfo: { model: "gpt-6-astra", migrationMarkdown: "Retires soon." },
        },
        {
          // No capability metadata at all: capabilities stay unknown.
          id: "mystery-model",
          displayName: "Mystery",
        },
      ],
      nextCursor: "cursor-2",
    });
    expect(page.nextCursor).toBe("cursor-2");
    expect(page.models[0]).toMatchObject({
      runtimeId: "gpt-6-astra",
      label: "GPT-6-Astra",
      recommended: true,
      effortsKnown: true,
      defaultReasoningEffort: "low",
      upgrade: null,
      hidden: false,
    });
    expect(page.models[0].reasoningOptions).toEqual([
      { id: "low", description: "Fast" },
      { id: "ultra", description: "Delegating" },
    ]);
    expect(page.models[1].upgrade).toEqual({
      modelId: "gpt-6-astra",
      message: "Retires soon.",
    });
    expect(page.models[2]).toMatchObject({
      effortsKnown: false,
      reasoningOptions: [],
      defaultReasoningEffort: null,
    });
  });

  it("rejects malformed model list responses", () => {
    expect(() => parseCodexModelListPage(null)).toThrow(CodexAccountError);
    expect(() => parseCodexModelListPage({})).toThrow(CodexAccountError);
    expect(() => parseCodexModelListPage({ data: "nope" })).toThrow(CodexAccountError);
  });

  it("follows pagination, drops hidden entries, and deduplicates ids", async () => {
    const harness = await connectHarness();
    const listing = harness.client.listModels();
    const first = await harness.waitForWrite("model/list");
    expect(first.params).toEqual({ includeHidden: false });
    harness.respond(first.id as number, {
      data: [
        { id: "model-a", displayName: "A", hidden: false },
        { id: "hidden-one", displayName: "Hidden", hidden: true },
      ],
      nextCursor: "page-2",
    });
    const second = await harness.waitForWrite("model/list", 2);
    expect(second.params).toEqual({ includeHidden: false, cursor: "page-2" });
    harness.respond(second.id as number, {
      data: [
        { id: "model-a", displayName: "A duplicate", hidden: false },
        { id: "model-b", displayName: "B", hidden: false },
      ],
      nextCursor: null,
    });
    await expect(listing).resolves.toEqual([
      expect.objectContaining({ runtimeId: "model-a", label: "A" }),
      expect.objectContaining({ runtimeId: "model-b", label: "B" }),
    ]);
    harness.exit();
    await harness.client.close();
  });

  it("fails when pagination never terminates", async () => {
    const harness = await connectHarness();
    const listing = harness.client.listModels();
    for (let page = 0; page < 60; page += 1) {
      const request = await harness.waitForWrite("model/list", page + 1);
      // Every page points at a fresh cursor so the bound is the only stop.
      harness.respond(request.id as number, {
        data: [{ id: `model-${page}`, displayName: `Model ${page}` }],
        nextCursor: `cursor-${page + 1}`,
      });
      if (page >= MAX_CODEX_MODEL_PAGES - 1) {
        break;
      }
    }
    await expect(listing).rejects.toMatchObject({ kind: "protocol" });
    harness.exit();
    await harness.client.close();
  });
});

describe("failed connection cleanup", () => {
  it("closes the transport when initialization times out", async () => {
    const harness = createHarness();
    let closed = false;
    harness.transport.stdin.end = () => {
      closed = true;
      harness.exit();
    };
    await expect(
      CodexAccountClient.connect({
        spawner: () => harness.transport,
        initializeTimeoutMs: 20,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(closed).toBe(true);
  });
});
