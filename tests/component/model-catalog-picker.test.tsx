// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiBackendSetting } from "@/app/settings/ai-backend-setting";
import { ModelCatalogProvider, mergeSnapshots } from "@/components/ai/model-catalog-provider";
import type { AiAuthSnapshot, ProviderAuthSnapshot } from "@/lib/ai/auth-types";
import { getDefaultAiChatModeSettings } from "@/lib/ai/model-catalog";
import { bundledCatalogSnapshot } from "@/lib/ai/models/bundled";
import type { CatalogModel, ModelCatalogSnapshot } from "@/lib/ai/models/types";

vi.mock("@/app/actions/settings", () => ({
  saveAiBackendAction: vi.fn(),
  saveAiChatModeSettingsAction: vi.fn(),
}));

const NOW = Date.now();

function discovered(overrides: Partial<CatalogModel>): CatalogModel {
  return {
    provider: "codex",
    id: "gpt-6-sol",
    runtimeId: "gpt-6-sol",
    label: "GPT-6 Sol",
    description: "Newest reasoning model",
    reasoningOptions: [
      { id: "low", label: "Low", description: "Fast" },
      { id: "high", label: "High", description: "Deep" },
    ],
    defaultReasoningEffort: "high",
    effortsKnown: true,
    runtimeCompatibility: "supported",
    access: "account",
    aliasTarget: null,
    recommended: false,
    upgrade: null,
    source: "discovered",
    firstSeenAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function liveSnapshot(): ModelCatalogSnapshot {
  const base = bundledCatalogSnapshot();
  const models: CatalogModel[] = [
    // Baseline model: no New badge.
    discovered({
      id: "gpt-6-astra",
      runtimeId: "gpt-6-astra",
      label: "GPT-6 Astra",
      firstSeenAt: "2026-09-01T00:00:00.000Z",
    }),
    // Newly discovered after the baseline: badged.
    discovered({}),
    // Capabilities unknown: provider default is offered honestly.
    discovered({
      id: "gpt-6-mystery",
      runtimeId: "gpt-6-mystery",
      label: "GPT-6 Mystery",
      firstSeenAt: "2026-09-01T00:00:00.000Z",
      effortsKnown: false,
      reasoningOptions: [],
      defaultReasoningEffort: null,
    }),
  ];
  return {
    checkedAt: new Date(NOW).toISOString(),
    providers: {
      ...base.providers,
      codex: {
        provider: "codex",
        state: "live",
        connectionKey: "test-connection",
        revision: 4,
        models,
        lastAttemptAt: new Date(NOW).toISOString(),
        lastSuccessAt: new Date(NOW).toISOString(),
        baselineAt: "2026-09-01T00:00:00.000Z",
        error: null,
        fallback: false,
        refreshing: false,
      },
    },
  };
}

function provider(overrides: Partial<ProviderAuthSnapshot> = {}): ProviderAuthSnapshot {
  return {
    installed: true,
    compatible: true,
    authenticated: false,
    subscription: false,
    method: "none",
    detail: null,
    keySaved: false,
    otherCredentialCount: 0,
    deviceCodeAvailable: true,
    attempt: null,
    signingOut: false,
    statusError: null,
    resolvedCommand: "codex",
    commandSource: "auto",
    ...overrides,
  };
}

function authSnapshot(): AiAuthSnapshot {
  return {
    instanceId: "test-instance",
    revision: 1,
    checkedAt: "2026-09-16T12:00:00.000Z",
    backend: "codex",
    codex: provider({ authenticated: true, subscription: true, method: "chatgpt" }),
    opencode: provider(),
    claude: provider(),
  };
}

beforeEach(() => {
  const catalog = liveSnapshot();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/ai/models" || url === "/api/ai/models/refresh") {
        return new Response(JSON.stringify(catalog), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(authSnapshot()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderWithCatalog(modeSettings = getDefaultAiChatModeSettings()): void {
  render(
    <ModelCatalogProvider>
      <AiBackendSetting
        initialBackend="codex"
        initialModeSettings={modeSettings}
        initialStatus={authSnapshot()}
        platform="linux"
      />
    </ModelCatalogProvider>,
  );
}

describe("catalog snapshot merging", () => {
  it("replaces the previous account's snapshot when the connection changes", () => {
    const previous = liveSnapshot();
    const next = liveSnapshot();
    next.providers.codex = {
      ...next.providers.codex,
      connectionKey: "next-connection",
      revision: 1,
      state: "bundled",
      fallback: true,
    };
    const merged = mergeSnapshots(previous, next);
    expect(merged.providers.codex.connectionKey).toBe("next-connection");
    expect(merged.providers.codex.state).toBe("bundled");
  });

  it("drops a stale revision from the same connection", () => {
    const previous = liveSnapshot();
    const next = liveSnapshot();
    next.providers.codex = {
      ...next.providers.codex,
      connectionKey: previous.providers.codex.connectionKey,
      revision: previous.providers.codex.revision - 1,
      state: "empty",
      models: [],
    };
    const merged = mergeSnapshots(previous, next);
    expect(merged.providers.codex.state).toBe("live");
    expect(merged.providers.codex.models.length).toBe(3);
  });
});

describe("catalog-driven chat defaults", () => {
  it("shows live catalog freshness instead of the bundled fallback", async () => {
    renderWithCatalog();
    await waitFor(() => expect(screen.getByText(/Models updated/)).toBeTruthy());
    expect(screen.queryByText("Bundled list")).toBeNull();
  });

  it("badges only models discovered after the baseline", async () => {
    renderWithCatalog();
    await waitFor(() => expect(screen.getByText(/Models updated/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Model for Quick/ }));
    await waitFor(() => expect(screen.getByText("GPT-6 Sol")).toBeTruthy());
    // Exactly one model carries the New badge.
    expect(screen.getAllByText("New")).toHaveLength(1);
    expect(screen.getByText("GPT-6 Astra")).toBeTruthy();
    expect(screen.getByText("GPT-6 Mystery")).toBeTruthy();
  });

  it("opens and navigates the list without scrolling page ancestors", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderWithCatalog();
    await waitFor(() => expect(screen.getByText(/Models updated/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Model for Quick/ }));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "End" });
    // scrollIntoView walks up every scrollable ancestor, which used to scroll
    // the whole settings page (and the anchored popover) on open and arrowing.
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("keeps an unavailable saved selection visible with a replacement hint", async () => {
    const settings = getDefaultAiChatModeSettings();
    settings.codex.quick = { model: "gpt-5.4", reasoningEffort: "medium" };
    renderWithCatalog(settings);
    await waitFor(() => expect(screen.getByText(/Models updated/)).toBeTruthy());
    expect(screen.getByText(/not in the current codex model list/)).toBeTruthy();
    expect(screen.getByText(/this choice stays until you replace it/)).toBeTruthy();
    expect(screen.getByText("gpt-5.4")).toBeTruthy();
  });

  it("offers Provider default for a model with unknown capabilities", async () => {
    const settings = getDefaultAiChatModeSettings();
    settings.codex.quick = { model: "gpt-6-mystery", reasoningEffort: null };
    renderWithCatalog(settings);
    await waitFor(() => expect(screen.getByText(/Models updated/)).toBeTruthy());
    expect(screen.getByText("Provider default")).toBeTruthy();
    expect(screen.getByText(/Capabilities could not be determined/)).toBeTruthy();
  });
});

it("does not let a delayed old-account response replace the current connection", () => {
  const current = liveSnapshot();
  current.providers.codex.generation = 3;
  current.providers.codex.connectionKey = "codex:g3";
  const delayed = liveSnapshot();
  delayed.providers.codex.generation = 2;
  delayed.providers.codex.connectionKey = "codex:g2";
  delayed.providers.codex.revision = 100;
  expect(mergeSnapshots(current, delayed).providers.codex.connectionKey).toBe("codex:g3");
});

it("lets the user clear an obsolete effort after a model loses its effort controls", async () => {
  const catalog = liveSnapshot();
  catalog.providers.codex.models[0].reasoningOptions = [];
  catalog.providers.codex.models[0].defaultReasoningEffort = null;
  vi.mocked(fetch).mockImplementation(
    async (input) =>
      new Response(JSON.stringify(String(input).includes("/models") ? catalog : authSnapshot()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const settings = getDefaultAiChatModeSettings();
  settings.codex.quick = { model: "gpt-6-astra", reasoningEffort: "high" };
  renderWithCatalog(settings);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Use provider default" })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Use provider default" }));
  expect(screen.queryByRole("button", { name: "Use provider default" })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Save chat defaults" }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

it("updates a fast provider while another refresh is still pending", async () => {
  let finishSlow!: (response: Response) => void;
  const response = (snapshot: ModelCatalogSnapshot) =>
    new Response(JSON.stringify(snapshot), { status: 200 });
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input) === "/api/ai/models/refresh") {
      const body = JSON.parse(String(init?.body));
      expect(body.manual).toBe(false);
      if (body.provider === "opencode")
        return new Promise((resolve) => {
          finishSlow = resolve;
        });
      return response(liveSnapshot());
    }
    if (String(input) === "/api/ai/models") return response(bundledCatalogSnapshot());
    return new Response(JSON.stringify(authSnapshot()), { status: 200 });
  });
  renderWithCatalog();
  await waitFor(() => expect(screen.getByText(/Models updated/)).toBeTruthy());
  expect(finishSlow).toBeTypeOf("function");
  finishSlow(response(liveSnapshot()));
});
