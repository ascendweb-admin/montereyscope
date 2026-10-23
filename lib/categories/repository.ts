import type { ScopeDatabase } from "@/lib/db/connection";
import type { CategoryColor, CategorySummary, CreatorCategory } from "./model";

/**
 * Categories describe a person, so memberships live on creator profiles
 * (`profile_categories`). Account-keyed readers stay for the surfaces that
 * work per platform account (feed rows, the X dashboard): an account simply
 * carries its person's categories.
 */

interface CategoryRow {
  id: number;
  name: string;
  color: CategoryColor;
  creator_count: number;
}

interface AssignmentRow {
  owner_id: number;
  id: number;
  name: string;
  color: CategoryColor;
}

function toSummary(row: CategoryRow): CategorySummary {
  return {
    id: Number(row.id),
    name: row.name,
    color: row.color,
    creatorCount: Number(row.creator_count),
  };
}

const CATEGORY_SUMMARY_SELECT = `SELECT c.id, c.name, c.color, COUNT(pc.profile_id) AS creator_count
       FROM categories c
       LEFT JOIN profile_categories pc ON pc.category_id = c.id`;

export function listCategories(db: ScopeDatabase): CategorySummary[] {
  return db
    .prepare<[], CategoryRow>(
      `${CATEGORY_SUMMARY_SELECT}
       GROUP BY c.id
       ORDER BY c.name COLLATE NOCASE ASC`,
    )
    .all()
    .map(toSummary);
}

export function getCategory(db: ScopeDatabase, id: number): CategorySummary | null {
  const row = db
    .prepare<[number], CategoryRow>(
      `${CATEGORY_SUMMARY_SELECT}
       WHERE c.id = ?
       GROUP BY c.id`,
    )
    .get(id);
  return row ? toSummary(row) : null;
}

function toAssignmentMap(rows: AssignmentRow[]): Map<number, CreatorCategory[]> {
  const result = new Map<number, CreatorCategory[]>();
  for (const row of rows) {
    const categories = result.get(Number(row.owner_id)) ?? [];
    categories.push({ id: Number(row.id), name: row.name, color: row.color });
    result.set(Number(row.owner_id), categories);
  }
  return result;
}

/** Profile id → that person's categories, alphabetical. */
export function listProfileCategoryAssignments(db: ScopeDatabase): Map<number, CreatorCategory[]> {
  return toAssignmentMap(
    db
      .prepare<[], AssignmentRow>(
        `SELECT pc.profile_id AS owner_id, c.id, c.name, c.color
         FROM profile_categories pc
         JOIN categories c ON c.id = pc.category_id
         ORDER BY c.name COLLATE NOCASE ASC`,
      )
      .all(),
  );
}

/** Account (creators.id) → its person's categories, alphabetical. */
export function listCreatorCategoryAssignments(db: ScopeDatabase): Map<number, CreatorCategory[]> {
  return toAssignmentMap(
    db
      .prepare<[], AssignmentRow>(
        `SELECT cr.id AS owner_id, c.id, c.name, c.color
         FROM creators cr
         JOIN profile_categories pc ON pc.profile_id = cr.profile_id
         JOIN categories c ON c.id = pc.category_id
         ORDER BY c.name COLLATE NOCASE ASC`,
      )
      .all(),
  );
}

export function listCategoriesForProfile(db: ScopeDatabase, profileId: number): CreatorCategory[] {
  return db
    .prepare<[number], AssignmentRow>(
      `SELECT pc.profile_id AS owner_id, c.id, c.name, c.color
       FROM profile_categories pc
       JOIN categories c ON c.id = pc.category_id
       WHERE pc.profile_id = ?
       ORDER BY c.name COLLATE NOCASE ASC`,
    )
    .all(profileId)
    .map((row) => ({ id: Number(row.id), name: row.name, color: row.color }));
}

/** The categories of the person a saved account belongs to. */
export function listCategoriesForCreator(db: ScopeDatabase, creatorId: number): CreatorCategory[] {
  return db
    .prepare<[number], AssignmentRow>(
      `SELECT cr.id AS owner_id, c.id, c.name, c.color
       FROM creators cr
       JOIN profile_categories pc ON pc.profile_id = cr.profile_id
       JOIN categories c ON c.id = pc.category_id
       WHERE cr.id = ?
       ORDER BY c.name COLLATE NOCASE ASC`,
    )
    .all(creatorId)
    .map((row) => ({ id: Number(row.id), name: row.name, color: row.color }));
}

export function createCategory(
  db: ScopeDatabase,
  input: { name: string; color: CategoryColor },
): CategorySummary {
  const result = db
    .prepare("INSERT INTO categories (name, color) VALUES (?, ?)")
    .run(input.name, input.color);
  const category = getCategory(db, Number(result.lastInsertRowid));
  if (!category) {
    throw new Error("Inserted category could not be read back");
  }
  return category;
}

export function updateCategory(
  db: ScopeDatabase,
  id: number,
  input: { name: string; color: CategoryColor },
): CategorySummary | null {
  const result = db
    .prepare(
      `UPDATE categories
       SET name = ?, color = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .run(input.name, input.color, id);
  return Number(result.changes) > 0 ? getCategory(db, id) : null;
}

export function deleteCategory(db: ScopeDatabase, id: number): boolean {
  return Number(db.prepare("DELETE FROM categories WHERE id = ?").run(id).changes) > 0;
}

function existingIds(
  db: ScopeDatabase,
  table: "categories" | "creator_profiles",
  ids: number[],
): Set<number> {
  if (ids.length === 0) {
    return new Set();
  }
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare<number[], { id: number }>(`SELECT id FROM ${table} WHERE id IN (${placeholders})`)
    .all(...ids);
  return new Set(rows.map((row) => Number(row.id)));
}

export function categoriesExist(db: ScopeDatabase, ids: number[]): boolean {
  return existingIds(db, "categories", ids).size === ids.length;
}

export function profilesExistForCategories(db: ScopeDatabase, ids: number[]): boolean {
  return existingIds(db, "creator_profiles", ids).size === ids.length;
}

export function replaceProfileCategories(
  db: ScopeDatabase,
  profileId: number,
  categoryIds: number[],
): void {
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM profile_categories WHERE profile_id = ?").run(profileId);
    const insert = db.prepare(
      "INSERT INTO profile_categories (profile_id, category_id) VALUES (?, ?)",
    );
    for (const categoryId of categoryIds) {
      insert.run(profileId, categoryId);
    }
  });
  replace();
}

/**
 * Adds memberships to the person a saved account belongs to without clearing
 * existing ones — the add flow files a newly saved account this way.
 */
export function addCreatorCategories(
  db: ScopeDatabase,
  creatorId: number,
  categoryIds: number[],
): void {
  if (categoryIds.length === 0) {
    return;
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO profile_categories (profile_id, category_id)
     SELECT profile_id, ? FROM creators WHERE id = ?`,
  );
  const add = db.transaction(() => {
    for (const categoryId of categoryIds) {
      insert.run(categoryId, creatorId);
    }
  });
  add();
}

export function replaceCategoryProfiles(
  db: ScopeDatabase,
  categoryId: number,
  profileIds: number[],
): void {
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM profile_categories WHERE category_id = ?").run(categoryId);
    const insert = db.prepare(
      "INSERT INTO profile_categories (profile_id, category_id) VALUES (?, ?)",
    );
    for (const profileId of profileIds) {
      insert.run(profileId, categoryId);
    }
  });
  replace();
}
