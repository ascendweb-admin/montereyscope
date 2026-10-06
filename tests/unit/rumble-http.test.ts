import { describe, expect, it, vi } from "vitest";

import { fetchRumblePage, rumbleRequestHeaders, type RumbleFetchOptions } from "@/lib/rumble/http";

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html", ...init.headers },
    ...init,
  });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function statusResponse(status: number): Response {
  return new Response("nope", { status });
}

const NO_SLEEP: Partial<RumbleFetchOptions> = { sleep: () => Promise.resolve(), backoffMs: 0 };

describe("rumbleRequestHeaders", () => {
  it("carries the verified browser-shaped header set", () => {
    const headers = rumbleRequestHeaders();
    expect(headers["User-Agent"]).toContain("Firefox");
    expect(headers["Sec-Fetch-Mode"]).toBe("navigate");
    expect(headers["Referer"]).toBe("https://rumble.com/");
    expect(headers.Cookie).toBeUndefined();
  });

  it("attaches the cookie when one is given", () => {
    const headers = rumbleRequestHeaders("cf_clearance=abc");
    expect(headers.Cookie).toBe("cf_clearance=abc");
  });
});

describe("fetchRumblePage", () => {
  it("returns the body of a 200 response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse("<html>ok</html>"));
    const result = await fetchRumblePage("https://rumble.com/c/x", {
      ...NO_SLEEP,
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toBe("<html>ok</html>");
      expect(result.finalUrl).toBe("https://rumble.com/c/x");
    }
  });

  it("follows redirect hops, merging challenge cookies into later hops", async () => {
    // Mirror of the observed Cloudflare pattern: a 307 back to the same URL
    // that also drops a clearance cookie; the second hop must carry it.
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            const response = redirect("https://rumble.com/c/Redacted?page=1", 307);
            response.headers.set("set-cookie", "cf_clearance=ticket-1");
            resolve(response);
          }),
      )
      .mockResolvedValueOnce(htmlResponse("<html>listing</html>"));
    const result = await fetchRumblePage("https://rumble.com/c/Redacted?page=1", {
      ...NO_SLEEP,
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    const secondCall = fetchImpl.mock.calls[1];
    const init = secondCall[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Cookie).toBe("cf_clearance=ticket-1");
  });

  it("retries a 403 throttle once and succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(403))
      .mockResolvedValueOnce(htmlResponse("<html>ok</html>"));
    const result = await fetchRumblePage("https://rumble.com/c/Redacted", {
      ...NO_SLEEP,
      fetchImpl,
      attempts: 2,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after attempts are exhausted on persistent throttling", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(statusResponse(429));
    const result = await fetchRumblePage("https://rumble.com/c/Redacted", {
      ...NO_SLEEP,
      fetchImpl,
      attempts: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("throttled");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails fast on 404 without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(statusResponse(404));
    const result = await fetchRumblePage("https://rumble.com/c/Gone", {
      ...NO_SLEEP,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unavailable");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps fetch rejections to network and timeouts to timeout", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const networkResult = await fetchRumblePage("https://rumble.com/c/X", {
      ...NO_SLEEP,
      fetchImpl,
    });
    expect(networkResult.ok).toBe(false);
    if (!networkResult.ok) {
      expect(networkResult.reason).toBe("network");
    }

    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    const timeoutFetch = vi.fn().mockRejectedValue(timeoutError);
    const timeoutResult = await fetchRumblePage("https://rumble.com/c/X", {
      ...NO_SLEEP,
      fetchImpl: timeoutFetch,
    });
    expect(timeoutResult.ok).toBe(false);
    if (!timeoutResult.ok) {
      expect(timeoutResult.reason).toBe("timeout");
    }
  });

  it("rejects bodies above the byte cap as too_large", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse("x".repeat(2000)));
    const result = await fetchRumblePage("https://rumble.com/c/X", {
      ...NO_SLEEP,
      fetchImpl,
      maxBodyBytes: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("too_large");
    }
  });

  it("waits for the backoff between throttle retries", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(429))
      .mockResolvedValueOnce(htmlResponse("<html>ok</html>"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await fetchRumblePage("https://rumble.com/c/Redacted", {
      fetchImpl,
      sleep,
      backoffMs: 6_000,
      attempts: 2,
    });
    expect(sleep).toHaveBeenCalledWith(6_000);
  });
});
