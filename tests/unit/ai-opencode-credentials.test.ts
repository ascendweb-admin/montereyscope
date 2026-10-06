import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getOpenCodeGoCredentialState,
  OpenCodeKeyInvalidError,
  OpenCodeStoreError,
  openCodeAuthPath,
  removeOpenCodeGoKey,
  saveOpenCodeGoKey,
  storeFileMode,
  validateOpenCodeKey,
} from "@/lib/ai/auth/opencode-credentials";

const tempDirs: string[] = [];
const savedXdg = process.env.XDG_DATA_HOME;

function makeStore(contents?: string): { dir: string; target: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-opencode-store-"));
  tempDirs.push(dir);
  process.env.XDG_DATA_HOME = dir;
  const target = path.join(dir, "opencode", "auth.json");
  if (contents !== undefined) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  return { dir, target };
}

function readStore(target: string): Record<string, unknown> {
  return JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  delete process.env.XDG_DATA_HOME;
});

afterEach(() => {
  if (savedXdg === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = savedXdg;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("opencode credential path", () => {
  it("follows XDG_DATA_HOME and falls back to the home data directory", () => {
    const env = { XDG_DATA_HOME: "/custom/data" } as unknown as NodeJS.ProcessEnv;
    expect(openCodeAuthPath(env)).toBe(path.join("/custom/data", "opencode", "auth.json"));
    const home = openCodeAuthPath({} as unknown as NodeJS.ProcessEnv);
    expect(home.endsWith(path.join(".local", "share", "opencode", "auth.json"))).toBe(true);
  });
});

describe("opencode Go credential state", () => {
  it("treats a missing store as empty", async () => {
    makeStore();
    const state = await getOpenCodeGoCredentialState();
    expect(state).toMatchObject({ keySaved: false, otherCredentialCount: 0, storeError: null });
    expect(state.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects malformed stores without pretending they are empty", async () => {
    makeStore("{ this is not json");
    const state = await getOpenCodeGoCredentialState();
    expect(state.keySaved).toBe(false);
    expect(state.storeError).toMatch(/could not be understood/i);
  });

  it("rejects arrays and non-objects as malformed", async () => {
    makeStore('["not", "a", "store"]');
    expect((await getOpenCodeGoCredentialState()).storeError).not.toBeNull();
    makeStore('"just a string"');
    expect((await getOpenCodeGoCredentialState()).storeError).not.toBeNull();
  });

  it("counts other credentials without turning the Go card green", async () => {
    makeStore(JSON.stringify({ zai: { type: "api", key: "zai-key-123" } }));
    const state = await getOpenCodeGoCredentialState();
    expect(state.keySaved).toBe(false);
    expect(state.otherCredentialCount).toBe(1);
    expect(state.storeError).toBeNull();
  });

  it("recognizes only a structurally valid api credential", async () => {
    makeStore(JSON.stringify({ "opencode-go": { type: "oauth", token: "nope" } }));
    expect((await getOpenCodeGoCredentialState()).keySaved).toBe(false);
    makeStore(JSON.stringify({ "opencode-go": { type: "api" } }));
    expect((await getOpenCodeGoCredentialState()).keySaved).toBe(false);
    makeStore(JSON.stringify({ "opencode-go": { type: "api", key: "   " } }));
    expect((await getOpenCodeGoCredentialState()).keySaved).toBe(false);
    makeStore(JSON.stringify({ "opencode-go": { type: "api", key: "go-key-123456" } }));
    expect((await getOpenCodeGoCredentialState()).keySaved).toBe(true);
  });
});

describe("opencode key validation", () => {
  it("accepts a plausible key and trims surrounding whitespace", () => {
    expect(validateOpenCodeKey("  go-key-123456  ")).toBe("go-key-123456");
  });

  it("rejects short, whitespace-bearing, and oversized keys", () => {
    expect(() => validateOpenCodeKey("short")).toThrow(OpenCodeKeyInvalidError);
    expect(() => validateOpenCodeKey("has space here")).toThrow(OpenCodeKeyInvalidError);
    expect(() => validateOpenCodeKey("x".repeat(401))).toThrow(OpenCodeKeyInvalidError);
  });
});

describe("opencode key mutations", () => {
  it("creates a fresh store with owner-only permissions", async () => {
    const { target } = makeStore();
    const result = await saveOpenCodeGoKey("go-key-123456");
    expect(result.replaced).toBe(false);
    expect(readStore(target)).toEqual({ "opencode-go": { type: "api", key: "go-key-123456" } });
    if (process.platform !== "win32") {
      expect(await storeFileMode(target)).toBe(0o600);
    }
  });

  it("preserves every other provider entry when saving and replacing", async () => {
    const { target } = makeStore(
      JSON.stringify({
        zai: { type: "api", key: "zai-key" },
        "zai-coding-plan": { type: "api", key: "zai-plan-key" },
        "opencode-go": { type: "api", key: "old-go-key" },
      }),
    );
    const replaced = await saveOpenCodeGoKey("new-go-key-123456");
    expect(replaced.replaced).toBe(true);
    const stored = readStore(target);
    expect(stored.zai).toEqual({ type: "api", key: "zai-key" });
    expect(stored["zai-coding-plan"]).toEqual({ type: "api", key: "zai-plan-key" });
    expect(stored["opencode-go"]).toEqual({ type: "api", key: "new-go-key-123456" });
  });

  it("refuses to overwrite a malformed store and leaves the bytes untouched", async () => {
    const malformed = '{"zai": {';
    const { target } = makeStore(malformed);
    await expect(saveOpenCodeGoKey("go-key-123456")).rejects.toBeInstanceOf(OpenCodeStoreError);
    expect(readFileSync(target, "utf8")).toBe(malformed);
  });

  (process.platform === "win32" ? it.skip : it)("cleans up its temp file when the write fails", async () => {
    const { target } = makeStore(JSON.stringify({ zai: { type: "api", key: "zai-key" } }));
    const dir = path.dirname(target);
    chmodSync(dir, 0o500);
    try {
      await expect(saveOpenCodeGoKey("go-key-123456")).rejects.toBeInstanceOf(OpenCodeStoreError);
    } finally {
      chmodSync(dir, 0o700);
    }
    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(readStore(target)).toEqual({ zai: { type: "api", key: "zai-key" } });
  });

  it("removes only the Go entry", async () => {
    const { target } = makeStore(
      JSON.stringify({
        zai: { type: "api", key: "zai-key" },
        "opencode-go": { type: "api", key: "go-key-123456" },
      }),
    );
    const result = await removeOpenCodeGoKey();
    expect(result.removed).toBe(true);
    const stored = readStore(target);
    expect(stored["opencode-go"]).toBeUndefined();
    expect(stored.zai).toEqual({ type: "api", key: "zai-key" });
  });

  it("is idempotent when no Go key is present", async () => {
    const { target } = makeStore(JSON.stringify({ zai: { type: "api", key: "zai-key" } }));
    const before = statSync(target).mtimeMs;
    const result = await removeOpenCodeGoKey();
    expect(result.removed).toBe(false);
    expect(statSync(target).mtimeMs).toBe(before);
  });

  it("removes the key from a store that only had Go", async () => {
    const { target } = makeStore();
    await saveOpenCodeGoKey("go-key-123456");
    await removeOpenCodeGoKey();
    expect(readStore(target)).toEqual({});
  });

  it("refuses to remove from a malformed store", async () => {
    const malformed = '{"opencode-go": {';
    const { target } = makeStore(malformed);
    await expect(removeOpenCodeGoKey()).rejects.toBeInstanceOf(OpenCodeStoreError);
    expect(readFileSync(target, "utf8")).toBe(malformed);
    expect(existsSync(target)).toBe(true);
  });

  it("serializes concurrent saves so both survive", async () => {
    const { target } = makeStore(JSON.stringify({ zai: { type: "api", key: "zai-key" } }));
    await Promise.all([saveOpenCodeGoKey("go-key-aaaaaa"), saveOpenCodeGoKey("go-key-bbbbbb")]);
    const stored = readStore(target);
    expect(stored.zai).toEqual({ type: "api", key: "zai-key" });
    // One of the two wins the last write; neither corrupts the store.
    expect(["go-key-aaaaaa", "go-key-bbbbbb"]).toContain(
      (stored["opencode-go"] as { key: string }).key,
    );
  });
});

it("changes the private connection fingerprint when one valid Go key replaces another", async () => {
  makeStore(JSON.stringify({ "opencode-go": { type: "api", key: "sk-first-key-12345" } }));
  const first = await getOpenCodeGoCredentialState();
  await saveOpenCodeGoKey("sk-second-key-12345");
  const second = await getOpenCodeGoCredentialState();
  expect(first.keySaved && second.keySaved).toBe(true);
  expect(second.fingerprint).not.toBe(first.fingerprint);
  expect(second.fingerprint).not.toContain("sk-second");
});
