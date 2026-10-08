"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Brain,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Scale,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { saveAiBackendAction, saveAiChatModeSettingsAction } from "@/app/actions/settings";
import { CHAT_MODE_OPTIONS, type ChatModeId } from "@/components/ai/chat-modes";
import { useModelCatalog } from "@/components/ai/model-catalog-provider";
import { ModelPicker, type ModelPickerOption } from "@/components/ai/model-picker";
import { ChatGptLogo, ClaudeLogo, OpenCodeLogo } from "@/components/ai/provider-logos";
import { AlertNote } from "@/components/ui/alert-note";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import type { AiBackendId } from "@/lib/ai/backend-id";
import {
  isTerminalAuthPhase,
  type AiAuthSnapshot,
  type AuthAttemptSnapshot,
  type AuthProviderId,
  type ProviderAuthSnapshot,
} from "@/lib/ai/auth-types";
import {
  findCatalogModel,
  isCatalogModelUsable,
  isNewCatalogModel,
  type CatalogModel,
  type CatalogReasoningOption,
  type ProviderCatalogSnapshot,
} from "@/lib/ai/models/types";
import type { AiChatModeSettings, ChatModeSelection } from "@/lib/ai/model-catalog";
import { cn } from "@/lib/utils";

const BACKEND_OPTIONS: Array<{
  id: AiBackendId;
  label: string;
  tagline: string;
}> = [
  {
    id: "codex",
    label: "Codex",
    tagline: "ChatGPT subscription via the codex CLI.",
  },
  {
    id: "opencode",
    label: "OpenCode Go",
    tagline: "OpenCode Go via the opencode CLI.",
  },
  {
    id: "claude",
    label: "Claude Code",
    tagline: "Claude subscription via the claude CLI.",
  },
];

const BACKEND_LABEL: Record<AiBackendId, string> = {
  codex: "Codex",
  opencode: "OpenCode Go",
  claude: "Claude Code",
};

const SIGN_OUT_NOTE: Record<AuthProviderId, string> = {
  codex:
    "This signs out the shared codex CLI on this machine. Your ChatGPT subscription and saved chats stay unchanged.",
  claude:
    "This signs out the shared claude CLI on this machine. Your Claude subscription and saved chats stay unchanged.",
  opencode:
    "This removes the local OpenCode Go key from opencode's credential file on this machine. It does not cancel anything in your OpenCode dashboard.",
};

const MODE_ICONS: Record<ChatModeId, LucideIcon> = {
  quick: Zap,
  balanced: Scale,
  deep: Brain,
};

/** Official provider setup pages; verified against each project's docs. */
const PROVIDER_DOCS: Record<AiBackendId, { label: string; url: string }> = {
  codex: { label: "Codex CLI setup guide", url: "https://developers.openai.com/codex" },
  opencode: { label: "OpenCode install guide", url: "https://opencode.ai/docs" },
  claude: { label: "Claude Code setup guide", url: "https://code.claude.com/docs/en/install" },
};

/**
 * Provider installation commands for the machine scope is running on. Each
 * provider installs separately and brings its own login; scope never installs
 * or bundles one for the user. Native installers are preferred on Windows;
 * npm installs work through the provider's command wrapper or the executable
 * path override.
 */
function providerInstallHint(id: AiBackendId, platform: string): string {
  if (id === "codex") {
    if (platform === "win32") {
      return 'Install Codex CLI, then check again: powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex". Prefer this standalone install; if an npm install is not detected, use "Set executable path".';
    }
    if (platform === "darwin") {
      return "Install Codex CLI, then check again: curl -fsSL https://chatgpt.com/codex/install.sh | sh. Homebrew also works: brew install --cask codex.";
    }
    return "Install Codex CLI, then check again: curl -fsSL https://chatgpt.com/codex/install.sh | sh";
  }
  if (id === "claude") {
    if (platform === "win32") {
      return 'Install Claude Code from PowerShell, then check again: irm https://claude.ai/install.ps1 | iex. Prefer this native installer (claude.exe under your user profile); for npm installs use "Set executable path" if detection fails.';
    }
    if (platform === "darwin") {
      return "Install Claude Code, then check again: curl -fsSL https://claude.ai/install.sh | bash. Homebrew also works: brew install --cask claude-code.";
    }
    return "Install Claude Code, then check again: curl -fsSL https://claude.ai/install.sh | bash";
  }
  if (platform === "win32") {
    return 'Install OpenCode for Windows: scoop install opencode, or follow the install guide. For npm installs (npm install -g opencode-ai), use "Set executable path" if the wrapper is not detected.';
  }
  if (platform === "darwin") {
    return "Install OpenCode, then check again: curl -fsSL https://opencode.ai/install | bash. Homebrew also works: brew install opencode.";
  }
  return "Install OpenCode, then check again: curl -fsSL https://opencode.ai/install | bash";
}

type StatusTone = "ok" | "partial" | "error" | "neutral" | "unknown";

interface ProviderStatus {
  tone: StatusTone;
  label: string;
  detail: string | null;
}

function providerStatus(
  id: AiBackendId,
  snapshot: ProviderAuthSnapshot | null,
  platform: string,
): ProviderStatus {
  if (snapshot === null) {
    return { tone: "unknown", label: "Checking status…", detail: null };
  }
  if (snapshot.statusError) {
    return { tone: "error", label: "Status unavailable", detail: snapshot.statusError.message };
  }
  if (!snapshot.installed) {
    return {
      tone: "error",
      label: `${id} CLI not found`,
      detail: providerInstallHint(id, platform),
    };
  }
  if (!snapshot.compatible) {
    return {
      tone: "error",
      label: "CLI is too old",
      detail:
        id === "claude"
          ? "Update Claude Code to the latest version, then check again."
          : "Update the codex CLI to use the account protocol, then check again.",
    };
  }

  if (id === "opencode") {
    if (snapshot.keySaved) {
      return { tone: "ok", label: "OpenCode Go key saved", detail: snapshot.detail };
    }
    if (snapshot.otherCredentialCount > 0) {
      return {
        tone: "partial",
        label: "Other OpenCode credentials only",
        detail: `${snapshot.otherCredentialCount} other credential(s) found; no Go key.`,
      };
    }
    return { tone: "neutral", label: "Not connected", detail: null };
  }

  if (id === "codex") {
    if (snapshot.subscription) {
      return { tone: "ok", label: "Signed in with ChatGPT", detail: snapshot.detail };
    }
    if (snapshot.authenticated) {
      return {
        tone: "partial",
        label: "Connected with an API key",
        detail: "scope expects a ChatGPT subscription sign-in.",
      };
    }
    return { tone: "neutral", label: "Not signed in", detail: null };
  }

  if (snapshot.subscription) {
    return { tone: "ok", label: "Signed in with Claude", detail: snapshot.detail };
  }
  if (snapshot.authenticated) {
    return {
      tone: "partial",
      label: "Connected — not a subscription login",
      detail:
        snapshot.method === "api_key"
          ? "Signed in with an API key; scope expects a Claude Pro/Max sign-in."
          : "Signed in with a non-subscription credential.",
    };
  }
  return { tone: "neutral", label: "Not signed in", detail: null };
}

