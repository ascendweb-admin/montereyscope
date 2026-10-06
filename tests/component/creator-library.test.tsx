// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreatorLibrary, type LibraryCreator } from "@/components/library/creator-library";

vi.mock("@/app/actions/creators", () => ({ removeCreatorAction: vi.fn() }));
vi.mock("@/app/actions/categories", () => ({ setCreatorCategoriesAction: vi.fn() }));
vi.mock("@/app/actions/feeds", () => ({ refreshCreatorFeedsAction: vi.fn() }));

const crypto = { id: 1, name: "Crypto", color: "sky" as const };
const creators: LibraryCreator[] = [
  {
    id: 1,
    displayName: "Crypto YouTube",
    handle: "ytcrypto",
    platform: "youtube",
    avatarUrl: null,
    categories: [crypto],
  },
  {
    id: 2,
    displayName: "Crypto Rumble",
    handle: "rmcrypto",
    platform: "rumble",
    avatarUrl: null,
    categories: [crypto],
  },
  {
    id: 3,
    displayName: "Other Rumble",
    handle: null,
    platform: "rumble",
    avatarUrl: null,
    categories: [],
  },
];

function setup() {
  render(<CreatorLibrary creators={creators} categories={[{ ...crypto, creatorCount: 2 }]} />);
}

function filterPlatform(value: string) {
  fireEvent.click(screen.getByRole("button", { name: /^Filter by platform:/ }));
  const label = value === "all" ? "All platforms" : value === "youtube" ? "YouTube" : "Rumble";
  fireEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(label) }));
}

afterEach(cleanup);

describe("Creator library platform filters", () => {
  it("labels each saved creator and filters both platforms", () => {
    setup();
    const cards = within(screen.getByRole("list", { name: "Saved creators" })).getAllByRole(
      "listitem",
    );
    expect(within(cards[0]).getByText("YouTube")).toBeTruthy();
    expect(within(cards[1]).getByText("Rumble")).toBeTruthy();
    filterPlatform("youtube");
    expect(screen.getByRole("heading", { name: "Crypto YouTube" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Crypto Rumble" })).toBeNull();
    filterPlatform("rumble");
    expect(screen.queryByRole("heading", { name: "Crypto YouTube" })).toBeNull();
    expect(screen.getByText(/^Showing /).textContent).toContain("Showing 2 of 3 creators");
  });

  it("supports keyboard navigation, selection, and dismissal", () => {
    setup();
    const trigger = screen.getByRole("button", { name: "Filter by platform: All platforms" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const all = screen.getByRole("menuitemradio", { name: /All platforms/ });
    expect(document.activeElement).toBe(all);
    fireEvent.keyDown(all, { key: "End" });
    const xOption = screen.getByRole("menuitemradio", { name: /^X/ });
    expect(document.activeElement).toBe(xOption);
    fireEvent.keyDown(xOption, { key: "ArrowUp" });
    const rumble = screen.getByRole("menuitemradio", { name: /Rumble/ });
    expect(document.activeElement).toBe(rumble);
    fireEvent.click(rumble);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: /Rumble/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("combines platform, categories, and search and resets them from an empty result", () => {
    setup();
    filterPlatform("rumble");
    fireEvent.click(screen.getByRole("button", { name: "Crypto 2" }));
    expect(screen.getByText(/^Showing /).textContent).toContain("Showing 1 of 3 creators");
    expect(screen.getByRole("heading", { name: "Crypto Rumble" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ytcrypto" } });
    expect(screen.getByText("No creators match these filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all creators" }));
    expect(screen.getByText(/^Showing /).textContent).toContain("Showing 3 of 3 creators");
    expect(screen.getByRole("button", { name: "Filter by platform: All platforms" })).toBeTruthy();
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
  });
});
