import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: any[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

/**
 * Quote a SQL identifier safely (schema, table or column name).
 * Throws on anything that isn't a plausible identifier to avoid injection.
 */
export function ident(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw Object.assign(new Error(`Invalid identifier: ${name}`), { statusCode: 400 });
  }
  return `"${name}"`;
}

/** Cache of which public tables exist + their columns, used to validate REST requests. */
let tableCache: Map<string, Set<string>> | null = null;
let tableCacheAt = 0;

export async function getPublicTables(): Promise<Map<string, Set<string>>> {
  const now = Date.now();
  if (tableCache && now - tableCacheAt < 5000) return tableCache;
  const { rows } = await query<{ table_name: string; column_name: string }>(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position`,
  );
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!map.has(r.table_name)) map.set(r.table_name, new Set());
    map.get(r.table_name)!.add(r.column_name);
  }
  tableCache = map;
  tableCacheAt = now;
  return map;
}

export async function assertTable(table: string): Promise<Set<string>> {
  const tables = await getPublicTables();
  const cols = tables.get(table);
  if (!cols) {
    throw Object.assign(new Error(`Unknown table: ${table}`), { statusCode: 404 });
  }
  return cols;
}