// ---------------------------------------------------------------------------
// Status hook
// ---------------------------------------------------------------------------

interface AuthStatusState {
  status: AiAuthSnapshot | null;
  statusFailed: boolean;
  refresh: (options?: { silent?: boolean }) => Promise<AiAuthSnapshot | null>;
  applySnapshot: (next: AiAuthSnapshot) => void;
}

/**
 * Single polling hook: a recursive timeout that schedules the next request
 * only after the previous one settles (no overlapping CLI probes), abort on
 * unmount, revision checks so a stale response cannot regress the UI, and a
 * refresh on focus/visibility return. Polling only runs while a sign-in is
 * in flight; idle providers are not probed every two seconds.
 */
function useAuthStatus(initial: AiAuthSnapshot | null): AuthStatusState {
  const [status, setStatus] = useState<AiAuthSnapshot | null>(initial);
  const [statusFailed, setStatusFailed] = useState(initial === null);
  const revision = useRef(initial?.revision ?? 0);
  const instanceId = useRef(initial?.instanceId);
  const retiredInstances = useRef(new Set<string>());
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  const applySnapshot = useCallback((next: AiAuthSnapshot) => {
    if (retiredInstances.current.has(next.instanceId)) {
      return;
    }
    if (next.instanceId !== instanceId.current) {
      if (instanceId.current !== undefined) {
        retiredInstances.current.add(instanceId.current);
      }
      instanceId.current = next.instanceId;
      revision.current = 0;
    }
    if (next.revision < revision.current) {
      return;
    }
    if (next.revision > revision.current) {
      window.dispatchEvent(new Event("scope:ai-auth-changed"));
    }
    revision.current = Math.max(revision.current, next.revision);
    setStatus(next);
    setStatusFailed(false);
  }, []);

  const refresh = useCallback(
    async (options?: { silent?: boolean }): Promise<AiAuthSnapshot | null> => {
      if (inFlight.current) {
        return null;
      }
      inFlight.current = true;
      const abort = new AbortController();
      controller.current = abort;
      try {
        const response = await fetch("/api/ai/auth", { cache: "no-store", signal: abort.signal });
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }
        const next = (await response.json()) as AiAuthSnapshot;
        if (mounted.current) {
          applySnapshot(next);
        }
        return next;
      } catch {
        // A failed background refresh keeps the last good snapshot; only an
        // explicit check turns the section into a hard failure state.
        if (mounted.current && !abort.signal.aborted && options?.silent !== true) {
          setStatusFailed(true);
        }
        return null;
      } finally {
        inFlight.current = false;
        if (controller.current === abort) {
          controller.current = null;
        }
      }
    },
    [applySnapshot],
  );

  const activeAttempt = (id: AiBackendId): boolean => {
    const attempt = status?.[id]?.attempt ?? null;
    return attempt !== null && !isTerminalAuthPhase(attempt.phase);
  };
  const anyActive = activeAttempt("codex") || activeAttempt("claude");

  useEffect(() => {
    if (!anyActive) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      timer = setTimeout(() => {
        void refresh().then(() => {
          if (!cancelled) {
            schedule();
          }
        });
      }, 1_500);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [anyActive, refresh]);

  useEffect(() => {
    const onFocus = (): void => {
      void refresh({ silent: true });
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        void refresh({ silent: true });
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  return { status, statusFailed, refresh, applySnapshot };
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

interface AuthOperationPayload {
  ok?: boolean;
  error?: { code?: string; message?: string };
  snapshot?: AiAuthSnapshot;
}

function terminalAttemptIds(status: AiAuthSnapshot | null): Set<string> {
  const ids = new Set<string>();
  if (status === null) {
    return ids;
  }
  for (const provider of ["codex", "opencode", "claude"] as const) {
    const attempt = status[provider]?.attempt;
    if (attempt && isTerminalAuthPhase(attempt.phase)) {
      ids.add(attempt.id);
    }
  }
  return ids;
}

export function AiBackendSetting({
  initialBackend,
  initialModeSettings,
  initialStatus,
  platform,
}: {
  initialBackend: AiBackendId;
  initialModeSettings: AiChatModeSettings;
  initialStatus: AiAuthSnapshot | null;
  /** Host platform, so install instructions match the machine. */
  platform: string;
}) {
  const [backend, setBackend] = useState<AiBackendId>(initialBackend);
  const [savedBackend, setSavedBackend] = useState<AiBackendId>(initialBackend);
  const [modeSettings, setModeSettings] = useState<AiChatModeSettings>(initialModeSettings);
  const [savedModeSettings, setSavedModeSettings] =
    useState<AiChatModeSettings>(initialModeSettings);
  const [settingsMode, setSettingsMode] = useState<ChatModeId>("quick");
  const [savingModeSettings, setSavingModeSettings] = useState(false);
  const [savingBackend, setSavingBackend] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const { status, statusFailed, refresh, applySnapshot } = useAuthStatus(initialStatus);
  const {
    snapshot: catalogSnapshot,
    refresh: refreshCatalog,
    refreshingProviders,
  } = useModelCatalog();
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const providerCatalog = catalogSnapshot.providers[backend];
  const { showToast, toastElement } = useToast();
  // Terminal attempts already present in the server-rendered snapshot were
  // announced before this mount (or before a reload); don't toast them again.
  const announcedAttempts = useRef(terminalAttemptIds(initialStatus));

  // Dialog state
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [codeDialogOpen, setCodeDialogOpen] = useState(false);
  const [claudeCode, setClaudeCode] = useState("");
  const [claudeCodeSaving, setClaudeCodeSaving] = useState(false);
  const [claudeCodeError, setClaudeCodeError] = useState<string | null>(null);
  const [logoutProvider, setLogoutProvider] = useState<AuthProviderId | null>(null);
  const [logoutPending, setLogoutPending] = useState(false);

  const announceAttempt = useCallback(
    (provider: AuthProviderId, attempt: AuthAttemptSnapshot | null | undefined): void => {
      if (!attempt || !isTerminalAuthPhase(attempt.phase)) {
        return;
      }
      if (announcedAttempts.current.has(attempt.id)) {
        return;
      }
      announcedAttempts.current.add(attempt.id);
      const label = BACKEND_LABEL[provider];
      if (attempt.phase === "succeeded") {
        showToast(
          provider === "opencode"
            ? "OpenCode Go key saved."
            : `${label} is signed in. Finish with a test request when you are ready.`,
          "success",
        );
      } else if (attempt.phase === "failed") {
        showToast(attempt.error?.message ?? `${label} sign-in did not complete.`, "error");
      } else if (attempt.phase === "timed_out") {
        showToast(attempt.error?.message ?? `${label} sign-in timed out.`, "error");
      }
      // Cancellation is a normal outcome; no toast.
    },
    [showToast],
  );

  // Polling sees the terminal phase after the server-side transition.
  useEffect(() => {
    if (!status) {
      return;
    }
    for (const provider of ["codex", "opencode", "claude"] as const) {
      announceAttempt(provider, status[provider]?.attempt ?? null);
    }
  }, [status, announceAttempt]);

  const chooseBackend = async (next: AiBackendId): Promise<void> => {
    if (next === backend) {
      return;
    }
    const previous = backend;
    setBackend(next);
    setSettingsMode("quick");
    setSavingBackend(true);
    const outcome = await saveAiBackendAction(next);
    setSavingBackend(false);
    if (!outcome.ok) {
      setBackend(previous);
      setSettingsMode("quick");
      showToast(outcome.message ?? "The backend could not be saved.", "error");
      return;
    }
    setSavedBackend(outcome.savedValue ?? next);
    showToast(
      `AI features will now run on the ${BACKEND_LABEL[next].toLowerCase()} backend.`,
      "success",
    );
  };

  const saveModeSettings = async (): Promise<void> => {
    setSavingModeSettings(true);
    const outcome = await saveAiChatModeSettingsAction(modeSettings);
    setSavingModeSettings(false);
    if (!outcome.ok) {
      showToast(outcome.message ?? "The chat mode settings could not be saved.", "error");
      return;
    }
    const saved = outcome.savedValue ?? modeSettings;
    setModeSettings(saved);
    setSavedModeSettings(saved);
    showToast("Chat mode defaults saved.", "success");
  };

  const updateModeSetting = (mode: ChatModeId, next: ChatModeSelection): void => {
    setModeSettings((current) => ({
      ...current,
      [backend]: {
        ...current[backend],
        [mode]: next,
      },
    }));
  };

  const refreshModelCatalog = async (): Promise<void> => {
    setRefreshingCatalog(true);
    try {
      await refreshCatalog(backend);
    } finally {
      setRefreshingCatalog(false);
    }
  };

  const dirtyFor = (id: AiBackendId): boolean =>
    JSON.stringify(modeSettings[id]) !== JSON.stringify(savedModeSettings[id]);

  const runMutation = useCallback(
    async (
      key: string,
      path: string,
      method: "POST" | "DELETE",
      body?: unknown,
    ): Promise<AuthOperationPayload | null> => {
      setPendingAction(key);
      try {
        const response = await fetch(path, {
          method,
          headers: body !== undefined ? { "content-type": "application/json" } : undefined,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const payload = (await response.json().catch(() => null)) as AuthOperationPayload | null;
        if (payload?.snapshot) {
          applySnapshot(payload.snapshot);
        }
        return payload;
      } catch {
        return null;
      } finally {
        setPendingAction(null);
      }
    },
    [applySnapshot],
  );

  /**
   * Saves an explicit provider executable. The same resolved command is then
   * used by status, sign-in, model discovery, and AI runs; the fresh snapshot
   * returned by the route updates this card immediately.
   */
  const saveProviderPath = async (
    provider: AuthProviderId,
    path: string,
  ): Promise<{ ok: boolean; message?: string }> => {
    const result = await runMutation(`${provider}-path`, `/api/ai/auth/${provider}/path`, "POST", {
      path,
    });
    if (!result?.ok) {
      return {
        ok: false,
        message: result?.error?.message ?? "The executable path could not be saved.",
      };
    }
    showToast("Executable path saved. Scope now uses it for this provider.", "success");
    return { ok: true };
  };

  const clearProviderPath = async (
    provider: AuthProviderId,
  ): Promise<{ ok: boolean; message?: string }> => {
    const result = await runMutation(`${provider}-path`, `/api/ai/auth/${provider}/path`, "DELETE");
    if (!result?.ok) {
      return {
        ok: false,
        message: result?.error?.message ?? "The executable path could not be cleared.",
      };
    }
    showToast("Executable path cleared. Scope uses automatic discovery again.", "success");
    return { ok: true };
  };

  const startCodexLogin = async (mode: "browser" | "device"): Promise<void> => {
    const result = await runMutation("codex-login", "/api/ai/auth/codex-login", "POST", { mode });
    if (!result) {
      showToast("The codex sign-in could not be started.", "error");
      return;
    }
    if (!result.ok) {
      showToast(result.error?.message ?? "The codex sign-in could not be started.", "error");
      return;
    }
    const attempt = result.snapshot?.codex.attempt;
    announceAttempt("codex", attempt);
    if (mode === "browser" && attempt?.authorizationUrl) {
      // Desktop routes window.open through shell.openExternal; browsers may
      // block the popup, so the card keeps a prominent explicit link too.
      window.open(attempt.authorizationUrl, "_blank", "noopener,noreferrer");
    }
  };

  const cancelCodexLogin = async (attemptId: string | null): Promise<void> => {
    const result = await runMutation("codex-cancel", "/api/ai/auth/codex-login", "DELETE", {
      attemptId,
    });
    if (!result?.ok) {
      showToast(result?.error?.message ?? "The codex sign-in could not be cancelled.", "error");
    }
  };

  const startClaudeLogin = async (): Promise<void> => {
    const result = await runMutation("claude-login", "/api/ai/auth/claude-login", "POST");
    if (!result) {
      showToast("The Claude sign-in could not be started.", "error");
      return;
    }
    if (!result.ok) {
      showToast(result.error?.message ?? "The Claude sign-in could not be started.", "error");
      return;
    }
    announceAttempt("claude", result.snapshot?.claude.attempt);
    const url = result.snapshot?.claude.attempt?.authorizationUrl;
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
    // The URL often arrives a moment after the CLI starts; polling shows it.
  };

  const cancelClaudeLogin = async (attemptId: string | null): Promise<void> => {
    const result = await runMutation("claude-cancel", "/api/ai/auth/claude-login", "DELETE", {
      attemptId,
    });
    if (!result?.ok) {
      showToast(result?.error?.message ?? "The Claude sign-in could not be cancelled.", "error");
    }
  };

  const submitClaudeCode = async (attemptId: string | null): Promise<void> => {
    setClaudeCodeSaving(true);
    setClaudeCodeError(null);
    try {
      const result = await runMutation("claude-code", "/api/ai/auth/claude-login/code", "POST", {
        code: claudeCode,
        attemptId,
      });
      if (!result) {
        setClaudeCodeError("The code could not be submitted.");
        return;
      }
      if (!result.ok) {
        setClaudeCodeError(result.error?.message ?? "The code could not be submitted.");
        return;
      }
      setClaudeCode("");
      setCodeDialogOpen(false);
      announceAttempt("claude", result.snapshot?.claude.attempt);
    } finally {
      setClaudeCodeSaving(false);
    }
  };

  const saveOpenCodeKey = async (): Promise<void> => {
    setKeySaving(true);
    setKeyError(null);
    try {
      const response = await fetch("/api/ai/auth/opencode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const payload = (await response.json().catch(() => null)) as AuthOperationPayload | null;
      if (payload?.snapshot) {
        applySnapshot(payload.snapshot);
      }
      if (!response.ok || !payload?.ok) {
        setKeyError(payload?.error?.message ?? "The key could not be saved.");
        return;
      }
      setApiKey("");
      setShowKey(false);
      setKeyDialogOpen(false);
      showToast("OpenCode Go key saved. Access is checked when you use it.", "success");
    } catch {
      setKeyError("The key could not be saved.");
    } finally {
      setKeySaving(false);
    }
  };

  const confirmLogout = async (): Promise<void> => {
    const provider = logoutProvider;
    if (provider === null) {
      return;
    }
    setLogoutPending(true);
    const result = await runMutation("logout", `/api/ai/auth/${provider}/logout`, "POST");
    setLogoutPending(false);
    if (!result?.ok) {
      showToast(result?.error?.message ?? "The provider could not be signed out.", "error");
      return;
    }
    setLogoutProvider(null);
    showToast(
      provider === "opencode"
        ? "The OpenCode Go key was removed from this machine."
        : `${BACKEND_LABEL[provider]} was signed out on this machine.`,
      "success",
    );
  };

  const closeKeyDialog = (): void => {
    setKeyDialogOpen(false);
    setApiKey("");
    setShowKey(false);
    setKeyError(null);
  };

  const closeCodeDialog = (): void => {
    setCodeDialogOpen(false);
    setClaudeCode("");
    setClaudeCodeError(null);
  };

  const refreshLabel = pendingAction === "refresh" ? "Checking…" : "Check again";

  return (
    <section
      aria-labelledby="ai-backend-heading"
      className="rounded-xl border bg-card p-5 shadow-sm sm:p-6"
    >
      <h2 id="ai-backend-heading" className="text-base font-semibold tracking-tight">
        AI providers
      </h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Scope installs no AI provider of its own. Install the provider you want separately, sign in
        there once, then connect it here — only one is needed, and the library and feeds keep
        working without any. Connecting an account and selecting a provider are separate, and scope
        never sees your tokens or keys.
      </p>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        Your library and cached transcripts stay in the local database on this machine. AI requests
        do not: the content you send to Ask-AI, research, or a report is transmitted to the provider
        you selected and handled under your account and its terms.
      </p>

      {statusFailed ? (
        <div className="mt-4">
          <AlertNote
            tone="danger"
            title="The provider status could not be read."
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => void refresh()}
                disabled={pendingAction === "refresh"}
              >
                {refreshLabel}
              </Button>
            }
          >
            Make sure the scope server is running, then check again.
          </AlertNote>
        </div>
      ) : null}

      <div role="radiogroup" aria-label="AI provider" className="mt-5 flex flex-col gap-2.5">
        {BACKEND_OPTIONS.map((option) => {
          const snapshot = status?.[option.id] ?? null;
          const attempt = snapshot?.attempt ?? null;
          const busyPrefix = `${option.id}-`;
          const providerBusy =
            pendingAction === "logout" || pendingAction?.startsWith(busyPrefix) === true;
          return (
            <ProviderCard
              key={option.id}
              option={option}
              selected={backend === option.id}
              saved={savedBackend === option.id}
              selecting={savingBackend}
              dirty={dirtyFor(option.id)}
              snapshot={snapshot}
              attempt={attempt}
              statusFailed={statusFailed}
              busy={providerBusy}
              loginStarting={pendingAction === `${option.id}-login`}
              loginCancelling={pendingAction === `${option.id}-cancel`}
              signingOut={snapshot?.signingOut === true || pendingAction === "logout"}
              onSelect={() => void chooseBackend(option.id)}
              onRefresh={() => {
                void (async () => {
                  setPendingAction("refresh");
                  await refresh();
                  setPendingAction(null);
                })();
              }}
              onSignIn={() => {
                if (option.id === "codex") {
                  void startCodexLogin("browser");
                } else if (option.id === "claude") {
                  void startClaudeLogin();
                } else {
                  setKeyError(null);
                  setKeyDialogOpen(true);
                }
              }}
              onDeviceCode={() => void startCodexLogin("device")}
              onCancel={() => {
                const id = attempt?.id ?? null;
                if (option.id === "codex") {
                  void cancelCodexLogin(id);
                } else {
                  void cancelClaudeLogin(id);
                }
              }}
              onHaveCode={() => {
                setClaudeCode("");
                setClaudeCodeError(null);
                setCodeDialogOpen(true);
              }}
              onReplaceKey={() => {
                setKeyError(null);
                setKeyDialogOpen(true);
              }}
              onSignOut={() => setLogoutProvider(option.id)}
              platform={platform}
              onSavePath={(path) => saveProviderPath(option.id, path)}
              onClearPath={() => clearProviderPath(option.id)}
            />
          );
        })}
      </div>

      <ChatDefaultsPanel
        backend={backend}
        providerLabel={BACKEND_LABEL[backend]}
        settings={modeSettings[backend]}
        activeMode={settingsMode}
        dirty={dirtyFor(backend)}
        saving={savingModeSettings}
        catalog={providerCatalog}
        refreshingCatalog={refreshingCatalog || refreshingProviders.includes(backend)}
        onRefreshCatalog={() => void refreshModelCatalog()}
        onModeChange={setSettingsMode}
        onModeSettingChange={updateModeSetting}
        onSave={() => void saveModeSettings()}
      />

      <AppDialog
        open={keyDialogOpen}
        onClose={closeKeyDialog}
        busy={keySaving}
        title={status?.opencode.keySaved ? "Replace OpenCode Go key" : "Connect OpenCode Go"}
        description="OpenCode Go uses an API key pasted into opencode's own credential store. Scope guides the copy but never stores the key itself."
      >
        <div className="flex flex-col gap-3">
          <ol className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">1.</span> Open the OpenCode dashboard
              and sign in.
            </li>
            <li>
              <span className="font-medium text-foreground">2.</span> Subscribe to Go and copy the
              API key it shows you.
            </li>
            <li>
              <span className="font-medium text-foreground">3.</span> Paste the key below and save.
            </li>
          </ol>
          <a
            href="https://opencode.ai/auth"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-fit")}
          >
            Open OpenCode dashboard
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>

          <label htmlFor="opencode-api-key" className="mt-1 text-sm font-medium">
            OpenCode Go API key
          </label>
          <div className="flex items-stretch gap-2">
            <input
              id="opencode-api-key"
              type={showKey ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                setKeyError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && apiKey.trim().length > 0 && !keySaving) {
                  event.preventDefault();
                  void saveOpenCodeKey();
                }
              }}
              aria-invalid={keyError ? true : undefined}
              aria-describedby={keyError ? "opencode-key-error" : "opencode-key-hint"}
              className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={showKey ? "Hide key" : "Show key"}
              aria-pressed={showKey}
              onClick={() => setShowKey((current) => !current)}
            >
              {showKey ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </Button>
          </div>
          {keyError ? (
            <p id="opencode-key-error" role="alert" className="text-sm text-destructive">
              {keyError}
            </p>
          ) : (
            <p id="opencode-key-hint" className="text-xs text-muted-foreground">
              The key is stored in opencode&apos;s credential file on this machine and is used to
              authenticate your OpenCode requests. It is never shown again here.
            </p>
          )}
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="outline" onClick={closeKeyDialog} disabled={keySaving}>
              Cancel
            </Button>
            <Button
              onClick={() => void saveOpenCodeKey()}
              disabled={keySaving || apiKey.trim().length === 0}
              aria-busy={keySaving}
            >
              {keySaving ? "Saving…" : status?.opencode.keySaved ? "Replace key" : "Save key"}
            </Button>
          </div>
        </div>
      </AppDialog>

      <AppDialog
        open={codeDialogOpen}
        onClose={closeCodeDialog}
        busy={claudeCodeSaving}
        title="Finish Claude sign-in"
        description="After signing in at claude.com, paste the code the browser shows you. scope hands it straight to the waiting claude process on this machine."
      >
        <div className="flex flex-col gap-3">
          <label htmlFor="claude-login-code" className="text-sm font-medium">
            Sign-in code
          </label>
          <input
            id="claude-login-code"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={claudeCode}
            onChange={(event) => {
              setClaudeCode(event.target.value);
              setClaudeCodeError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && claudeCode.trim().length > 0 && !claudeCodeSaving) {
                event.preventDefault();
                void submitClaudeCode(status?.claude.attempt?.id ?? null);
              }
            }}
            aria-invalid={claudeCodeError ? true : undefined}
            aria-describedby={claudeCodeError ? "claude-code-error" : "claude-code-hint"}
            className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive"
          />
          {claudeCodeError ? (
            <p id="claude-code-error" role="alert" className="text-sm text-destructive">
              {claudeCodeError}
            </p>
          ) : (
            <p id="claude-code-hint" className="text-xs text-muted-foreground">
              The code is never stored — scope writes it to the waiting claude process on this
              machine and it is not returned anywhere.
            </p>
          )}
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="outline" onClick={closeCodeDialog} disabled={claudeCodeSaving}>
              Cancel
            </Button>
            <Button
              onClick={() => void submitClaudeCode(status?.claude.attempt?.id ?? null)}
              disabled={claudeCodeSaving || claudeCode.trim().length === 0}
              aria-busy={claudeCodeSaving}
            >
              {claudeCodeSaving ? "Submitting…" : "Submit code"}
            </Button>
          </div>
        </div>
      </AppDialog>

      <AppDialog
        open={logoutProvider !== null}
        onClose={() => {
          if (!logoutPending) {
            setLogoutProvider(null);
          }
        }}
        busy={logoutPending}
        title={logoutProvider === "opencode" ? "Remove OpenCode Go key?" : "Sign out?"}
        description={
          logoutProvider === "opencode"
            ? "This removes the local OpenCode Go key on this machine."
            : `This signs out the ${logoutProvider === null ? "provider" : BACKEND_LABEL[logoutProvider]} CLI.`
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {logoutProvider === null ? "" : SIGN_OUT_NOTE[logoutProvider]}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setLogoutProvider(null)}
              disabled={logoutPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmLogout()}
              disabled={logoutPending}
              aria-busy={logoutPending}
            >
              {logoutPending
                ? "Signing out…"
                : logoutProvider === "opencode"
                  ? "Remove key"
                  : "Sign out"}
            </Button>
          </div>
        </div>
      </AppDialog>

      {toastElement}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Provider cards
// ---------------------------------------------------------------------------

function ProviderLogo({ backend, className }: { backend: AiBackendId; className?: string }) {
  if (backend === "codex") {
    return <ChatGptLogo className={className} />;
  }
  if (backend === "claude") {
    return <ClaudeLogo className={className} />;
  }
  return <OpenCodeLogo className={className} />;
}

function StatusDot({ tone }: { tone: StatusTone }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full",
        tone === "ok" && "bg-emerald-500",
        tone === "partial" && "bg-amber-500",
        tone === "error" && "bg-destructive",
        tone === "neutral" && "bg-muted-foreground/40",
        tone === "unknown" && "animate-pulse bg-muted-foreground/40",
      )}
    />
  );
}

function formatExpiry(expiresAt: string | null): string | null {
  if (expiresAt === null) {
    return null;
  }
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return null;
  }
  const minutes = Math.max(1, Math.round(remaining / 60_000));
  return `Expires in about ${minutes} min`;
}

function ProviderCard({
  option,
  selected,
  saved,
  selecting,
  dirty,
  snapshot,
  attempt,
  statusFailed,
  busy,
  loginStarting,
  loginCancelling,
  signingOut,
  onSelect,
  onRefresh,
  onSignIn,
  onDeviceCode,
  onCancel,
  onHaveCode,
  onReplaceKey,
  onSignOut,
  platform,
  onSavePath,
  onClearPath,
}: {
  option: (typeof BACKEND_OPTIONS)[number];
  selected: boolean;
  saved: boolean;
  selecting: boolean;
  dirty: boolean;
  snapshot: ProviderAuthSnapshot | null;
  attempt: AuthAttemptSnapshot | null;
  statusFailed: boolean;
  busy: boolean;
  loginStarting: boolean;
  loginCancelling: boolean;
  signingOut: boolean;
  onSelect: () => void;
  onRefresh: () => void;
  onSignIn: () => void;
  onDeviceCode: () => void;
  onCancel: () => void;
  onHaveCode: () => void;
  onReplaceKey: () => void;
  onSignOut: () => void;
  platform: string;
  onSavePath: (path: string) => Promise<{ ok: boolean; message?: string }>;
  onClearPath: () => Promise<{ ok: boolean; message?: string }>;
}) {
  const status = providerStatus(option.id, snapshot, platform);
  const [pathEditorOpen, setPathEditorOpen] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [pathPending, setPathPending] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);
  const attemptActive = attempt !== null && !isTerminalAuthPhase(attempt.phase);
  const attemptFailed =
    attempt !== null && isTerminalAuthPhase(attempt.phase) && attempt.error !== null;
  const showAttemptPanel = attemptActive || attemptFailed;
  const cliMissing = snapshot !== null && (!snapshot.installed || !snapshot.compatible);
  const statusUnavailable = snapshot?.statusError != null;
  const wrongMethod =
    snapshot?.authenticated === true && snapshot.subscription !== true && option.id !== "opencode";
  const showSignIn =
    !cliMissing &&
    !statusUnavailable &&
    !attemptActive &&
    !(snapshot?.authenticated === true) &&
    option.id !== "opencode";
  const showConnect =
    !cliMissing && !statusUnavailable && option.id === "opencode" && snapshot?.keySaved !== true;
  const showReplaceKey =
    option.id === "opencode" && snapshot?.keySaved === true && !cliMissing && !statusUnavailable;
  const showSignOut =
    !cliMissing && !statusUnavailable && snapshot?.authenticated === true && !attemptActive;
  const expiry = attemptActive ? formatExpiry(attempt?.expiresAt ?? null) : null;
  const pathOverrideActive = snapshot?.commandSource === "override";
  // The path control is only worth showing when discovery had trouble or an
  // override is already active, keeping the ordinary card uncluttered.
  const showPathControl = cliMissing || statusFailed || statusUnavailable || pathOverrideActive;

  const togglePathEditor = (): void => {
    setPathError(null);
    setPathDraft(pathOverrideActive ? (snapshot?.resolvedCommand ?? "") : "");
    setPathEditorOpen((open) => !open);
  };

  const savePath = async (): Promise<void> => {
    const value = pathDraft.trim();
    if (value.length === 0) {
      setPathError("Enter the executable path or command name.");
      return;
    }
    setPathPending(true);
    const outcome = await onSavePath(value);
    setPathPending(false);
    if (!outcome.ok) {
      setPathError(outcome.message ?? "The executable path could not be saved.");
      return;
    }
    setPathEditorOpen(false);
  };

  const clearPath = async (): Promise<void> => {
    setPathPending(true);
    const outcome = await onClearPath();
    setPathPending(false);
    if (!outcome.ok) {
      setPathError(outcome.message ?? "The executable path could not be cleared.");
      return;
    }
    setPathDraft("");
    setPathEditorOpen(false);
  };

  return (
    <div
      className={cn(
        "rounded-xl border p-4 transition-colors motion-reduce:transition-none",
        selected
          ? "border-primary/70 bg-accent/30 shadow-sm"
          : "bg-background hover:border-muted-foreground/40 hover:bg-accent/20",
        selecting && "pointer-events-none opacity-70",
      )}
    >
      <label className="flex cursor-pointer items-start gap-3 outline-none has-focus-visible:ring-2 has-focus-visible:ring-ring">
        <input
          type="radio"
          name="ai-backend"
          value={option.id}
          checked={selected}
          onChange={onSelect}
          disabled={selecting}
          aria-describedby={`ai-backend-${option.id}-tagline`}
          className="sr-only"
        />
        <span
          className={cn(
            "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background shadow-sm",
            selected && "border-primary/30",
          )}
        >
          <ProviderLogo backend={option.id} className="size-4.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold">{option.label}</span>
            {dirty && !selected ? (
              <span
                title="Unsaved chat defaults"
                className="size-1.5 shrink-0 rounded-full bg-amber-500"
              >
                <span className="sr-only">Unsaved chat defaults</span>
              </span>
            ) : null}
          </span>
          <span
            id={`ai-backend-${option.id}-tagline`}
            className="mt-0.5 block text-xs text-muted-foreground"
          >
            {option.tagline}
          </span>
        </span>
        <span className="flex shrink-0 items-center pt-0.5">
          {selected && saved ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              <Check aria-hidden="true" className="size-3" strokeWidth={3} />
              Selected
            </span>
          ) : (
            <span aria-hidden="true" className="size-5 rounded-full border-2 border-border" />
          )}
        </span>
      </label>

      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-12">
        <StatusDot tone={statusFailed && snapshot === null ? "error" : status.tone} />
        <span className="min-w-0 text-xs font-medium [overflow-wrap:anywhere]">{status.label}</span>
        {status.detail && status.tone !== "error" ? (
          <span className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {status.detail}
          </span>
        ) : null}
      </div>

      {status.tone === "error" && status.detail ? (
        <div className="mt-2 pl-12">
          <AlertNote
            tone="danger"
            politeness="polite"
            action={
              cliMissing ? (
                <a
                  href={PROVIDER_DOCS[option.id].url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
                >
                  {PROVIDER_DOCS[option.id].label}
                  <ExternalLink aria-hidden="true" className="size-3" />
                </a>
              ) : undefined
            }
          >
            {status.detail}
          </AlertNote>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2 pl-12">
        {cliMissing || statusFailed || statusUnavailable ? (
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={busy} aria-busy={busy}>
            <RefreshCw aria-hidden="true" />
            Check again
          </Button>
        ) : null}

        {showSignIn ? (
          <Button size="sm" variant="outline" onClick={onSignIn} disabled={loginStarting || busy}>
            {loginStarting ? (
              <>
                <Loader2 aria-hidden="true" className="animate-spin" />
                Starting…
              </>
            ) : option.id === "codex" ? (
              "Sign in with ChatGPT"
            ) : (
              "Sign in with Claude"
            )}
          </Button>
        ) : null}

        {wrongMethod ? (
          <Button size="sm" variant="outline" onClick={onSignIn} disabled={loginStarting || busy}>
            {loginStarting ? "Starting…" : "Reconnect"}
          </Button>
        ) : null}

        {showConnect ? (
          <Button size="sm" variant="outline" onClick={onSignIn} disabled={busy}>
            Connect OpenCode Go
          </Button>
        ) : null}

        {showReplaceKey ? (
          <Button size="sm" variant="outline" onClick={onReplaceKey} disabled={busy}>
            Replace key
          </Button>
        ) : null}

        {showSignOut ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onSignOut}
            disabled={busy}
            aria-busy={signingOut}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </Button>
        ) : null}

        {showPathControl ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={togglePathEditor}
            aria-expanded={pathEditorOpen}
            aria-controls={`ai-${option.id}-path-editor`}
          >
            {pathOverrideActive ? "Change executable path" : "Set executable path"}
          </Button>
        ) : null}
      </div>

      {showPathControl && pathEditorOpen ? (
        <div
          id={`ai-${option.id}-path-editor`}
          className="mt-3 ml-12 flex flex-col gap-2 rounded-lg border bg-muted/30 p-3"
        >
          <p className="text-xs text-muted-foreground">
            {pathOverrideActive ? (
              <>
                Scope runs <code className="font-mono">{snapshot?.resolvedCommand}</code> for
                status, sign-in, model discovery, and AI runs.
              </>
            ) : snapshot?.resolvedCommand ? (
              <>
                Scope resolved <code className="font-mono">{snapshot.resolvedCommand}</code>{" "}
                automatically. If discovery misses your install, enter the exact executable path
                below.
              </>
            ) : (
              "Enter the exact path to the provider's executable if automatic discovery cannot find it."
            )}
          </p>
          <div className="flex flex-wrap items-stretch gap-2">
            <label htmlFor={`ai-${option.id}-path`} className="sr-only">
              {option.label} executable path
            </label>
            <input
              id={`ai-${option.id}-path`}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={pathDraft}
              onChange={(event) => {
                setPathDraft(event.target.value);
                setPathError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !pathPending) {
                  event.preventDefault();
                  void savePath();
                }
              }}
              placeholder={
                platform === "win32"
                  ? "C:\\Users\\you\\AppData\\Local\\Programs\\nodejs\\codex.exe"
                  : "/home/you/.local/bin/codex"
              }
              aria-invalid={pathError ? true : undefined}
              aria-describedby={pathError ? `ai-${option.id}-path-error` : undefined}
              className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive"
            />
            <Button
              size="sm"
              onClick={() => void savePath()}
              disabled={pathPending}
              aria-busy={pathPending}
            >
              {pathPending ? "Saving…" : "Save path"}
            </Button>
            {pathOverrideActive ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void clearPath()}
                disabled={pathPending}
              >
                Use automatic
              </Button>
            ) : null}
          </div>
          {pathError ? (
            <p id={`ai-${option.id}-path-error`} role="alert" className="text-xs text-destructive">
              {pathError}
            </p>
          ) : null}
        </div>
      ) : null}

      {showAttemptPanel ? (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "mt-3 ml-12 flex flex-col gap-2 rounded-lg border bg-muted/30 p-3",
            attemptFailed && "border-destructive/40 bg-destructive/5",
          )}
        >
          {attempt.phase === "starting" ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              Starting sign-in…
            </p>
          ) : null}

          {attempt.phase === "waiting_for_browser" && attempt.verificationUrl === null ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium">
                {option.id === "claude"
                  ? "Finish signing in in your browser."
                  : "Finish signing in in your browser."}
              </p>
              {attempt.authorizationUrl ? (
                <a
                  href={attempt.authorizationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex w-fit items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
                >
                  Open browser again
                  <ExternalLink aria-hidden="true" className="size-3" />
                </a>
              ) : (
                <p className="text-xs text-muted-foreground">Waiting for the login page…</p>
              )}
              {expiry ? <p className="text-[11px] text-muted-foreground">{expiry}</p> : null}
              <div className="mt-1 flex flex-wrap gap-2">
                {option.id === "claude" ? (
                  <Button size="sm" variant="outline" onClick={onHaveCode} disabled={busy}>
                    Have a sign-in code?
                  </Button>
                ) : null}
                {option.id === "codex" && snapshot?.deviceCodeAvailable ? (
                  <Button size="sm" variant="outline" onClick={onDeviceCode} disabled={busy}>
                    Try device code instead
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onCancel}
                  disabled={loginCancelling || busy}
                  aria-busy={loginCancelling}
                >
                  {loginCancelling ? "Cancelling…" : "Cancel"}
                </Button>
              </div>
            </div>
          ) : null}

          {attempt.phase === "waiting_for_browser" && attempt.verificationUrl !== null ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium">
                Enter this code at the verification page to finish signing in.
              </p>
              <p className="font-mono text-sm font-semibold tracking-wider">{attempt.userCode}</p>
              <a
                href={attempt.verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
              >
                Open verification page
                <ExternalLink aria-hidden="true" className="size-3" />
              </a>
              {expiry ? <p className="text-[11px] text-muted-foreground">{expiry}</p> : null}
              <div className="mt-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onCancel}
                  disabled={loginCancelling || busy}
                  aria-busy={loginCancelling}
                >
                  {loginCancelling ? "Cancelling…" : "Cancel"}
                </Button>
              </div>
            </div>
          ) : null}

          {attempt.phase === "verifying" ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              Verifying the sign-in…
            </p>
          ) : null}

          {!attemptFailed && attempt.error ? (
            <p role="alert" className="text-xs text-destructive [overflow-wrap:anywhere]">
              {attempt.error.message}
            </p>
          ) : null}

          {attemptFailed ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-destructive [overflow-wrap:anywhere]">
                {attempt?.error?.message}
              </p>
              {!cliMissing && option.id !== "opencode" ? (
                <div>
                  <Button size="sm" variant="outline" onClick={onSignIn} disabled={busy}>
                    Try again
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat mode defaults
// ---------------------------------------------------------------------------

function ChatDefaultsPanel({
  backend,
  providerLabel,
  settings,
  activeMode,
  dirty,
  saving,
  catalog,
  refreshingCatalog,
  onRefreshCatalog,
  onModeChange,
  onModeSettingChange,
  onSave,
}: {
  backend: AiBackendId;
  providerLabel: string;
  settings: AiChatModeSettings[AiBackendId];
  activeMode: ChatModeId;
  dirty: boolean;
  saving: boolean;
  catalog: ProviderCatalogSnapshot;
  refreshingCatalog: boolean;
  onRefreshCatalog: () => void;
  onModeChange: (mode: ChatModeId) => void;
  onModeSettingChange: (mode: ChatModeId, next: ChatModeSelection) => void;
  onSave: () => void;
}) {
  const lastUpdated = catalog.lastSuccessAt
    ? new Date(catalog.lastSuccessAt).toLocaleString()
    : null;
  return (
    <div className="mt-6 rounded-xl border bg-background">
      {/* No overflow-hidden on the panel: it would clip the model picker
          popover when it opens past the panel edge. The header rounds its
          own top corners to match the panel's border radius instead. */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-t-[calc(var(--radius-xl)-1px)] border-b bg-card/60 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-background shadow-sm">
            <ProviderLogo backend={backend} className="size-3.5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{providerLabel} chat defaults</h3>
            <p className="text-xs text-muted-foreground">
              Model and reasoning depth for each chat mode.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dirty ? <Badge variant="outline">Unsaved changes</Badge> : null}
          {catalog.fallback ? <Badge variant="outline">Bundled list</Badge> : null}
          {/* The status text swaps to a shorter "Updating models…" while a
              refresh runs. Both variants are stacked in one grid cell with the
              inactive one invisible, so the header keeps the same width and
              height. Otherwise every automatic refresh triggered by opening
              the model picker re-wrapped the header and moved the open
              popover down a line. */}
          <span className="grid items-center text-xs text-muted-foreground">
            <span
              className={cn(
                "col-start-1 row-start-1 flex items-center gap-1.5 whitespace-nowrap",
                refreshingCatalog && "invisible",
              )}
            >
              {catalog.connected === false ? (
                "Connect your provider to load models"
              ) : lastUpdated ? (
                <>Models updated {lastUpdated}</>
              ) : catalog.error ? (
                "Model list unavailable"
              ) : (
                "Models not checked yet"
              )}
            </span>
            <span
              aria-hidden="true"
              className={cn(
                "col-start-1 row-start-1 flex items-center gap-1.5 whitespace-nowrap",
                !refreshingCatalog && "invisible",
              )}
            >
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              Updating models…
            </span>
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={onRefreshCatalog}
            disabled={refreshingCatalog}
            aria-busy={refreshingCatalog}
          >
            <RefreshCw aria-hidden="true" className={cn(refreshingCatalog && "animate-spin")} />
            Refresh models
          </Button>
        </div>
      </div>

      {catalog.error ? (
        <div className="border-b px-4 py-3 sm:px-5">
          <AlertNote
            tone="warning"
            title="The live model list could not be refreshed."
            politeness="polite"
          >
            {catalog.models.length > 0
              ? "Showing the last known list; your saved choices are unchanged."
              : "Showing the bundled fallback list; your saved choices are unchanged."}
          </AlertNote>
        </div>
      ) : null}

      <div className="p-4 sm:p-5">
        <div
          role="tablist"
          aria-label={`${backend} chat modes`}
          className="grid grid-cols-3 gap-1 rounded-lg bg-muted/60 p-1"
        >
          {CHAT_MODE_OPTIONS.map((option) => {
            const selected = activeMode === option.id;
            const Icon = MODE_ICONS[option.id];
            const selection = settings[option.id];
            const model = findCatalogModel(catalog.models, selection.model);
            return (
              <button
                key={option.id}
                type="button"
                role="tab"
                id={`${backend}-${option.id}-mode-tab`}
                aria-selected={selected}
                aria-controls={`${backend}-chat-mode-settings`}
                onClick={() => onModeChange(option.id)}
                className={cn(
                  "min-w-0 rounded-md px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  selected
                    ? "bg-background shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex items-center justify-center gap-1.5 text-xs font-medium",
                    selected && "text-foreground",
                  )}
                >
                  <Icon aria-hidden="true" className="size-3.5" />
                  {option.label}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                  {model?.label ?? selection.model} ·{" "}
                  {effortLabelFor(model, selection.reasoningEffort)}
                </span>
              </button>
            );
          })}
        </div>

        <ChatModeModelEditor
          backend={backend}
          mode={activeMode}
          selection={settings[activeMode]}
          catalog={catalog}
          onChange={(next) => onModeSettingChange(activeMode, next)}
        />

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={onSave} disabled={!dirty || saving} aria-busy={saving}>
            {saving ? "Saving…" : "Save chat defaults"}
          </Button>
          <p className="text-xs text-muted-foreground">
            {dirty ? "Changes apply to the next chat turn." : "Saved for this provider."}
          </p>
        </div>
      </div>
    </div>
  );
}

function ChatModeModelEditor({
  backend,
  mode,
  selection,
  catalog,
  onChange,
}: {
  backend: AiBackendId;
  mode: ChatModeId;
  selection: ChatModeSelection;
  catalog: ProviderCatalogSnapshot;
  onChange: (next: ChatModeSelection) => void;
}) {
  const modelOptions: ModelPickerOption[] = catalog.models.map((model) => ({
    id: model.id,
    label: model.label,
    description: model.description,
    isNew: isNewCatalogModel(model, catalog.baselineAt),
    usable: isCatalogModelUsable(model),
    note: isCatalogModelUsable(model)
      ? undefined
      : `Not available with the installed ${backend === "opencode" ? "opencode" : backend} build yet.`,
  }));
  const selectedModel = findCatalogModel(catalog.models, selection.model);
  const reasoningOptions = selectedModel?.reasoningOptions ?? [];
  const usable = selectedModel !== null && isCatalogModelUsable(selectedModel);
  const effortsKnown = selectedModel?.effortsKnown === true;
  const savedEffortObsolete =
    usable &&
    effortsKnown &&
    selection.reasoningEffort !== null &&
    !reasoningOptions.some((option) => option.id === selection.reasoningEffort);

  const changeModel = (nextId: string): void => {
    const nextModel = findCatalogModel(catalog.models, nextId);
    if (!nextModel || !isCatalogModelUsable(nextModel)) {
      return;
    }
    const nextEffort =
      nextModel.effortsKnown && nextModel.reasoningOptions.length > 0
        ? selection.reasoningEffort !== null &&
          nextModel.reasoningOptions.some((option) => option.id === selection.reasoningEffort)
          ? selection.reasoningEffort
          : (nextModel.defaultReasoningEffort ?? null)
        : null;
    onChange({ model: nextModel.id, reasoningEffort: nextEffort });
  };

  const changeEffort = (nextEffort: string | null): void => {
    if (!selectedModel) {
      return;
    }
    if (nextEffort !== null && !reasoningOptions.some((option) => option.id === nextEffort)) {
      return;
    }
    onChange({ model: selectedModel.id, reasoningEffort: nextEffort });
  };

  const modeLabel = CHAT_MODE_OPTIONS.find((option) => option.id === mode)?.label ?? mode;
  const providerName =
    backend === "codex" ? "codex" : backend === "opencode" ? "opencode" : "claude";

  return (
    <div
      id={`${backend}-chat-mode-settings`}
      role="tabpanel"
      aria-labelledby={`${backend}-${mode}-mode-tab`}
      className="pt-4"
    >
      {catalog.connected === false ? (
        <p className="mb-4 text-sm text-muted-foreground">
          Connect this provider to load its models. Your saved choices are unchanged.
        </p>
      ) : catalog.state === "bundled" && !catalog.fallback && catalog.connected === undefined ? (
        <p className="mb-4 text-sm text-muted-foreground">Checking the provider connection…</p>
      ) : selectedModel === null ? (
        <div className="mb-4">
          <AlertNote
            tone="warning"
            title="Saved model unavailable."
            politeness="polite"
            action={
              <span className="text-xs text-muted-foreground">Pick a replacement below.</span>
            }
          >
            “{selection.model}” is not in the current {providerName} model list. Your other settings
            are unchanged; this choice stays until you replace it.
          </AlertNote>
        </div>
      ) : !usable ? (
        <div className="mb-4">
          <AlertNote tone="warning" title="Model not available yet." politeness="polite">
            {selectedModel.label} is listed by the provider but the installed {providerName} build
            cannot run it yet. Choose another model.
          </AlertNote>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Model</span>
          <ModelPicker
            provider={backend}
            models={modelOptions}
            value={selection.model}
            onChange={changeModel}
            label={`Model for ${modeLabel}`}
          />
          <p className="text-xs text-muted-foreground">
            {selectedModel?.description ?? "Choose a model from the current list."}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Reasoning effort</span>
          {usable && effortsKnown && reasoningOptions.length > 0 ? (
            <>
              <div
                role="radiogroup"
                aria-label={`Reasoning effort for ${modeLabel}`}
                className="flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1"
              >
                <EffortButton
                  active={selection.reasoningEffort === null}
                  label="Provider default"
                  description="Runs without an explicit reasoning variant."
                  onClick={() => changeEffort(null)}
                />
                {reasoningOptions.map((option) => (
                  <EffortButton
                    key={option.id}
                    active={option.id === selection.reasoningEffort}
                    label={option.label}
                    description={option.description}
                    onClick={() => changeEffort(option.id)}
                  />
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {savedEffortObsolete
                  ? `${selectedModel.label} no longer offers ${selection.reasoningEffort}; choose a new depth.`
                  : effortDescriptionFor(reasoningOptions, selection.reasoningEffort)}
              </p>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={!usable || selection.reasoningEffort === null}
                onClick={() => changeEffort(null)}
              >
                {savedEffortObsolete ? "Use provider default" : "Provider default"}
              </Button>
              <p className="text-xs text-muted-foreground">
                {!usable
                  ? "No reasoning options are available for this model."
                  : !effortsKnown
                    ? "Capabilities could not be determined; scope will use the provider's default."
                    : "This model does not expose selectable reasoning variants."}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EffortButton({
  active,
  label,
  description,
  onClick,
}: {
  active: boolean;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      title={description}
      onClick={onClick}
      className={cn(
        "rounded-md px-2.5 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function effortLabelFor(model: CatalogModel | null, effort: string | null): string {
  if (effort === null) {
    return "Provider default";
  }
  if (model && model.effortsKnown) {
    return model.reasoningOptions.find((option) => option.id === effort)?.label ?? effort;
  }
  return effort;
}

function effortDescriptionFor(
  options: readonly CatalogReasoningOption[],
  effort: string | null,
): string {
  if (effort === null) {
    return "Runs with the provider's default reasoning.";
  }
  return options.find((option) => option.id === effort)?.description ?? "";
}
