import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql, { type Pool } from "mysql2/promise";
import { getBackendConfig } from "@/lib/backend-config";

const globalDb = globalThis as typeof globalThis & { __knowledgeMysql?: { pool: Pool; db: MySql2Database } };

function getDatabase() {
  if (!globalDb.__knowledgeMysql) {
    const config = getBackendConfig();
    const pool = mysql.createPool({
      host: config.mysqlHost, port: config.mysqlPort,
      user: config.mysqlUser, password: config.mysqlPassword, database: config.mysqlDb,
      charset: "utf8mb4", waitForConnections: true, connectionLimit: 8,
      connectTimeout: 3000, enableKeepAlive: true,
    });
    globalDb.__knowledgeMysql = { pool, db: drizzle({ client: pool }) };
  }
  return globalDb.__knowledgeMysql.db;
}

/** Existing MySQL table only; no extra database, migration or schema is created. */
export const db = new Proxy({} as MySql2Database, {
  get(_target, key) {
    const database = getDatabase();
    const value = Reflect.get(database, key);
    return typeof value === "function" ? value.bind(database) : value;
  },
});
