const AVATAR_STYLES = [
  "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
];

/** A stable initials-avatar palette entry for a name. */
export function creatorAvatarStyle(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % 997;
  }
  return AVATAR_STYLES[hash % AVATAR_STYLES.length];
}
