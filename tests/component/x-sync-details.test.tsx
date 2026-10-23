// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { XSyncDetails } from "@/app/settings/x-sync-details";

vi.mock("@/components/x-dashboard/use-dashboard-data", () => ({
  requestJson: vi.fn(async () => ({
    creators: [{ id: 2, displayName: "QA", handle: "qa", avatarUrl: null }],
    sync: null,
  })),
}));
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

it("opens the hash target after data loads", async () => {
  window.location.hash = "#x-sync-details";
  const view = render(<XSyncDetails />);
  await screen.findByRole("heading", { name: "X sync details" });
  await waitFor(() => expect(view.container.querySelector("details")?.open).toBe(true));
});

it("also opens after hash navigation on an already loaded Settings page", async () => {
  window.location.hash = "#appearance-heading";
  const view = render(<XSyncDetails />);
  await screen.findByRole("heading", { name: "X sync details" });
  expect(view.container.querySelector("details")?.open).toBe(false);
  window.location.hash = "#x-sync-details";
  fireEvent(window, new Event("hashchange"));
  await waitFor(() => expect(view.container.querySelector("details")?.open).toBe(true));
});
