import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/connection";
import { POST as chat } from "@/app/api/ai/chat/route";
import { POST as prepare } from "@/app/api/ai/prepare/route";
import { POST as reports } from "@/app/api/ai/reports/route";
import { PATCH as renameReport } from "@/app/api/ai/reports/[id]/route";
import { POST as creators } from "@/app/api/creators/route";
import { POST as transcript } from "@/app/api/creators/[id]/videos/[videoId]/transcript/route";
import { PUT as captions } from "@/app/api/settings/preferred-caption-languages/route";
import { PUT as feedWindow } from "@/app/api/settings/recent-items-per-tab/route";

vi.mock("@/lib/db/connection", async (original) => ({
  ...(await original<typeof import("@/lib/db/connection")>()),
  getDb: vi.fn(() => {
    throw new Error("Invalid JSON must not reach database work");
  }),
}));
afterEach(() => vi.mocked(getDb).mockClear());

const routes = [
  { name: "chat", method: "POST", run: chat },
  { name: "prepare", method: "POST", run: prepare },
  { name: "reports", method: "POST", run: reports },
  {
    name: "rename report",
    method: "PATCH",
    run: (r: Request) => renameReport(r, { params: Promise.resolve({ id: "999999" }) }),
  },
  { name: "creators", method: "POST", run: creators },
  {
    name: "transcript selection",
    method: "POST",
    run: (r: Request) =>
      transcript(r, { params: Promise.resolve({ id: "999999", videoId: "qaGhost0001" }) }),
  },
  { name: "caption preference", method: "PUT", run: captions },
  { name: "feed window", method: "PUT", run: feedWindow },
];

describe.each(routes)("$name JSON boundary", ({ method, run }) => {
  it.each(["null", "[]", "true", '"text"', "123", "{"])(
    "rejects %s as a structured 400 before side effects",
    async (body) => {
      const response = await run(
        new Request("http://127.0.0.1/api/qa", {
          method,
          headers: { "content-type": "application/json" },
          body,
        }),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_body");
      expect(getDb).not.toHaveBeenCalled();
    },
  );
});
