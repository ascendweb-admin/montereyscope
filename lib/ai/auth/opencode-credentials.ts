/**
 * OpenCode Go credential store (provider-auth stage). Server-only.
 *
 * Scope never invents a credential format: an OpenCode Go API key is written
 * under `opencode-go` with `{ type: "api", key }` in opencode's own
 * `auth.json`, exactly as `opencode auth login` would. This module owns that
 * file for the Go key only:
 *
 * - a missing file reads as empty; malformed JSON, arrays, non-objects, and
 *   permission failures are rejected rather than overwritten,
 * - every other provider entry (Zen included) is preserved byte-for-byte in
 *   value, and removed keys never touch them,
 * - writes are serialized, use an exclusively created owner-only temp file
 *   in the same directory, re-check the target for external changes, then
 *   atomically replace it, cleaning up on any failure.
 *
 * Two writers racing at the filesystem level (another opencode process
 * saving at the same instant) can still lose an update after the re-check;
 * that residual race is inherent to a read-modify-write without provider
 * tooling and is documented in docs/ai-features.md.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Provider id the Go plan's key lives under. */
export const OPENCODE_GO_PROVIDER_ID = "opencode-go";

/** Bounded key shape; anything longer is not an OpenCode key. */
const MIN_KEY_CHARS = 8;
const MAX_KEY_CHARS = 400;

/** Thrown when a pasted key does not have the shape of an API key. */
export class OpenCodeKeyInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeKeyInvalidError";
  }
}

export type OpenCodeStoreErrorCode = "malformed" | "unreadable" | "write_failed" | "conflict";

/** Thrown when the credential file cannot be safely read or written. */
export class OpenCodeStoreError extends Error {
  readonly code: OpenCodeStoreErrorCode;

  constructor(code: OpenCodeStoreErrorCode, message: string) {
    super(message);
    this.name = "OpenCodeStoreError";
    this.code = code;
  }
}

/**
 * opencode's documented credential path: $XDG_DATA_HOME/opencode/auth.json,
 * falling back to ~/.local/share/opencode/auth.json (mirrors the binary).
 */
export function openCodeAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) {
    return path.join(xdg, "opencode", "auth.json");
  }
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
}

type StoreRead =
  | { ok: true; exists: boolean; raw: string | null; entries: Record<string, unknown> }
  | { ok: false; code: "malformed" | "unreadable" };

/**
 * Reads and structurally validates the credential store. A missing file is a
 * valid empty store; a file that cannot be read or does not parse as a JSON
 * object is an error the caller must not paper over with a fresh store.
 */
async function readStore(target: string): Promise<StoreRead> {
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: true, exists: false, raw: null, entries: {} };
    }
    return { ok: false, code: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: "malformed" };
  }
  return { ok: true, exists: true, raw, entries: parsed as Record<string, unknown> };
}

function storeErrorMessage(code: "malformed" | "unreadable"): string {
  return code === "malformed"
    ? "opencode's credential file exists but could not be understood. Scope left it untouched; fix or remove it, then try again."
    : "opencode's credential file could not be read. Check its permissions, then try again.";
}

