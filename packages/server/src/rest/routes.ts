import type { FastifyInstance } from 'fastify';
import { query, assertTable, ident, getPublicTables } from '../db.js';
import { resolveAuth } from '../auth/middleware.js';
import { parseQuery } from './filters.js';

/**
 * Auto-generated REST API over every table in the `public` schema.
 *
 *   GET    /rest/v1/:table         list rows (with filters)
 *   POST   /rest/v1/:table         insert row(s)
 *   PATCH  /rest/v1/:table         update rows matching filters
 *   DELETE /rest/v1/:table         delete rows matching filters
 *
 * Read access is open; writes require an authenticated user or the service role.
 */
export async function restRoutes(app: FastifyInstance) {
  // Introspection: list available tables + columns.
  app.get('/rest/v1/', async () => {
    const tables = await getPublicTables();
    return Object.fromEntries([...tables].map(([t, cols]) => [t, [...cols]]));
  });

  app.get('/rest/v1/:table', async (req, reply) => {
    const { table } = req.params as { table: string };
    const cols = await assertTable(table);
    const parsed = parseQuery(req.query as any, cols);

    let sql = `select ${parsed.select} from public.${ident(table)} ${parsed.where}`;
    if (parsed.orderBy) sql += ` order by ${parsed.orderBy}`;
    if (parsed.limit != null) sql += ` limit ${parsed.limit}`;
    if (parsed.offset != null) sql += ` offset ${parsed.offset}`;

    const { rows } = await query(sql, parsed.params);

    // Supabase clients use ?id=eq.x with header Accept to get a single object.
    const accept = req.headers['accept'] ?? '';
    if (typeof accept === 'string' && accept.includes('application/vnd.pgrst.object+json')) {
      if (rows.length !== 1) return reply.code(406).send({ error: 'expected exactly one row' });
      return reply.send(rows[0]);
    }
    return reply.send(rows);
  });

  app.post('/rest/v1/:table', async (req, reply) => {
    const { table } = req.params as { table: string };
    const ctx = resolveAuth(req);
    if (ctx.role === 'anon') return reply.code(401).send({ error: 'authentication required to insert' });

    const cols = await assertTable(table);
    const body = req.body as any;
    const records: Record<string, any>[] = Array.isArray(body) ? body : [body];
    if (!records.length) return reply.code(400).send({ error: 'no rows provided' });

    // Use the union of keys across records; validate every key.
    const keys = [...new Set(records.flatMap((r) => Object.keys(r)))];
    for (const k of keys) {
      if (!cols.has(k)) return reply.code(400).send({ error: `unknown column: ${k}` });
    }

    const colList = keys.map(ident).join(', ');
    const valuesSql: string[] = [];
    const params: any[] = [];
    let p = 0;
    for (const rec of records) {
      const ph = keys.map((k) => {
        params.push(rec[k] ?? null);
        return `$${++p}`;
      });
      valuesSql.push(`(${ph.join(', ')})`);
    }

    const sql = `insert into public.${ident(table)} (${colList}) values ${valuesSql.join(', ')} returning *`;
    const { rows } = await query(sql, params);
    return reply.code(201).send(Array.isArray(body) ? rows : rows[0]);
  });

  app.patch('/rest/v1/:table', async (req, reply) => {
    const { table } = req.params as { table: string };
    const ctx = resolveAuth(req);
    if (ctx.role === 'anon') return reply.code(401).send({ error: 'authentication required to update' });

    const cols = await assertTable(table);
    const parsed = parseQuery(req.query as any, cols);
    if (!parsed.where) return reply.code(400).send({ error: 'refusing to update without a filter' });

    const patch = req.body as Record<string, any>;
    const keys = Object.keys(patch ?? {});
    if (!keys.length) return reply.code(400).send({ error: 'no fields to update' });
    for (const k of keys) if (!cols.has(k)) return reply.code(400).send({ error: `unknown column: ${k}` });

    const params = [...parsed.params];
    let p = params.length;
    const setSql = keys
      .map((k) => {
        params.push(patch[k]);
        return `${ident(k)} = $${++p}`;
      })
      .join(', ');

    const sql = `update public.${ident(table)} set ${setSql} ${parsed.where} returning *`;
    const { rows } = await query(sql, params);
    return reply.send(rows);
  });

  app.delete('/rest/v1/:table', async (req, reply) => {
    const { table } = req.params as { table: string };
    const ctx = resolveAuth(req);
    if (ctx.role === 'anon') return reply.code(401).send({ error: 'authentication required to delete' });

    const cols = await assertTable(table);
    const parsed = parseQuery(req.query as any, cols);
    if (!parsed.where) return reply.code(400).send({ error: 'refusing to delete without a filter' });

    const sql = `delete from public.${ident(table)} ${parsed.where} returning *`;
    const { rows } = await query(sql, parsed.params);
    return reply.send(rows);
  });
}
