import type { FastifyInstance } from 'fastify';
import { query, assertTable, ident, getPublicTables } from '../db.js';
import { resolveAuth, type AuthContext } from '../auth/middleware.js';
import { parseQuery, type ParsedQuery } from './filters.js';
import { evaluate, type PolicyDecision } from './policy.js';

/**
 * Auto-generated REST API over every table in the `public` schema.
 *
 *   GET    /rest/v1/:table         list rows (with filters)
 *   POST   /rest/v1/:table         insert row(s)
 *   PATCH  /rest/v1/:table         update rows matching filters
 *   DELETE /rest/v1/:table         delete rows matching filters
 *
 * Access is governed by the policy engine (see rest/policy.ts). Tables without
 * RLS keep the default: open reads, authenticated writes. Tables with RLS only
 * permit operations allowed by a matching policy, optionally scoped to the owner.
 */

// Append `ownerColumn = <userId>` to a parsed WHERE clause, returning fresh SQL + params.
function withOwnerScope(
  where: string,
  params: any[],
  ownerColumn: string | null,
  userId: string | null,
): { where: string; params: any[] } {
  if (!ownerColumn || !userId) return { where, params };
  const next = [...params];
  next.push(userId);
  const cond = `${ident(ownerColumn)} = $${next.length}`;
  return { where: where ? `${where} and ${cond}` : `where ${cond}`, params: next };
}

// Columns returned by insert/update, respecting a write policy's column allow-list.
function returningCols(decision: PolicyDecision): string {
  if (!decision.columns) return '*';
  const set = new Set(decision.columns);
  if (decision.ownerColumn) set.add(decision.ownerColumn);
  const list = [...set];
  return list.length ? list.map(ident).join(', ') : '*';
}

// Reject writes to columns outside a write policy's allow-list (the owner column,
// which the server sets itself, is always permitted).
function assertWritableColumns(keys: string[], decision: PolicyDecision) {
  if (!decision.columns) return;
  const allowed = new Set(decision.columns);
  if (decision.ownerColumn) allowed.add(decision.ownerColumn);
  const bad = keys.filter((k) => !allowed.has(k));
  if (bad.length)
    throw Object.assign(new Error(`not permitted to write column(s): ${bad.join(', ')}`), { statusCode: 403 });
}

async function gate(
  table: string,
  action: 'select' | 'insert' | 'update' | 'delete',
  ctx: AuthContext,
): Promise<PolicyDecision> {
  const decision = await evaluate(table, action, ctx);
  if (!decision.allowed) {
    throw Object.assign(new Error(decision.reason ?? 'forbidden'), { statusCode: 403 });
  }
  // Legacy default gate for non-RLS tables: writes require a user or service role.
  if (!decision.rlsManaged && action !== 'select' && ctx.role === 'anon') {
    throw Object.assign(new Error(`authentication required to ${action}`), { statusCode: 401 });
  }
  return decision;
}

