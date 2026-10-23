// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnalyzePanel } from "@/components/x-dashboard/analyze-panel";
import type { InsightSummary } from "@/lib/x/dashboard/model";

const { request, changeActive } = vi.hoisted(() => ({
  request: vi.fn(),
  changeActive: vi.fn(),
}));

vi.mock("@/components/x-dashboard/use-dashboard-data", () => ({
  requestJson: request,
  useInsight: () => ({ insight: null, error: null, setInsight: vi.fn(), refresh: vi.fn() }),
}));

const analysis: InsightSummary = {
  id: "analysis-1",
  title: "Market review",
  preset: "brief",
  listId: null,
  scope: {
    label: "All accounts",
    listId: null,
    creatorIds: [],
    period: "all",
    show: "everything",
    since: "2026-09-01T00:00:00Z",
    until: "2026-10-21T00:00:00Z",
  },
  postCount: 1,
  status: "complete",
  backend: "codex",
  model: "fixture",
  mode: "balanced",
  error: null,
  reportId: 4,
  createdAt: "2026-10-21T12:00:00Z",
  updatedAt: "2026-10-21T12:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  request.mockResolvedValue({ insights: [analysis] });
});
afterEach(cleanup);

async function openDelete() {
  render(
    <AnalyzePanel
      scope={analysis.scope}
      aiModels={{ provider: "QA", modes: { quick: "Fast", balanced: "Normal", deep: "Deep" } }}
      activeId={analysis.id}
      onActiveIdChange={changeActive}
      onClearSelection={vi.fn()}
      onClose={vi.fn()}
      draftQuestion=""
      onDraftQuestionChange={vi.fn()}
      wide={false}
      onWideChange={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Past analyses" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete Market review" }));
  return screen.getByRole("dialog", { name: "Delete analysis" });
}

const deletes = () => request.mock.calls.filter(([, init]) => init?.method === "DELETE");

it("requires confirmation, focuses Cancel, and preserves the analysis on cancellation", async () => {
  const dialog = await openDelete();
  expect(dialog.textContent).toContain("Market review");
  expect(dialog.textContent).toContain("Saved reports and source posts stay in Scope.");
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  expect(deletes()).toHaveLength(0);
  fireEvent.click(cancel);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Delete Market review" })).toBeTruthy();
  expect(deletes()).toHaveLength(0);
});

it("waits for the confirmed deletion, prevents duplicate submissions, and clears the active item", async () => {
  const dialog = await openDelete();
  let finish!: (result: unknown) => void;
  request.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete analysis" }));
  expect(deletes()).toHaveLength(1);
  expect(deletes()[0][0]).toBe("/api/x-dashboard/insights/analysis-1");
  const deleting = within(dialog).getByRole("button", { name: "Deleting…" });
  expect((deleting as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(deleting);
  expect(deletes()).toHaveLength(1);
  expect(changeActive).not.toHaveBeenCalled();
  await act(async () => finish({ deleted: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete Market review" })).toBeNull();
  expect(changeActive).toHaveBeenCalledWith(null);
});

it("keeps a failed deletion visible inside the dialog and permits retry", async () => {
  const dialog = await openDelete();
  request.mockRejectedValueOnce(new Error("Database is busy. Try again."));
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete analysis" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("Database is busy");
  expect(changeActive).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Delete Market review" })).toBeTruthy();
  request.mockResolvedValueOnce({ deleted: true });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete analysis" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(deletes()).toHaveLength(2);
});
