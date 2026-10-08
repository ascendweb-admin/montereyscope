// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { InsightMarkdown } from "@/components/x-dashboard/insight-markdown";
import type { InsightSource } from "@/lib/x/dashboard/model";

afterEach(cleanup);

const post = (id: string, creatorId: number, handle: string): InsightSource => ({
  id,
  creatorId,
  authorHandle: handle,
  authorName: handle.toUpperCase(),
  authorAvatarUrl: null,
  text: `Post ${id} by ${handle}`,
  url: `https://x.com/${handle}/status/${id}`,
  publishedAt: "2026-10-01T12:00:00Z",
});
const sources = {
  "1": post("1", 10, "notthreadguy"),
  "2": post("2", 10, "notthreadguy"),
  "3": post("3", 10, "notthreadguy"),
  "4": post("4", 20, "tulipking"),
};

it("collapses a run of posts by one creator into a single pill with a count", () => {
  render(<InsightMarkdown text="ZEC thesis. [post:1][post:2] [post:3]" sources={sources} />);
  const pills = screen.getAllByRole("button", { name: /^Sources:/ });
  expect(pills).toHaveLength(1);
  expect(pills[0].getAttribute("aria-label")).toBe("Sources: 3 posts by @notthreadguy");
  expect(pills[0].textContent).toMatch(/notthreadguy· 3$/);
});

it("shows other creators in a run as +N and lists every post in the card", () => {
  render(<InsightMarkdown text="Both agree. [post:4][post:1][post:2]" sources={sources} />);
  const pill = screen.getByRole("button", {
    name: "Sources: 3 posts by @tulipking, @notthreadguy",
  });
  expect(pill.textContent).toMatch(/tulipking\+1$/);
  fireEvent.click(pill);
  const card = screen.getByRole("dialog", { name: "Cited posts" });
  expect(within(card).getAllByRole("link", { name: /Open on X/ })).toHaveLength(3);
  // Portaled out of the answer, so it can never widen the panel's scroller.
  expect(card.parentElement).toBe(document.body);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("renders wide tables as cards with labels above values and one Sources row", () => {
  const table = [
    "| Idea | Who | Reasoning | Timeframe |",
    "| --- | --- | --- | --- |",
    "| Buy ZEC | threadguy [post:1] | Flows return [post:2] | 6–12 months [post:3] |",
  ].join("\n");
  const { container } = render(<InsightMarkdown text={table} sources={sources} />);
  const labels = [...container.querySelectorAll("dt")].map((dt) => dt.textContent);
  expect(labels).toEqual(["Who", "Reasoning", "Timeframe"]);
  // No citation pills inside the field values…
  for (const dd of container.querySelectorAll("dd"))
    expect(within(dd as HTMLElement).queryByRole("button")).toBeNull();
  // …just one per creator in the card's Sources row.
  const pills = screen.getAllByRole("button", { name: /^Sources:/ });
  expect(pills).toHaveLength(1);
  expect(pills[0].closest("p")?.textContent).toMatch(/^Sources/);
});
