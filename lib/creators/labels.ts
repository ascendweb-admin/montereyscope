/**
 * Pure labels for people and their platform accounts — shared by server
 * code that prebuilds view models and by client components.
 */
import type { CreatorPlatform } from "./repository";

/** Longest name a person can be given in scope. */
export const PROFILE_NAME_MAX_LENGTH = 100;

export const PLATFORM_LABELS: Record<CreatorPlatform, string> = {
  youtube: "YouTube",
  rumble: "Rumble",
  x: "X",
};

/** Display order for platforms: video platforms first, then X. */
export const PLATFORM_SEQUENCE: readonly CreatorPlatform[] = ["youtube", "rumble", "x"];

/** The distinct platforms of a set of accounts, in display order. */
export function platformsOf(accounts: readonly { platform: CreatorPlatform }[]): CreatorPlatform[] {
  const present = new Set(accounts.map((account) => account.platform));
  return PLATFORM_SEQUENCE.filter((platform) => present.has(platform));
}

/** "YouTube, Rumble and X". */
export function joinPlatformNames(platforms: readonly CreatorPlatform[]): string {
  const names = platforms.map((platform) => PLATFORM_LABELS[platform]);
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export interface AccountLabelInput {
  platform: CreatorPlatform;
  handle: string | null;
}

export function formatHandle(handle: string | null): string | null {
  return handle ? `@${handle.replace(/^@/, "")}` : null;
}

/**
 * How one account reads beside its siblings: the platform name when it is
 * the person's only account there, the handle when the platform repeats
 * (two YouTube channels need telling apart).
 */
export function accountChipLabel(
  account: AccountLabelInput,
  siblings: readonly AccountLabelInput[],
): string {
  const samePlatform = siblings.filter((entry) => entry.platform === account.platform).length;
  if (samePlatform > 1) {
    return formatHandle(account.handle) ?? PLATFORM_LABELS[account.platform];
  }
  return PLATFORM_LABELS[account.platform];
}

/** "@janedoe · @jane" — the distinct handles a person goes by. */
export function handleSummary(accounts: readonly AccountLabelInput[]): string {
  const handles: string[] = [];
  for (const account of accounts) {
    const handle = formatHandle(account.handle);
    if (handle && !handles.some((entry) => entry.toLowerCase() === handle.toLowerCase())) {
      handles.push(handle);
    }
  }
  return handles.join(" · ");
}
