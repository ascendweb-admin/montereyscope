import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { XProviderError } from "@/lib/x/model";
import { createWorkerXProvider } from "@/lib/x/providers/worker";
import { runXWorker } from "@/lib/x/providers/worker-process";

const WORKER = path.join(process.cwd(), "tests", "fixtures", "fake-x-worker.cjs");

function provider() {
  return createWorkerXProvider({ executable: process.execPath, args: [WORKER] });
}

const ORIGINAL_MODE = process.env.FAKE_X_WORKER_MODE;

afterEach(() => {
  if (ORIGINAL_MODE === undefined) {
    delete process.env.FAKE_X_WORKER_MODE;
  } else {
    process.env.FAKE_X_WORKER_MODE = ORIGINAL_MODE;
  }
});

describe("worker X provider", () => {
  it("reads status, identity, timeline pages, and single posts", async () => {
    delete process.env.FAKE_X_WORKER_MODE;
    const x = provider();

    const status = await x.status();
    expect(status.capability).toBe("connected");
    expect(status.user?.handle).toBe("fixture_dev");
    expect(status.sessionOnly).toBe(true);

    const lookup = await x.resolveUser("fixture_dev");
    expect(lookup.user.userId).toBe("1234567890123456789");

    const page = await x.listUserTweets({
      userId: lookup.user.userId,
      handle: "fixture_dev",
      limit: 1,
    });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe("1");
    expect(page.items[0].tweet.text).toContain("📈");

    const tweet = await x.getTweet("1234567890123456701");
    expect(tweet?.author.handle).toBe("fixture_dev");
  });

  it("maps a structured worker error to a typed X error", async () => {
    process.env.FAKE_X_WORKER_MODE = "error";
    const x = provider();
    await expect(x.resolveUser("fixture_dev")).rejects.toMatchObject({
      name: "XProviderError",
      code: "rate_limited",
      retryAfterSeconds: 30,
    });
  });

  it("rejects unknown schema versions and garbage output", async () => {
    process.env.FAKE_X_WORKER_MODE = "bad-schema";
    await expect(provider().resolveUser("fixture_dev")).rejects.toMatchObject({
      code: "invalid_response",
    });

    process.env.FAKE_X_WORKER_MODE = "garbage";
    await expect(provider().resolveUser("fixture_dev")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("reports an unavailable status for a missing executable", async () => {
    const x = createWorkerXProvider({ executable: "/definitely/not/a/worker" });
    const status = await x.status();
    expect(status.capability).toBe("unavailable");
    expect(status.errorCode).toBe("unsupported_runtime");
  });

  it("surfaces a nonzero exit as a typed failure", async () => {
    process.env.FAKE_X_WORKER_MODE = "exit-1";
    await expect(provider().resolveUser("fixture_dev")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("runXWorker", () => {
  const baseRequest = {
    protocol: 1 as const,
    operation: "status" as const,
  };

  it("times out a silent worker and kills it", async () => {
    process.env.FAKE_X_WORKER_MODE = "hang";
    const started = Date.now();
    const result = await runXWorker(process.execPath, baseRequest, {
      timeoutMs: 250,
      maxOutputBytes: 64 * 1024,
      args: [WORKER],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("timeout");
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("cancels a silent worker through the abort signal", async () => {
    process.env.FAKE_X_WORKER_MODE = "hang";
    const controller = new AbortController();
    const pending = runXWorker(process.execPath, baseRequest, {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      args: [WORKER],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("cancelled");
    }
  });

  it("rejects oversized output", async () => {
    process.env.FAKE_X_WORKER_MODE = "garbage";
    const result = await runXWorker(process.execPath, baseRequest, {
      timeoutMs: 5_000,
      maxOutputBytes: 4,
      args: [WORKER],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("output_limit");
    }
  });
});

describe("XProviderError", () => {
  it("carries a stable code and message", () => {
    const error = new XProviderError("network");
    expect(error.code).toBe("network");
    expect(error.message).toContain("reach X");
  });
});
