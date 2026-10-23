"use server";

import { revalidatePath } from "next/cache";

import {
  createCategoryFromInput,
  deleteCategoryById,
  setCategoryProfileIds,
  setProfileCategoryIds,
  updateCategoryFromInput,
} from "@/lib/categories/service";
import type { CategorySummary } from "@/lib/categories";
import { getDb } from "@/lib/db/connection";

export interface CategoryActionOutcome {
  ok: boolean;
  category?: CategorySummary;
  message?: string;
}

function revalidateCategoryViews(): void {
  revalidatePath("/");
  revalidatePath("/chat");
  revalidatePath("/feed");
  revalidatePath("/x-dashboard");
  revalidatePath("/creators/[id]", "page");
}

export async function createCategoryAction(
  name: unknown,
  color: unknown,
): Promise<CategoryActionOutcome> {
  try {
    const outcome = createCategoryFromInput(getDb(), name, color);
    if (!outcome.ok) {
      return { ok: false, message: outcome.error.message };
    }
    revalidateCategoryViews();
    return { ok: true, category: outcome.category };
  } catch {
    return { ok: false, message: "The category could not be created. Please try again." };
  }
}

export async function updateCategoryAction(
  id: unknown,
  name: unknown,
  color: unknown,
): Promise<CategoryActionOutcome> {
  try {
    const outcome = updateCategoryFromInput(getDb(), id, name, color);
    if (!outcome.ok) {
      return { ok: false, message: outcome.error.message };
    }
    revalidateCategoryViews();
    return { ok: true, category: outcome.category };
  } catch {
    return { ok: false, message: "The category could not be updated. Please try again." };
  }
}

export async function deleteCategoryAction(id: unknown): Promise<CategoryActionOutcome> {
  try {
    const outcome = deleteCategoryById(getDb(), id);
    if (!outcome.ok) {
      return { ok: false, message: outcome.error.message };
    }
    revalidateCategoryViews();
    return { ok: true };
  } catch {
    return { ok: false, message: "The category could not be deleted. Please try again." };
  }
}

/** Files a person (creator profile) under exactly these categories. */
export async function setProfileCategoriesAction(
  profileId: unknown,
  categoryIds: unknown,
): Promise<CategoryActionOutcome> {
  try {
    const outcome = setProfileCategoryIds(getDb(), profileId, categoryIds);
    if (!outcome.ok) {
      return { ok: false, message: outcome.error.message };
    }
    revalidateCategoryViews();
    return { ok: true };
  } catch {
    return { ok: false, message: "The creator's categories could not be saved. Please try again." };
  }
}

/** Makes a category hold exactly these people (creator profile ids). */
export async function setCategoryProfilesAction(
  categoryId: unknown,
  profileIds: unknown,
): Promise<CategoryActionOutcome> {
  try {
    const outcome = setCategoryProfileIds(getDb(), categoryId, profileIds);
    if (!outcome.ok) {
      return { ok: false, message: outcome.error.message };
    }
    revalidateCategoryViews();
    return { ok: true };
  } catch {
    return { ok: false, message: "The category's creators could not be saved. Please try again." };
  }
}
