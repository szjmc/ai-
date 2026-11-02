import { sql, type SQL } from "drizzle-orm";
import { searchTokens } from "./file-search";
import { normalizeQuery, type ListQuery } from "./records";

/** MySQL 5.7+ compatible; reverse the backend's _<8 hex chars> storage suffix. */
export const displayFileNameSql = sql`CASE
  WHEN file_name REGEXP ${"_[[:xdigit:]]{8}[.][^.]+$"}
  THEN CONCAT(LEFT(file_name, CHAR_LENGTH(file_name) - CHAR_LENGTH(SUBSTRING_INDEX(file_name, '.', -1)) - 10), '.', SUBSTRING_INDEX(file_name, '.', -1))
  ELSE file_name END`;

export function mysqlFileWhere(query: ListQuery): SQL {
  const normalized = normalizeQuery(query);
  const clauses: SQL[] = [];
  if (normalized.collectionName) clauses.push(sql`collection_name = ${normalized.collectionName}`);
  if (normalized.status) clauses.push(sql`status = ${normalized.status}`);
  if (normalized.fileType) clauses.push(sql`LOWER(file_type) = ${normalized.fileType}`);
  for (const token of searchTokens(normalized.q || "")) {
    // LOCATE treats %, _, quotes and backslashes literally, not as LIKE wildcards.
    clauses.push(sql`(
      LOCATE(${token}, LOWER(COALESCE(file_name, ''))) > 0 OR
      LOCATE(${token}, LOWER(COALESCE(${displayFileNameSql}, ''))) > 0 OR
      LOCATE(${token}, LOWER(COALESCE(collection_name, ''))) > 0 OR
      LOCATE(${token}, LOWER(COALESCE(description, ''))) > 0 OR
      LOCATE(${token}, LOWER(COALESCE(file_type, ''))) > 0
    )`);
  }
  return clauses.length ? sql`WHERE ${sql.join(clauses, sql` AND `)}` : sql``;
}
