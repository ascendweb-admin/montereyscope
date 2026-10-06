// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SourceCitation } from "@/components/ai/citation";

afterEach(cleanup);
it("links X citations to the source with its author and publication date", () => {
  render(
    <SourceCitation
      source={{
        kind: "tweet",
        id: "123",
        creator: "Author",
        title: "Post",
        url: "https://x.com/author/status/123",
        publishedAt: "2026-09-16T12:00:00Z",
      }}
    />,
  );
  const link = screen.getByRole("link", { name: /Author.*2026-09-16.*Open on X/ });
  expect(link.getAttribute("href")).toBe("https://x.com/author/status/123");
  expect(link.textContent).toContain("2026-09-16");
});
it("uses a canonical X fallback for an untrusted source URL", () => {
  render(
    <SourceCitation
      source={{ kind: "tweet", id: "123", title: "Post", url: "https://evil.example/status/123" }}
    />,
  );
  expect(screen.getByRole("link").getAttribute("href")).toBe("https://x.com/i/status/123");
});
