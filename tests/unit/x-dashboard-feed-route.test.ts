import { expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/connection";
import { GET } from "@/app/api/x-dashboard/feed/route";

vi.mock("@/lib/db/connection", async (original) => ({
  ...(await original<typeof import("@/lib/db/connection")>()),
  getDb: vi.fn(() => {
    throw new Error("A refused search must not reach the database");
  }),
}));

it("names the search box when it refuses the search text", async () => {
  const response = GET(
    new Request("http://127.0.0.1/api/x-dashboard/feed?creators=1&period=all&q=-unicode"),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Add at least one word to search for, not only exclusions.",
    field: "q",
  });
  expect(getDb).not.toHaveBeenCalled();
});
