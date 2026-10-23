import {
  categoriesExist,
  createCategory,
  deleteCategory,
  getCategory,
  profilesExistForCategories,
  replaceCategoryProfiles,
  replaceProfileCategories,
  updateCategory,
} from "./repository";
import { isCategoryColor, type CategoryColor, type CategorySummary } from "./model";
import type { ScopeDatabase } from "@/lib/db/connection";

export interface CategoryServiceError {
  code: "invalid_input" | "duplicate_name" | "not_found";
  message: string;
}

type CategoryResult =
  { ok: true; category: CategorySummary } | { ok: false; error: CategoryServiceError };

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) {
    return null;
  }
  return name;
}

export function normalizeIds(value: unknown, max = 1_000): number[] | null {
  if (!Array.isArray(value) || value.length > max) {
    return null;
  }
  const ids: number[] = [];
  for (const candidate of value) {
    if (!Number.isInteger(candidate) || candidate < 1) {
      return null;
    }
    if (!ids.includes(candidate)) {
      ids.push(candidate);
    }
  }
  return ids;
}

function isUniqueError(error: unknown): boolean {
  return error instanceof Error && "code" in error && String(error.code).includes("UNIQUE");
}

export function createCategoryFromInput(
  db: ScopeDatabase,
  nameValue: unknown,
  colorValue: unknown,
): CategoryResult {
  const name = normalizeName(nameValue);
  if (!name || !isCategoryColor(colorValue)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "Use a category name up to 40 characters." },
    };
  }
  try {
    return { ok: true, category: createCategory(db, { name, color: colorValue }) };
  } catch (error) {
    if (isUniqueError(error)) {
      return {
        ok: false,
        error: { code: "duplicate_name", message: "A category with that name already exists." },
      };
    }
    throw error;
  }
}

export function updateCategoryFromInput(
  db: ScopeDatabase,
  id: unknown,
  nameValue: unknown,
  colorValue: unknown,
): CategoryResult {
  const name = normalizeName(nameValue);
  if (!Number.isInteger(id) || Number(id) < 1 || !name || !isCategoryColor(colorValue)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "Use a category name up to 40 characters." },
    };
  }
  try {
    const category = updateCategory(db, Number(id), { name, color: colorValue });
    return category
      ? { ok: true, category }
      : { ok: false, error: { code: "not_found", message: "That category no longer exists." } };
  } catch (error) {
    if (isUniqueError(error)) {
      return {
        ok: false,
        error: { code: "duplicate_name", message: "A category with that name already exists." },
      };
    }
    throw error;
  }
}

export function deleteCategoryById(
  db: ScopeDatabase,
  id: unknown,
): { ok: true } | { ok: false; error: CategoryServiceError } {
  if (!Number.isInteger(id) || Number(id) < 1) {
    return { ok: false, error: { code: "invalid_input", message: "That category ID is invalid." } };
  }
  return deleteCategory(db, Number(id))
    ? { ok: true }
    : { ok: false, error: { code: "not_found", message: "That category was already deleted." } };
}

/** Replaces a person's (creator profile's) categories. */
export function setProfileCategoryIds(
  db: ScopeDatabase,
  profileId: unknown,
  categoryIdsValue: unknown,
): { ok: true } | { ok: false; error: CategoryServiceError } {
  const ids = normalizeIds(categoryIdsValue);
  if (!Number.isInteger(profileId) || Number(profileId) < 1 || ids === null) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "That category selection is invalid." },
    };
  }
  if (!profilesExistForCategories(db, [Number(profileId)])) {
    return {
      ok: false,
      error: { code: "not_found", message: "That creator is no longer in your library." },
    };
  }
  if (!categoriesExist(db, ids)) {
    return {
      ok: false,
      error: { code: "not_found", message: "One of those categories no longer exists." },
    };
  }
  replaceProfileCategories(db, Number(profileId), ids);
  return { ok: true };
}

/** Replaces the people (creator profiles) filed under a category. */
export function setCategoryProfileIds(
  db: ScopeDatabase,
  categoryId: unknown,
  profileIdsValue: unknown,
): { ok: true } | { ok: false; error: CategoryServiceError } {
  const ids = normalizeIds(profileIdsValue);
  if (!Number.isInteger(categoryId) || Number(categoryId) < 1 || ids === null) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "That creator selection is invalid." },
    };
  }
  if (!getCategory(db, Number(categoryId))) {
    return { ok: false, error: { code: "not_found", message: "That category no longer exists." } };
  }
  if (!profilesExistForCategories(db, ids)) {
    return {
      ok: false,
      error: { code: "not_found", message: "One of those creators is no longer in your library." },
    };
  }
  replaceCategoryProfiles(db, Number(categoryId), ids);
  return { ok: true };
}

export type { CategoryColor };
