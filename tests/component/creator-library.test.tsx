// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreatorLibrary, type LibraryCreator } from "@/components/library/creator-library";

vi.mock("@/app/actions/creators", () => ({
  removeProfileAction: vi.fn(),
  linkProfilesAction: vi.fn(),
  dismissLinkSuggestionAction: vi.fn(),
}));
vi.mock("@/app/actions/categories", () => ({ setProfileCategoriesAction: vi.fn() }));
vi.mock("@/app/actions/feeds", () => ({ refreshCreatorFeedsAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const crypto = { id: 1, name: "Crypto", color: "sky" as const };
function person(
  id: number,
  displayName: string,
  accounts: LibraryCreator["accounts"],
  categories: LibraryCreator["categories"] = [],
): LibraryCreator {
  return { id, displayName, avatarUrl: null, avatarCreatorId: null, accounts, categories };
}
const creators: LibraryCreator[] = [
  person(
    1,
    "Crypto YouTube",
    [{ id: 1, platform: "youtube", displayName: "Crypto YouTube", handle: "ytcrypto" }],
    [crypto],
  ),
  person(
    2,
    "Crypto Rumble",
    [{ id: 2, platform: "rumble", displayName: "Crypto Rumble", handle: "rmcrypto" }],
    [crypto],
  ),
  person(3, "Other Rumble", [
    { id: 3, platform: "rumble", displayName: "Other Rumble", handle: null },
  ]),
];

function setup(list: LibraryCreator[] = creators) {
  render(<CreatorLibrary creators={list} categories={[{ ...crypto, creatorCount: 2 }]} />);
}

/** The grid's cards (each card holds its own list of platform chips). */
function savedCards(): HTMLElement[] {
  return Array.from(screen.getByRole("list", { name: "Saved creators" }).children) as HTMLElement[];
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
    const cards = savedCards();
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

  it("shows one card per person with a chip for every linked platform", () => {
    setup([
      person(7, "Jane Doe", [
        { id: 10, platform: "youtube", displayName: "Jane Doe", handle: "janedoe" },
        { id: 11, platform: "youtube", displayName: "Jane Clips", handle: "janeclips" },
        { id: 12, platform: "x", displayName: "Jane", handle: "jane" },
      ]),
      person(8, "Rumble Only", [
        { id: 13, platform: "rumble", displayName: "Rumble Only", handle: "rumbleonly" },
      ]),
    ]);
    const card = savedCards()[0];
    const platforms = within(card).getByRole("list", { name: "Jane Doe's platforms" });
    // A repeated platform is told apart by handle; a unique one by name.
    expect(
      within(platforms)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["@janedoe", "@janeclips", "X"]);
    expect(
      within(platforms).getByRole("link", { name: "Open @jane on X" }).getAttribute("href"),
    ).toBe("/creators/7?account=12");
    expect(within(card).getByRole("link", { name: "Jane Doe" }).getAttribute("href")).toBe(
      "/creators/7",
    );
    expect(screen.getByText(/^Showing /).textContent).toContain(
      "Showing 2 of 2 creators · 4 platform accounts",
    );

    // Any linked account's platform or handle finds the person.
    filterPlatform("rumble");
    expect(screen.queryByRole("heading", { name: "Jane Doe" })).toBeNull();
    filterPlatform("all");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "janeclips" } });
    expect(screen.getByRole("heading", { name: "Jane Doe" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Rumble Only" })).toBeNull();
  });

  it("offers matching creators for linking and opens the link dialog preselected", () => {
    render(
      <CreatorLibrary
        creators={[
          person(1, "Jane Doe", [
            { id: 1, platform: "youtube", displayName: "Jane Doe", handle: "jd" },
          ]),
          person(2, "Jane Doe", [{ id: 2, platform: "x", displayName: "Jane Doe", handle: "jd" }]),
        ]}
        categories={[]}
        linkSuggestions={[{ targetId: 1, profileIds: [1, 2] }]}
      />,
    );
    const suggestions = screen.getByRole("region", { name: "Same person on different platforms?" });
    expect(within(suggestions).getByText("2 creators on YouTube and X")).toBeTruthy();
    fireEvent.click(within(suggestions).getByRole("button", { name: "Review & link" }));
    const dialog = screen.getByRole("dialog", { name: "Link accounts to Jane Doe" });
    expect(within(dialog).getByRole("button", { name: /Jane Doe/, pressed: true })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Link creator" })).toBeTruthy();
  });
});
