import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "@/proxy";

const ORIGINAL_TOKEN = process.env.SCOPE_DESKTOP_TOKEN;

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.SCOPE_DESKTOP_TOKEN;
  } else {
    process.env.SCOPE_DESKTOP_TOKEN = ORIGINAL_TOKEN;
  }
});

describe("desktop request gate", () => {
  it("does not affect the ordinary loopback web application", () => {
    delete process.env.SCOPE_DESKTOP_TOKEN;
    const response = proxy(new NextRequest("http://127.0.0.1:3000/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("conceals the desktop server when its launch token is absent", () => {
    process.env.SCOPE_DESKTOP_TOKEN = "secret-launch-token";
    const response = proxy(new NextRequest("http://127.0.0.1:41234/api/health"));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts requests carrying the Electron-injected token", () => {
    process.env.SCOPE_DESKTOP_TOKEN = "secret-launch-token";
    const response = proxy(
      new NextRequest("http://127.0.0.1:41234/api/health", {
        headers: { "x-scope-desktop-token": "secret-launch-token" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
