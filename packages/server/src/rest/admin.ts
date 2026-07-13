import type { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { resolveAuth } from '../auth/middleware.js';
import { invalidatePolicyCache } from './policy.js';

// Admin API for the RLS policy engine. Service-role only.
export async function policyAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/admin/')) return;
    const ctx = resolveAuth(req);
    if (ctx.role !== 'service_role') {
      return reply.code(403).send({ error: 'service role required' });
    }
  });

  // List RLS config + policies.
  app.get('/admin/policies', async () => {
    const rls = await query(`select * from kobedb.rls order by table_name`);
    const policies = await query(`select * from kobedb.policies order by table_name, action`);
    return { rls: rls.rows, policies: policies.rows };
  });

  // Enable/disable RLS on a table.  { table, enabled }
  app.post('/admin/rls', async (req, reply) => {
    const { table, enabled } = (req.body ?? {}) as any;
    if (!table) return reply.code(400).send({ error: 'table required' });
    await query(
      `insert into kobedb.rls (table_name, enabled) values ($1, $2)
       on conflict (table_name) do update set enabled = excluded.enabled`,
      [table, enabled !== false],
    );
    invalidatePolicyCache();
    return { table, enabled: enabled !== false };
  });

  // Create a policy.  { table, action, roles?, owner_column?, name? }
  app.post('/admin/policies', async (req, reply) => {
    const { table, action, roles, owner_column, name } = (req.body ?? {}) as any;
    if (!table || !action) return reply.code(400).send({ error: 'table and action required' });
    if (!['select', 'insert', 'update', 'delete'].includes(action))
      return reply.code(400).send({ error: 'invalid action' });
    const { rows } = await query(
      `insert into kobedb.policies (table_name, action, roles, owner_column, name)
       values ($1, $2, $3, $4, $5) returning *`,
      [table, action, roles ?? ['authenticated'], owner_column ?? null, name ?? null],
    );
    invalidatePolicyCache();
    return reply.code(201).send(rows[0]);
  });

  // Delete a policy by id.
  app.delete('/admin/policies/:id', async (req, reply) => {
    const { id } = req.params as any;
    await query(`delete from kobedb.policies where id = $1`, [id]);
    invalidatePolicyCache();
    return reply.code(204).send();
  });
}
