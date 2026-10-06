# AI features

scope's AI layer (stages 1–7) turns the transcripts you already cached
locally into two things: grounded **chat** and self-contained **HTML
reports**. This page documents how it works, where data lives, what it costs
you, and how failures behave. The short version for the impatient is in the
README's [AI features](../README.md#ai-features) section.

## Requirements

- A cached transcript for every video you want to include (get one from a
  video page or the AI Research page first).
- **One AI backend**, chosen in Settings → AI providers (stage 9; Claude
  stage 10; provider-auth stage). All three ride your own subscriptions
  through their own CLIs; scope never stores provider keys and strips ambient
  `OPENAI_API_KEY`/`CODEX_API_KEY`/`OPENCODE_API_KEY`/`ANTHROPIC_API_KEY`-class
  variables from every spawned process. Connecting an account and selecting
  the provider are separate actions: every card has its own sign-in/connect
  controls and a **Sign out** button, while the radio only chooses which CLI
  runs AI work.
  - **Codex (default)** — the [`codex` CLI](https://github.com/openai/codex)
    on your `PATH`, signed in with your ChatGPT subscription. Settings reads
    the account with the CLI's official app-server protocol
    (`account/read`) and drives the official browser and device-code logins,
    so it can tell a ChatGPT account from an API key instead of scraping
    console output. `SCOPE_CODEX_PATH` overrides the binary lookup for both
    sign-in and inference. Sign-out uses `account/logout`; credentials still
    live in `~/.codex/auth.json` (or the OS credential store) and are shared
    with other Codex clients. CLIs without the account protocol fall back to
    the legacy `codex login` flow with the same deadline, URL validation, and
    cancellation rules.
  - **OpenCode Go** — the [`opencode` CLI](https://opencode.ai) installed the
    way you like (mise, npm, …), connected with your OpenCode Go key. Paste
    the key in Settings and scope writes it to opencode's own credential
    store (`~/.local/share/opencode/auth.json`) exactly as `opencode auth
login` would, preserving every other provider entry. Chat uses the
    OpenCode model and variant configured for the active chat mode; reports
    continue to use OpenCode's configured default.
  - **Claude Code** — the [`claude` CLI](https://claude.com/claude-code)
    (v2.1.169 or later), signed in with your Claude subscription. Settings
    starts `claude auth login --claudeai`, tracks the attempt with a finite
    deadline, and offers the browser flow plus a code-paste fallback. Chat
    uses the Claude model and effort configured for the active chat mode;
    reports use the profile's Claude model. See
    [Claude Code specifics](#claude-code-specifics) for path resolution,
    permission guarantees, and troubleshooting.

Every AI feature (chat, research chat, reports) runs on the selected backend;
new turns and queued jobs pick up a backend switch immediately. Threads
record which backend ran them — a session id can only be resumed by its own
provider, so resuming a thread after a backend switch starts a fresh session
and re-seeds the conversation.

## What you can do

| Where                            | What                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Sidebar → "AI Chat"              | The full-screen chat workspace: every conversation from every source collection in one history, new chats, and deletions.       |
| Video page → "Ask AI"            | Chat grounded in that one video's transcript.                                                                                   |
| Channel page → "Select videos"   | Tick any videos, then chat about the selection.                                                                                 |
| AI Research page                 | Pick creators, tick videos across them, chat.                                                                                   |
| Ask AI panel → "Generate report" | Pick a depth profile and visual style, then queue an HTML report over the current selection (or the open conversation's scope). |
| Reports page                     | Watch queued/running jobs, open finished reports, read failure reasons.                                                         |

Conversations are persisted in the local SQLite database and can be reopened
from the panel's history; continuing a thread resumes the same provider session
on the server when that provider is still active.

### The full-screen chat workspace

The collapsed "Ask AI" panel is scoped to whatever selection opened it, and
its history view filters threads to that selection — handy for quick
follow-ups, but it can never show a chat that started from a different
selection. The workspace under **AI Chat** in the sidebar is the complete
picture:

- A history sidebar listing **every saved conversation** from every source
  collection, bucketed by recency (Today / Yesterday / Previous 7 days /
  Previous 30 days / Older), with a title search.
- One click reopens any conversation and continues it — the thread's own
  provider session and scope are used, no matter what is selected elsewhere.
- Fresh chats pick their sources from the whole library in a dialog
  (grouped per creator, capped like every selection at 25 videos, rows
  without a cached transcript marked unselectable).
- Conversations can be deleted (the cached transcripts are untouched), and
  deletion waits out any in-flight turn on that thread before removing rows.
- The open conversation lives in the URL (`/chat?thread=…`), so a refresh or
  a bookmark reopens it; a pending fresh scope is kept as `?videos=…`.

The two surfaces share one engine, and the panel's header carries the bridge
between them: **"Open full view"** navigates to the workspace carrying the
open thread — or the fresh scope when nothing was sent yet. It is disabled
while an answer streams, because navigating away would abort the running
turn.

## X posts and mixed sources

Cached X posts are analysis sources alongside video transcripts. A selection
can mix both kinds (for example 3 posts + 2 videos); the materializer writes
each post to `tweets/<id>.txt` and each video's transcript to
`transcripts/<id>.txt` in the same job directory, and the manifest records
every requested source with its readiness and exclusions. Answers cite posts
by canonical status URL with the author and publication date, and quote
surfaces say "text only" when media was not analyzed.

Selections are stored as typed references (`{kind, id}`) in threads and
reports; rows created before mixed sources existed are read back as video
references, so old conversations and reports keep opening unchanged. The
shared 25-source cap applies across both kinds.

Connecting X is separate from AI-provider auth and lives in
Settings → X (Twitter). Reads are explicit: fetching a bounded recent
window, hydrating selected posts, and loading older pages are all manual
actions. When no X read worker is installed, the connection card reports
unavailable and cached posts stay readable. See
[docs/x-auth-feasibility.md](./x-auth-feasibility.md) for the current status
and [docs/x-worker-protocol.md](./x-worker-protocol.md) for the worker
contract.

## Intelligence modes

The switcher above the composer still only picks **Quick**, **Balanced**, or
**Deep**. Under Settings → **AI backend**, each provider has its own model and
reasoning-effort choice for every mode. The effort dropdown is derived from
the selected model's provider catalog, so unsupported combinations cannot be
saved:

| Provider     | Quick                  | Balanced                     | Deep                      |
| ------------ | ---------------------- | ---------------------------- | ------------------------- |
| **Codex**    | `gpt-5.6-luna` @ `low` | `gpt-5.6-terra` @ `medium`   | `gpt-5.6-sol` @ `xhigh`   |
| **OpenCode** | `gpt-5.6-luna` @ `low` | `deepseek-v4-flash` @ `high` | `deepseek-v4-pro` @ `max` |
| **Claude**   | Haiku (no effort)      | Sonnet @ `medium`            | Opus @ `xhigh`            |

These are the first-run defaults and can be changed independently. Changing a
model keeps the current effort when that model supports it; otherwise the UI
selects that model's default effort. Quick, Balanced, and Deep retain their
5-, 10-, and 15-minute turn ceilings and working directives regardless of the
selected provider model.

The picker's contents come from each provider's live catalog, refreshed
automatically in the background. Scope asks Codex's app-server for its model
list, reconciles OpenCode Go's published catalog against what the installed
opencode build can actually resolve, and asks the Claude Agent SDK what the
signed-in claude CLI reports. Discovery is read-only — it never submits a
prompt and never spends plan quota. Models first seen after the initial
catalog carry a **New** badge for seven days; a whole first catalog is never
badged.

If a provider is offline or its CLI cannot answer, Scope keeps the last
successful list (or the catalog bundled with the app on first run) and shows
that the refresh failed rather than hiding your choices. A model that is
listed by a provider but not yet supported by the installed runtime appears
with a note and cannot be selected. If a saved model disappears from a
provider's list, the selection stays visible with a replacement hint and other
settings keep saving until you deliberately replace it — existing choices are
never changed just because new models arrived. Settings shows when the list
was last updated and offers a manual **Refresh models** action.

Scope checks for account, credential, and CLI changes when opening or refreshing
the picker, invalidates the affected cache, and discards late results from an
old connection. Disconnected providers show a connection hint. Each connected
provider refreshes independently; automatic retries respect backoff. A successful
empty catalog stays empty even if a later refresh fails. Catalog membership does
not establish subscription entitlement or remaining quota.

**Provider default** omits the explicit effort override. If a provider removes
the saved effort option, **Use provider default** clears it without changing the
selected model.

Models without selectable variants show **Provider default**, and when a
provider supplies no capability metadata Scope omits an explicit effort and
lets the model use its own default rather than inventing one. The effort
choices are derived from the selected model's provider catalog, so unsupported
combinations cannot be saved. The Claude picker keeps the familiar Haiku,
Sonnet, and Opus aliases (they track whatever version your subscription
serves, and first-run defaults are preserved) while also accepting newly
returned families and pinned model ids.

All three share the same grounding rules (only the transcripts are source
material, every claim cites its transcript file, no invented metrics). What
changes is the working directive — Deep reads everything and cross-references,
Balanced covers the main findings concisely, Quick stays conversational and
suggests Deep for questions that need more.

The selected chat mode is remembered with each thread: reopening a thread moves
the switcher to that thread's mode, and threads from before this feature
existed read as Deep (which is what they ran). Switching modes
mid-conversation takes effect from the next message — the server tells the
provider session about the switch and records it in the thread's history, and
the new provider/model picks the conversation up where it left off.

Reports are not bound to the chat's mode switcher; they pick their own depth
profile (below). Codex reports use that profile's model and effort, Claude
reports use the profile's Claude model ladder (Brief → Haiku, Balanced →
Sonnet, Deep → Opus), and OpenCode reports continue to use OpenCode's
configured default model.

## Report profiles and styles

The Generate-report dialog picks two things, and both are remembered across
visits:

**Depth profile** — how hard the report thinks and how much it covers. Like
on Codex, each profile pairs a different model and reasoning effort with its
own writing brief and required sections:

| Profile      | Model           | Reasoning | Ceiling    | What it writes                                                                                                                 |
| ------------ | --------------- | --------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Brief**    | `gpt-5.6-luna`  | `low`     | 8 minutes  | A relaxed overview to stay current: the short version, what's going on, a few quotes, what to watch next.                      |
| **Balanced** | `gpt-5.6-terra` | `medium`  | 15 minutes | The everyday analyst report: executive overview, key themes, notable quotes, actionable takeaways.                             |
| **Deep**     | `gpt-5.6-sol`   | `xhigh`   | 25 minutes | The complete technical brief: everything above plus a technical-detail section, points of tension, and source-by-source notes. |

**Visual style** — how the document looks. Each style ships a complete,
hand-authored stylesheet that the report must include verbatim, so a style is
a real, tested design and every report in it looks the same (the model writes
the content, not the CSS):

- **Editorial** (default) — a warm print-magazine feature: serif type on warm
  paper, small uppercase section labels, hairline rules, terracotta accent.
- **Terminal** — a dark technical briefing: near-black slate, monospaced
  numbered section labels, dotted separators, green accent.
- **Swiss** — a clean minimal memo: white page, grotesque sans, huge tight
  headline, numbered sections on thin rules, vermilion accent.

Reports requested before profiles existed read as Balanced/Editorial, which is
what they ran. The chosen profile and style are stored with the report and
shown on the Reports page.

## How it works

1. **Scope resolution** — your selection is validated against the cached
   feed. Videos without a cached transcript are skipped (the UI names them
   before the chat opens); unknown ids are reported the same way.
2. **Materialization** — one plain-text file per selected transcript is
   written to a fresh job directory (`data/ai-jobs/<jobId>/transcripts/`),
   each with a metadata header (title, creator, URL, date, language, caption
   source), plus a `manifest.json` recording exactly what was written.
3. **AI run** — the server spawns the selected provider CLI with the job
   directory as its working directory. Chat turns use the active provider's
   model and effort/variant from the mode matrix; reports use the requested
   depth profile on Codex, the profile's Claude ladder on Claude, and
   OpenCode's configured default on OpenCode. Your global provider
   configuration is never modified.
   Chat runs in a **read-only sandbox**; report jobs get
   `workspace-write` scoped to their own job directory — the only place the
   deliverable can land. On Claude, the equivalent guarantees come from the
   CLI's own tool allowlist and `dontAsk` permission mode (below).
4. **Streaming** — chat answers stream to the panel as server-sent events
   with heartbeats, so silent reasoning pauses don't look like a hang.
   Stopping a turn kills the provider CLI's child process immediately.

Transcripts are treated as **untrusted input**: the prompts instruct the
model never to follow instructions found inside them, and finished reports
are served with a strict Content-Security-Policy (inline styles only, no
scripts, no external requests) and open fine straight from disk.

## Guardrails

- **25 videos per analysis** — enforced while selecting (the 26th tick is
  refused with a note) and re-checked server-side by the chat and report
  routes.
- **Byte budget on materialized transcripts** — one job writes at most
  ~4 MB of transcript text (override with
  `SCOPE_AI_MAX_MATERIALIZED_BYTES`). The file that crosses the budget
  is cut short with an explicit marker, later files are skipped, the
  manifest records it, and both the chat panel and the report prompt say
  what was truncated so answers stay honest about partial evidence.
- **One report at a time** — report jobs run through a strict sequential
  queue to protect your plan's rate limits; queued jobs re-run after a
  restart.
- **Per-thread chat serialization** — two windows chatting in the same
  thread can never interleave turns around one provider session.
- **Restart-safe** — on boot, a report stuck in `running` is marked failed
  with a readable message instead of staying "running" forever.

## What it costs

Every AI action consumes the selected provider's own plan or credentials —
there is no separate billing through scope. Rough magnitudes: one chat turn over a single
~35 KB transcript used ≈ 40k input tokens (over half of them
cache-discounted) plus ≈ 0.5k output; a two-video chat used ≈ 125k input;
a one-video report used ≈ 360k input and ≈ 12k output at the Deep profile.
Cached transcripts
materialize once per conversation and are then reused by the session, so
follow-up turns are much cheaper than the first. The mode matters mostly
for **reasoning tokens and wall time**: Quick and Balanced spend far less
of both than Deep, which is why casual questions are worth asking there.

## Provider sign-in and sign-out

Settings → **AI providers** is the one place to connect or disconnect each
CLI. Each card separates _selection_ (the radio, which only chooses the
backend for AI work) from _account actions_ (sign in, reconnect, replace key,
sign out), so clicking a login control can never change the selected backend
or discard model edits.

- **Signing in is provider-owned.** Codex uses its app-server account
  protocol, Claude runs its native `claude auth login --claudeai`, and
  OpenCode Go takes a pasted API key. Scope builds no OAuth client, collects
  no passwords, and never copies tokens into its own database.
- **Attempts are tracked, bounded, and cancellable.** A started sign-in gets
  an opaque attempt id, a deadline (10 minutes for Codex and Claude), and
  state that includes any validated authorization URL. Cancel is a normal
  outcome, not a failure. Late output from a replaced attempt can never touch
  a newer one, and every attempt's URL/code references are cleared when it
  reaches a terminal state.
- **Codex** distinguishes a ChatGPT subscription from an API-key account:
  only a ChatGPT account gets the subscription label, and an API-key login
  shows **Reconnect** plus **Sign out** instead. If the browser callback has
  trouble, **Try device code instead** cancels the browser attempt and shows
  the verification URL plus one-time code. Scope never asks you to paste a
  Codex browser callback URL.
- **Claude** shows the official login URL while it waits and puts the
  code-paste fallback next to it. Codes are bound to the attempt id, written
  to the waiting process on stdin, never stored or returned. A code the CLI
  rejects shows an inline retry message without ending the login.
- **OpenCode Go** guides you through opencode.ai/auth in one dialog: open the
  dashboard, subscribe, copy the key, paste it (masked, with a show/hide
  control), then **Save key** or **Replace key**. Credential handling is
  conservative: a missing `auth.json` is an empty store, malformed JSON or
  permission failures are reported and left untouched, saves preserve every
  other provider entry (Zen included), writes go through an exclusively
  created owner-only temp file with an external-change re-check before the
  atomic replace, and removal deletes only the `opencode-go` entry
  (idempotent when absent). A key that is structurally valid is "saved" —
  scope does not claim the subscription works until real usage says so; a
  malformed store shows a persistent error with **Check again**.
- **Sign-out is shared-machine CLI sign-out**, not subscription
  cancellation. The confirmation dialog says so: your subscription and saved
  chats stay unchanged. For OpenCode Go it removes only the local key, not
  anything in the dashboard. Sign-out stops any pending login first so a late
  callback cannot restore the credential, and it is refused while that
  provider has a chat turn or report in flight (the message asks you to wait
  or stop the run). Sign-out never changes the selected backend, threads,
  reports, or mode defaults.
- **Safety on the wire.** `/api/ai/auth` responses are always
  `Cache-Control: no-store`, mutations are same-origin checked in ordinary
  web mode (and desktop-token gated through `proxy.ts`), request bodies are
  bounded, and no route logs credentials, codes, authorization query strings,
  raw CLI output, or request bodies. Provider login URLs are validated as
  https on the provider's official hosts before the UI will link to them, and
  desktop opens them in the system browser rather than embedding a webview.

## Claude Code specifics

- **Supported version:** Claude Code v2.1.169 or later. Settings flags an
  older CLI as "too old" instead of starting runs that would fail.
  Scope detects the version with `claude --version` and never installs or
  updates Claude Code itself.
- **Where the binary comes from:** `SCOPE_CLAUDE_PATH` if set; otherwise a
  mise-managed install (resolved with `mise where`, which never triggers an
  install); otherwise `claude` from `PATH`. The desktop app's PATH additions
  (`~/.local/bin`, mise shims, Nix profile) are checked as usual.
- **Billing source:** your Claude subscription. Scope removes
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`, cloud-provider switches, model overrides, and
  profile/federation variables from every `claude` child, so an ambient key
  can never silently take over. `CLAUDE_CONFIG_DIR` and your home directory
  are preserved so the native login resolves. Settings shows
  "Connected — not a subscription login" (partial, no sign-in button) when
  `claude auth status` reports a Console key or other non-subscription
  credential.
- **Login:** Settings → AI providers → Claude Code → **Sign in with Claude**
  runs `claude auth login --claudeai`; finish in your browser. If the
  browser shows a code instead of completing on its own, press **Have a
  sign-in code?** and paste it — scope hands it to the waiting CLI process on
  stdin, bound to the attempt id, and never stores or returns it. While a
  login waits, **Cancel** stops it (SIGTERM, then SIGKILL after a grace
  period), and an unaccepted code shows a retry message without ending the
  login. A sign-in that waits longer than 10 minutes is cancelled
  automatically. **Sign out** runs `claude auth logout` with the same
  resolved binary and stripped environment, then re-probes status.
- **Model defaults:** Quick → Haiku (no effort control), Balanced → Sonnet
  `medium`, Deep → Opus `xhigh`. All are configurable per mode; the aliases
  resolve to the current model of each family on your account.
- **Permission guarantees:** scope runs Claude Code in print mode with
  `--safe-mode`, an empty settings-source list, and a strict empty MCP
  config, so your hooks, plugins, custom agents/skills, memory files, and
  MCP servers never load into a scope run. Chat enables only `Read`, `Grep`,
  and `Glob`; reports add `Write` with a single allow rule for paths inside
  the job directory (`Edit(./**)`) and deny rules protecting
  `transcripts/**` and `manifest.json`. `--permission-mode dontAsk` denies
  everything that would otherwise prompt, so nothing outside the job
  directory can be read or written. Scope never uses
  `--dangerously-skip-permissions` or `bypassPermissions`. These are the
  CLI's checked permission rules — a prompt instruction is not enforcement.
- **Limits:** Claude Code's own file rules cover its built-in file tools and
  recognized file commands; they are not an OS sandbox. Scope additionally
  narrows the run with `--tools`, but if your threat model needs OS-level
  isolation, run scope in a container or VM.
- **Troubleshooting:** "claude CLI not found" → install Claude Code and
  reload, or set `SCOPE_CLAUDE_PATH`. "claude CLI is too old" → update
  Claude Code. "Not signed in" → use the sign-in button, or run
  `claude auth login` in a terminal and reload. Ambiguous failures are
  classified into the same readable messages as the other backends; raw CLI
  diagnostics stay in the server log.

## Tests and your subscription

Automated tests are **fully offline**: the provider boundary is mocked at the
process-spawner seam (and, for Claude, an offline fixture can spawn a fake
executable), and no default test touches the real CLI or a subscription. The
only code path that touches a real subscription is the opt-in live smoke
test:

```bash
SCOPE_AI_LIVE_TEST=1 npx vitest run tests/unit/ai-reports-live.test.ts
```

Run it only when you want to spend a little plan quota on verification.

## Failure behavior

All failures surface as readable messages — in the chat panel as an inline
alert (with a "Try again" action) or on the Reports page as the job's error
— never as stack traces. Diagnostics land in the server log only.

| Situation                  | What you see                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| codex not logged in        | "Codex is not authenticated on this machine. Sign in from Settings → AI providers and try again."      |
| codex binary missing       | "The codex CLI is not available on this machine. Install it and try again."                            |
| opencode not connected     | "OpenCode is not authenticated on this machine. Connect it in Settings → AI providers and try again."  |
| opencode binary missing    | "The opencode CLI is not available on this machine. Install it and try again."                         |
| opencode store malformed   | Settings shows "Status unavailable" with the file untouched and a **Check again** action.              |
| claude not signed in       | "Claude Code is not signed in on this machine. Connect it in Settings → AI providers and try again."   |
| claude binary missing      | "The claude CLI is not available on this machine. Install Claude Code and try again."                  |
| claude version too old     | Settings shows "claude CLI is too old"; update Claude Code (v2.1.169+) and reload.                     |
| Usage/rate limit           | "<Backend> hit a usage or rate limit. Wait a bit and try again."                                       |
| Run exceeded its ceiling   | "<Backend> took too long to answer, so the turn was stopped." (5/10/15 min per chat mode)              |
| You press Stop             | The partial answer stays, marked "may be incomplete", with an "Ask again" retry.                       |
| Server restarts mid-report | The job reads failed: "The server restarted while this report was running. Request it again to retry." |
| Nothing has transcripts    | "None of the selected videos has a cached transcript. Fetch at least one first."                       |

A failed turn keeps your question (so the thread history stays coherent) and
never invents a partial assistant answer in the database.

## Data locations and privacy

- Threads, messages, and report rows live in the main SQLite database
  (`data/localtube.db`).
- Materialized transcripts and generated reports live under
  `data/ai-jobs/<jobId>/`; a report's HTML file is self-contained and stays
  readable after deletion from the app.
- Nothing AI-related is sent anywhere except through your own authenticated
  CLI (codex → OpenAI with your ChatGPT subscription, opencode → the
  providers your opencode credentials allow, claude → Anthropic with your
  Claude subscription); the app itself remains
  loopback-only. That rule matters more with AI enabled: an exposed scope is
  an unauthenticated way to spend your plan and read your cached transcripts.

## Provider auth verification record

Automated coverage (all offline, no real account touched):

- `tests/unit/ai-codex-account-client.test.ts` — JSON-RPC handshake, split
  messages, notification routing, browser/device login parsing, URL
  validation, method-not-found, timeouts, transport exit, cancel/logout.
- `tests/unit/ai-claude-auth.test.ts` — status parsing, split URLs,
  concurrent starts, stale attempt binding, code submission and rejection,
  deadline kill escalation, native logout, busy-run logout refusal.
- `tests/unit/ai-opencode-credentials.test.ts` — missing/malformed stores,
  Zen-only credentials, preserved unrelated entries, replace/remove,
  idempotent removal, write-failure temp cleanup, permissions, concurrent
  mutations.
- `tests/unit/ai-auth-routes.test.ts` — origin/host checks, bounded bodies,
  provider allowlisting, busy-run refusal, no-store snapshots.
- `tests/component/ai-backend-setting.test.tsx` — selection/action
  separation, wrong-method reconnect, missing CLI, status failure, pending
  panel, code dialog, key dialog field clearing, key save.

Browser verification (agent-browser on Linux, dev server with controlled
fixtures so no real credential was changed): Codex browser sign-in pending /
cancel, device-code display / cancel, sign-in success, sign-out confirmation
and completion; Claude sign-in pending, rejected code inline error, code
completion, sign-out; OpenCode Go replace dialog validation, save preserving
other entries, key removal, malformed-store protection and retry. Checked at
1360×860, 900×700, 768, and 390 px, light and dark, with no horizontal
overflow and no page errors. Screenshots:
[cards](screenshots/provider-auth/cards-1360.png),
[cards at 390 px](screenshots/provider-auth/cards-390.png),
[dark](screenshots/provider-auth/cards-dark.png),
[Codex browser pending](screenshots/provider-auth/codex-browser-pending.png),
[Codex device code](screenshots/provider-auth/codex-device-code.png),
[OpenCode key dialog](screenshots/provider-auth/opencode-key-dialog.png),
[sign-out confirmation](screenshots/provider-auth/sign-out-confirmation.png).

Not yet verified against real accounts (requires a human): completing a real
Codex ChatGPT callback, a real Claude browser sign-in, and a real OpenCode Go
key save, plus sign-out on Windows. Status probes against the installed CLIs
(codex 0.154.0, claude 2.1.241, opencode 1.18.30) were exercised; no real
login, key change, or logout was performed during automated verification.