export interface OpenCodeGoCredentialState {
  /** Server-only digest for detecting replacement with another valid key. */
  fingerprint?: string;
  /** A structurally valid `opencode-go` API credential is present. */
  keySaved: boolean;
  /** Entries under other provider ids; they are preserved on save/remove. */
  otherCredentialCount: number;
  /** Non-null when the store itself is malformed/unreadable. */
  storeError: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** True when the entry is an api credential with a plausible key string. */
function isGoApiCredential(value: unknown): boolean {
  const record = asRecord(value);
  if (record === null || record.type !== "api") {
    return false;
  }
  const key = record.key;
  return typeof key === "string" && key.trim().length > 0;
}

/**
 * Reads the Go-specific view of the store. Never throws: background status
 * calls report the problem as text, while mutations raise it so they cannot
 * overwrite the file.
 */
export async function getOpenCodeGoCredentialState(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenCodeGoCredentialState> {
  const store = await readStore(openCodeAuthPath(env));
  if (!store.ok) {
    return { keySaved: false, otherCredentialCount: 0, storeError: storeErrorMessage(store.code) };
  }
  const ids = Object.keys(store.entries);
  return {
    keySaved: isGoApiCredential(store.entries[OPENCODE_GO_PROVIDER_ID]),
    fingerprint: createHash("sha256")
      .update(JSON.stringify(store.entries[OPENCODE_GO_PROVIDER_ID] ?? null))
      .digest("hex"),
    otherCredentialCount: ids.filter((id) => id !== OPENCODE_GO_PROVIDER_ID).length,
    storeError: null,
  };
}

// ---------------------------------------------------------------------------
// Serialized mutations
// ---------------------------------------------------------------------------

let mutationChain: Promise<unknown> = Promise.resolve();

/** Runs one mutation at a time, even under concurrent route calls. */
function withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(operation, operation);
  // Keep the chain alive regardless of outcome; callers see their own error.
  mutationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

interface TempFile {
  tmp: string;
  cleanup: () => Promise<void>;
}

async function createTempFile(target: string): Promise<TempFile> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.auth.json.scope-${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
  );
  return {
    tmp,
    cleanup: async () => {
      await rm(tmp, { force: true }).catch(() => {});
    },
  };
}

/**
 * Atomically replaces the store: the temp file is created exclusively with
 * owner-only permissions in the same directory, the target is re-read to
 * catch external writers, and only a matching target is replaced. The temp
 * file is removed on every failure path.
 */
async function replaceStore(
  target: string,
  entries: Record<string, unknown>,
  expectedRaw: string | null,
  expectedExists: boolean,
): Promise<void> {
  const temp = await createTempFile(target);
  try {
    await writeFile(temp.tmp, `${JSON.stringify(entries, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    // Re-check for external changes before replacing. A writer that lands
    // between this read and the rename can still be lost; see the module
    // header for why that residual race is accepted.
    const current = await readStore(target);
    const matches = current.ok
      ? current.exists === expectedExists && current.raw === expectedRaw
      : false;
    if (!matches) {
      throw new OpenCodeStoreError(
        "conflict",
        "opencode's credential file changed while scope was saving. Nothing was overwritten — try again.",
      );
    }
    await rename(temp.tmp, target);
  } catch (error) {
    await temp.cleanup();
    if (error instanceof OpenCodeStoreError) {
      throw error;
    }
    throw new OpenCodeStoreError(
      "write_failed",
      "The OpenCode credential could not be saved. Check the file's permissions and try again.",
    );
  }
}

/** Validates the pasted key shape; returns the trimmed key. */
export function validateOpenCodeKey(rawKey: string): string {
  const key = rawKey.trim();
  if (key.length < MIN_KEY_CHARS || key.length > MAX_KEY_CHARS || /\s/.test(key)) {
    throw new OpenCodeKeyInvalidError(
      "That does not look like an OpenCode API key. Copy the full key from opencode.ai/auth and paste it again.",
    );
  }
  return key;
}

export interface SaveOpenCodeGoKeyResult {
  /** True when a previous Go key was replaced. */
  replaced: boolean;
}

/**
 * Saves (or replaces) the `opencode-go` API key, preserving every other
 * entry. Raises OpenCodeKeyInvalidError for shape problems and
 * OpenCodeStoreError when the existing file must not be overwritten.
 */
export async function saveOpenCodeGoKey(
  rawKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SaveOpenCodeGoKeyResult> {
  const key = validateOpenCodeKey(rawKey);
  return withStoreLock(async () => {
    const target = openCodeAuthPath(env);
    const store = await readStore(target);
    if (!store.ok) {
      throw new OpenCodeStoreError(store.code, storeErrorMessage(store.code));
    }
    const replaced = isGoApiCredential(store.entries[OPENCODE_GO_PROVIDER_ID]);
    const entries: Record<string, unknown> = {
      ...store.entries,
      [OPENCODE_GO_PROVIDER_ID]: { type: "api", key },
    };
    await replaceStore(target, entries, store.raw, store.exists);
    return { replaced };
  });
}

export interface RemoveOpenCodeGoKeyResult {
  /** True when a Go key was removed; false when none was present. */
  removed: boolean;
}

/**
 * Removes only the `opencode-go` entry. Idempotent when absent. A malformed
 * store is left untouched and reported.
 */
export async function removeOpenCodeGoKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RemoveOpenCodeGoKeyResult> {
  return withStoreLock(async () => {
    const target = openCodeAuthPath(env);
    const store = await readStore(target);
    if (!store.ok) {
      throw new OpenCodeStoreError(store.code, storeErrorMessage(store.code));
    }
    if (!Object.prototype.hasOwnProperty.call(store.entries, OPENCODE_GO_PROVIDER_ID)) {
      return { removed: false };
    }
    const entries = { ...store.entries };
    delete entries[OPENCODE_GO_PROVIDER_ID];
    await replaceStore(target, entries, store.raw, store.exists);
    return { removed: true };
  });
}

/** Whether the store file is owner-only (0600) on POSIX; used by tests. */
export async function storeFileMode(target: string): Promise<number | null> {
  try {
    const info = await stat(target);
    return info.mode & 0o777;
  } catch {
    return null;
  }
}
