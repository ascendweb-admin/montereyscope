import type { ScopeDatabase } from "@/lib/db/connection";
import type { CategoryColor, CategorySummary, CreatorCategory } from "./model";

interface CategoryRow {
  id: number;
  name: string;
  color: CategoryColor;
  creator_count: number;
}

interface AssignmentRow {
  creator_id: number;
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

export function listCategories(db: ScopeDatabase): CategorySummary[] {
  return db
    .prepare<[], CategoryRow>(
      `SELECT c.id, c.name, c.color, COUNT(cc.creator_id) AS creator_count
       FROM categories c
       LEFT JOIN creator_categories cc ON cc.category_id = c.id
       GROUP BY c.id
       ORDER BY c.name COLLATE NOCASE ASC`,
    )
    .all()
    .map(toSummary);
}

export function getCategory(db: ScopeDatabase, id: number): CategorySummary | null {
  const row = db
    .prepare<[number], CategoryRow>(
      `SELECT c.id, c.name, c.color, COUNT(cc.creator_id) AS creator_count
       FROM categories c
       LEFT JOIN creator_categories cc ON cc.category_id = c.id
       WHERE c.id = ?
       GROUP BY c.id`,
    )
    .get(id);
  return row ? toSummary(row) : null;
}

export function listCreatorCategoryAssignments(db: ScopeDatabase): Map<number, CreatorCategory[]> {
  const rows = db
    .prepare<[], AssignmentRow>(
      `SELECT cc.creator_id, c.id, c.name, c.color
       FROM creator_categories cc
       JOIN categories c ON c.id = cc.category_id
       ORDER BY c.name COLLATE NOCASE ASC`,
    )
    .all();
  const result = new Map<number, CreatorCategory[]>();
  for (const row of rows) {
    const categories = result.get(Number(row.creator_id)) ?? [];
    categories.push({ id: Number(row.id), name: row.name, color: row.color });
    result.set(Number(row.creator_id), categories);
  }
  return result;
}

export function listCategoriesForCreator(db: ScopeDatabase, creatorId: number): CreatorCategory[] {
  return db
    .prepare<[number], AssignmentRow>(
      `SELECT cc.creator_id, c.id, c.name, c.color
       FROM creator_categories cc
       JOIN categories c ON c.id = cc.category_id
       WHERE cc.creator_id = ?
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
  table: "categories" | "creators",
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

export function creatorsExist(db: ScopeDatabase, ids: number[]): boolean {
  return existingIds(db, "creators", ids).size === ids.length;
}

export function replaceCreatorCategories(
  db: ScopeDatabase,
  creatorId: number,
  categoryIds: number[],
): void {
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM creator_categories WHERE creator_id = ?").run(creatorId);
    const insert = db.prepare(
      "INSERT INTO creator_categories (creator_id, category_id) VALUES (?, ?)",
    );
    for (const categoryId of categoryIds) {
      insert.run(creatorId, categoryId);
    }
  });
  replace();
}

/** Adds memberships without clearing existing ones, used by the add flow. */
export function addCreatorCategories(
  db: ScopeDatabase,
  creatorId: number,
  categoryIds: number[],
): void {
  if (categoryIds.length === 0) {
    return;
  }
  const insert = db.prepare(
    "INSERT OR IGNORE INTO creator_categories (creator_id, category_id) VALUES (?, ?)",
  );
  const add = db.transaction(() => {
    for (const categoryId of categoryIds) {
      insert.run(creatorId, categoryId);
    }
  });
  add();
}

export function replaceCategoryCreators(
  db: ScopeDatabase,
  categoryId: number,
  creatorIds: number[],
): void {
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM creator_categories WHERE category_id = ?").run(categoryId);
    const insert = db.prepare(
      "INSERT INTO creator_categories (creator_id, category_id) VALUES (?, ?)",
    );
    for (const creatorId of creatorIds) {
      insert.run(creatorId, categoryId);
    }
  });
  replace();
}
