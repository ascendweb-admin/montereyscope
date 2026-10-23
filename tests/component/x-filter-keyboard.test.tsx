// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { FilterBar } from "@/components/x-dashboard/feed-column";
import type { Period, ShowFilter } from "@/lib/x/dashboard/model";

afterEach(cleanup);
function Harness() {
  const [period, setPeriod] = useState<Period>("all"),
    [show, setShow] = useState<ShowFilter>("posts");
  const [query, setQuery] = useState(""),
    [accounts, setAccounts] = useState<number[] | null>(null);
  return (
    <FilterBar
      period={period}
      onPeriod={setPeriod}
      show={show}
      onShow={setShow}
      query={query}
      onQuery={setQuery}
      creatorFilter={accounts}
      onCreatorFilter={setAccounts}
      creators={[
        { id: 1, displayName: "Alice", handle: "alice", avatarUrl: null, categoryIds: [] },
        { id: 2, displayName: "Bob", handle: "bob", avatarUrl: null, categoryIds: [] },
      ]}
    />
  );
}

it("opens the post-type menu with arrows, navigates choices and returns focus after selection or Escape", () => {
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Posts" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const choices = screen.getAllByRole("menuitemradio");
  expect(document.activeElement).toBe(choices[0]);
  expect(choices[0].getAttribute("aria-checked")).toBe("true");
  fireEvent.keyDown(choices[0], { key: "ArrowDown" });
  expect(document.activeElement).toBe(choices[1]);
  fireEvent.keyDown(choices[1], { key: "End" });
  expect(document.activeElement).toBe(choices[2]);
  fireEvent.click(choices[2]);
  const selected = screen.getByRole("button", { name: "Everything" });
  expect(document.activeElement).toBe(selected);
  fireEvent.click(selected);
  expect(
    screen.getByRole("menuitemradio", { name: /Everything/ }).getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.keyDown(screen.getAllByRole("menuitemradio")[0], { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(selected);
});

it("focuses the account choices and restores the updated trigger on Done or Escape", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Filter accounts: All accounts" }));
  let dialog = screen.getByRole("dialog", { name: "Filter accounts" });
  const alice = within(dialog).getByRole("checkbox", { name: /Alice/ });
  expect(document.activeElement).toBe(alice);
  fireEvent.click(alice);
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  const trigger = screen.getByRole("button", { name: "Filter accounts: Alice" });
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  dialog = screen.getByRole("dialog", { name: "Filter accounts" });
  fireEvent.keyDown(within(dialog).getAllByRole("checkbox")[0], { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("dismisses a nonmodal account popup when keyboard focus moves outside", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Filter accounts: All accounts" }));
  const search = screen.getByRole("searchbox", { name: "Search posts" });
  act(() => search.focus());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(search);
});
