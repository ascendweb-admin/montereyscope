import { revalidatePath } from "next/cache";

/**
 * Every page that lists people, their accounts, or the videos attributed to
 * them. Linking, detaching, renaming, and importing videos change how sources
 * are labelled everywhere, not just the library. Shared by the creator and
 * video actions; it lives outside their `"use server"` files, which may only
 * export async functions.
 */
export function revalidateLibraryViews(): void {
  revalidatePath("/");
  revalidatePath("/feed");
  revalidatePath("/chat");
  revalidatePath("/x-dashboard");
  revalidatePath("/creators/[id]", "page");
}
