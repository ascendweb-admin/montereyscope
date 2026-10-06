import { createHash } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";

import type { AiBackendId } from "../backend-id";
import { getAuthManager } from "../auth/manager";
import { resolveCodexLaunch } from "../codex";
import { resolveClaudeLaunch } from "../claude";
import { resolveOpencodeLaunch } from "../opencode";

export interface CatalogConnection {
  connected: boolean;
  /** Server-only digest. The browser receives a monotonic generation instead. */
  identity: string;
}

/** Detect executable replacement, including changes behind a symlink or PATH. */
export async function runtimeIdentity(command: string): Promise<string> {
  const extensions =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")]
      : [""];
  const candidates =
    path.isAbsolute(command) || command.includes(path.sep)
      ? [command]
      : (process.env.PATH ?? "")
          .split(path.delimiter)
          .flatMap((dir) => extensions.map((extension) => path.join(dir, command + extension)));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      return JSON.stringify([resolved, info.size, info.mtimeMs, info.ctimeMs]);
    } catch {
      // Continue PATH lookup.
    }
  }
  return `missing:${command}`;
}

export async function readCatalogConnection(provider: AiBackendId): Promise<CatalogConnection> {
  const launch =
    provider === "codex"
      ? resolveCodexLaunch()
      : provider === "claude"
        ? await resolveClaudeLaunch()
        : await resolveOpencodeLaunch();
  // A script launch identifies the wrapper's JavaScript entry, not the Node
  // runner every npm install would share.
  const command = launch.argsPrefix.length > 0 ? launch.argsPrefix[0] : launch.command;
  const credentialFile =
    provider === "codex"
      ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json")
      : provider === "claude"
        ? path.join(
            process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
            ".credentials.json",
          )
        : null;
  // File metadata catches credential replacement even when the account API
  // omits an identity. Keychain-backed Claude uses its reported account identity.
  const stamp = credentialFile
    ? await stat(credentialFile)
        .then((info) => [info.ino, info.size, info.mtimeMs, info.ctimeMs])
        .catch(() => null)
    : null;
  const [account, runtime] = await Promise.all([
    getAuthManager().getCatalogConnection(provider),
    runtimeIdentity(command),
  ]);
  return {
    connected: account.connected && !runtime.startsWith("missing:"),
    identity: createHash("sha256")
      .update(JSON.stringify([account, runtime, stamp]))
      .digest("hex"),
  };
}
