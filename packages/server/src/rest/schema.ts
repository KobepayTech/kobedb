import type { FastifyInstance } from 'fastify';
import { query, ident } from '../db.js';

// Whitelisted column types (friendly name -> SQL type).
const TYPES: Record<string, string> = {
  text: 'text',
  varchar: 'varchar',
  int: 'integer',
  integer: 'integer',
  bigint: 'bigint',
  serial: 'bigint generated always as identity',
  boolean: 'boolean',
  bool: 'boolean',
  uuid: 'uuid',
  json: 'jsonb',
  jsonb: 'jsonb',
  timestamptz: 'timestamptz',
  timestamp: 'timestamp',
  date: 'date',
  numeric: 'numeric',
  real: 'real',
  float: 'double precision',
};

// Safe DEFAULT tokens; anything else is treated as a literal and quoted.
const DEFAULT_KEYWORDS = new Set([
  'now()',
  'true',
  'false',
  'null',
  'gen_random_uuid()',
  "''",
  '0',
]);

function defaultClause(def: unknown): string {
  if (def == null || def === '') return '';
  const s = String(def).trim();
  if (DEFAULT_KEYWORDS.has(s.toLowerCase())) return `default ${s}`;
  if (/^-?\d+(\.\d+)?$/.test(s)) return `default ${s}`; // numeric literal
  return `default '${s.replace(/'/g, "''")}'`; // quoted string literal
}

interface ColumnSpec {
  name: string;
  type: string;
  nullable?: boolean;
  default?: unknown;
  primaryKey?: boolean;
}

function columnDef(c: ColumnSpec): string {
  const sqlType = TYPES[String(c.type).toLowerCase()];
  if (!sqlType) throw Object.assign(new Error(`unsupported type: ${c.type}`), { statusCode: 400 });
  const parts = [ident(c.name), sqlType];
  if (c.primaryKey) parts.push('primary key');
  if (c.nullable === false && !c.primaryKey) parts.push('not null');
  const def = defaultClause(c.default);
  if (def) parts.push(def);
  return parts.join(' ');
}

export function registerSchemaRoutes(app: FastifyInstance, onChange: () => void) {
  // Introspect the public schema: tables, columns, types, nullability, PKs.
  app.get('/admin/schema', async () => {
    const { rows } = await query<any>(
      `select c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default,
              (pk.column_name is not null) as is_primary
         from information_schema.columns c
         left join (
           select kcu.table_name, kcu.column_name
             from information_schema.table_constraints tc
             join information_schema.key_column_usage kcu
               on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
            where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public'
         ) pk on pk.table_name = c.table_name and pk.column_name = c.column_name
        where c.table_schema = 'public'
        order by c.table_name, c.ordinal_position`,
    );
    const tables: Record<string, any[]> = {};
    for (const r of rows) {
      (tables[r.table_name] ??= []).push({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === 'YES',
        default: r.column_default,
        primaryKey: r.is_primary,
      });
    }
    return { tables };
  });

  // Create a table.  { name, columns: [{ name, type, nullable?, default?, primaryKey? }] }
  app.post('/admin/schema/tables', async (req, reply) => {
    const { name, columns } = (req.body ?? {}) as { name: string; columns: ColumnSpec[] };
    if (!name || !Array.isArray(columns) || !columns.length)
      return reply.code(400).send({ error: 'name and at least one column are required' });

    const defs = columns.map(columnDef);
    // Auto-add an identity PK if the caller didn't declare any primary key.
    if (!columns.some((c) => c.primaryKey)) {
      defs.unshift(`${ident('id')} bigint generated always as identity primary key`);
    }
    const sql = `create table public.${ident(name)} (${defs.join(', ')})`;
    await query(sql);
    onChange();
    return reply.code(201).send({ table: name, sql });
  });

  // Add a column to an existing table.
  app.post('/admin/schema/tables/:table/columns', async (req, reply) => {
    const { table } = req.params as { table: string };
    const col = (req.body ?? {}) as ColumnSpec;
    if (!col.name || !col.type) return reply.code(400).send({ error: 'name and type required' });
    const sql = `alter table public.${ident(table)} add column ${columnDef({ ...col, primaryKey: false })}`;
    await query(sql);
    onChange();
    return reply.code(201).send({ table, column: col.name, sql });
  });

  // Drop a column.
  app.delete('/admin/schema/tables/:table/columns/:column', async (req, reply) => {
    const { table, column } = req.params as { table: string; column: string };
    await query(`alter table public.${ident(table)} drop column ${ident(column)}`);
    onChange();
    return reply.code(204).send();
  });

  // Drop a table.
  app.delete('/admin/schema/tables/:table', async (req, reply) => {
    const { table } = req.params as { table: string };
    await query(`drop table if exists public.${ident(table)} cascade`);
    onChange();
    return reply.code(204).send();
  });

  // Run arbitrary SQL (the migrations escape hatch + Studio SQL editor). Service-role only.
  app.post('/admin/sql', async (req, reply) => {
    const { query: sql } = (req.body ?? {}) as { query: string };
    if (!sql || !String(sql).trim()) return reply.code(400).send({ error: 'query required' });
    try {
      const result = await query(String(sql));
      onChange();
      return reply.send({
        command: result.command,
        rowCount: result.rowCount,
        rows: result.rows,
        fields: result.fields?.map((f) => f.name) ?? [],
      });
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });
}