export async function restRoutes(app: FastifyInstance) {
  // Introspection: list available tables + columns.
  app.get('/rest/v1/', async () => {
    const tables = await getPublicTables();
    return Object.fromEntries([...tables].map(([t, cols]) => [t, [...cols]]));
  });

  app.get('/rest/v1/:table', async (req, reply) => {
    const { table } = req.params as { table: string };
    const ctx = resolveAuth(req);
    const cols = await assertTable(table);
    const decision = await gate(table, 'select', ctx);
    const parsed: ParsedQuery = parseQuery(req.query as any, cols);

    // Enforce a read policy's column allow-list.
    let selectSql = parsed.select;
    if (decision.columns) {
      const allowed = new Set(decision.columns);
      const q = req.query as any;
      const requested: string[] = q.select
        ? String(Array.isArray(q.select) ? q.select[0] : q.select).split(',').map((s) => s.trim()).filter(Boolean)
        : [...cols];
      if (q.select) {
        const denied = requested.filter((c) => !allowed.has(c));
        if (denied.length)
          return reply.code(403).send({ error: `not permitted to read column(s): ${denied.join(', ')}` });
      }
      const readable = requested.filter((c) => allowed.has(c));
      if (!readable.length) return reply.code(403).send({ error: 'no readable columns for this role' });
      selectSql = readable.map(ident).join(', ');
    }

    const scoped = withOwnerScope(parsed.where, parsed.params, decision.ownerColumn, ctx.userId);
    let sql = `select ${selectSql} from public.${ident(table)} ${scoped.where}`;
    if (parsed.orderBy) sql += ` order by ${parsed.orderBy}`;
    if (parsed.limit != null) sql += ` limit ${parsed.limit}`;
    if (parsed.offset != null) sql += ` offset ${parsed.offset}`;

    const { rows } = await query(sql, scoped.params);

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
    const decision = await gate(table, 'insert', ctx);

    const cols = await assertTable(table);
    const body = req.body as any;
    const records: Record<string, any>[] = Array.isArray(body) ? body : [body];
    if (!records.length) return reply.code(400).send({ error: 'no rows provided' });

    // Owner-scoped insert: force the owner column to the caller's uid.
    if (decision.ownerColumn && ctx.userId) {
      for (const rec of records) rec[decision.ownerColumn] = ctx.userId;
    }

    const keys = [...new Set(records.flatMap((r) => Object.keys(r)))];
    for (const k of keys) {
      if (!cols.has(k)) return reply.code(400).send({ error: `unknown column: ${k}` });
    }
    assertWritableColumns(keys, decision);

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

    const sql = `insert into public.${ident(table)} (${colList}) values ${valuesSql.join(', ')} returning ${returningCols(decision)}`;
    const { rows } = await query(sql, params);
    return reply.code(201).send(Array.isArray(body) ? rows : rows[0]);
  });

  app.patch('/rest/v1/:table', async (req, reply) => {
    const { table } = req.params as { table: string };
    const ctx = resolveAuth(req);
    const decision = await gate(table, 'update', ctx);

    const cols = await assertTable(table);
    const parsed = parseQuery(req.query as any, cols);
    // An owner scope is itself a safety filter; otherwise require an explicit one.
    if (!parsed.where && !decision.ownerColumn)
      return reply.code(400).send({ error: 'refusing to update without a filter' });

    const patch = req.body as Record<string, any>;
    const keys = Object.keys(patch ?? {});
    if (!keys.length) return reply.code(400).send({ error: 'no fields to update' });
    for (const k of keys) if (!cols.has(k)) return reply.code(400).send({ error: `unknown column: ${k}` });
    assertWritableColumns(keys, decision);

    const scoped = withOwnerScope(parsed.where, parsed.params, decision.ownerColumn, ctx.userId);
    const params = [...scoped.params];
    let p = params.length;
    const setSql = keys
      .map((k) => {
        params.push(patch[k]);
        return `${ident(k)} = $${++p}`;
      })
      .join(', ');

    const sql = `update public.${ident(table)} set ${setSql} ${scoped.where} returning ${returningCols(decision)}`;
    const { rows } = await query(sql, params);
    return reply.send(rows);
  });

  app.delete('/rest/v1/:table', async (req, reply) => {
    const { table } = req.params as { table: string };
    const ctx = resolveAuth(req);
    const decision = await gate(table, 'delete', ctx);

    const cols = await assertTable(table);
    const parsed = parseQuery(req.query as any, cols);
    if (!parsed.where && !decision.ownerColumn)
      return reply.code(400).send({ error: 'refusing to delete without a filter' });

    const scoped = withOwnerScope(parsed.where, parsed.params, decision.ownerColumn, ctx.userId);
    const sql = `delete from public.${ident(table)} ${scoped.where} returning *`;
    const { rows } = await query(sql, scoped.params);
    return reply.send(rows);
  });
}
