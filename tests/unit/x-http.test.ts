import { describe, expect, it } from "vitest";
import { POST as connection } from "@/app/api/x/connection/route";
import { POST as refresh } from "@/app/api/creators/[id]/tweets/refresh/route";
import { POST as fetchPosts } from "@/app/api/creators/[id]/tweets/fetch/route";
import { readXMutation } from "@/lib/x/http";

describe("X privileged mutation guards", () => {
  for (const [name, handler] of Object.entries({ connection, refresh, fetchPosts })) {
    it(`${name} refuses a foreign origin before touching providers or the database`, async () => {
      const request = new Request("http://127.0.0.1:3000/api/x/connection", {
        method: "POST", headers: { Origin: "https://untrusted.example", "Content-Type": "text/plain" },
        body: JSON.stringify({ action: "disconnect", tweetIds: ["123"] }),
      });
      const response = await handler(request, { params: Promise.resolve({ id: "1" }) });
      expect(response.status).toBe(403);
    });
  }
  it("rejects JSON null and wrong content types", async () => {
    for (const [body, contentType, expected] of [["null", "application/json", 400], ['{}', 'text/plain', 415]] as const) {
      const result = await readXMutation(new Request("http://localhost", { method: "POST", headers: { "Content-Type": contentType }, body }));
      expect(!result.ok && result.response.status).toBe(expected);
    }
  });
  it("caps streamed bodies without trusting Content-Length", async () => {
    const request = new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "2" }, body: JSON.stringify({ text: "x".repeat(9000) }) });
    const result = await readXMutation(request);
    expect(!result.ok && result.response.status).toBe(413);
  });
});
