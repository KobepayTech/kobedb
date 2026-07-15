import type { FastifyInstance } from 'fastify';
import { query, ident } from '../db.js';
import { config } from '../config.js';
import { resolveAuth } from '../auth/middleware.js';
import { activeDeployRuntime } from './runtime.js';
import { deployApp, stopApp, startApp, destroyApp, appLogs, refreshStatus, type App } from './service.js';

// Build a connection URL for a provisioned database by swapping the db name.
function connectionUrlFor(dbName: string): string {
  try {
    const u = new URL(config.databaseUrl);
    u.pathname = `/${dbName}`;
    return u.toString();
  } catch {
    return config.databaseUrl.replace(/\/[^/]*$/, `/${dbName}`);
  }
}

// KobeDeploy management API. Service-role only (like /admin/*).
export async function deployRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/deploy/')) return;
    const ctx = resolveAuth(req);
    if (ctx.role !== 'service_role') return reply.code(403).send({ error: 'service role required' });
  });

  app.get('/deploy/v1', async () => ({ runtime: activeDeployRuntime() }));

  // ── Projects ───────────────────────────────────────────────────────────────
  app.get('/deploy/v1/projects', async () => {
    const { rows } = await query(`select * from deploy.projects order by created_at`);
    return rows;
  });

  app.post('/deploy/v1/projects', async (req, reply) => {
    const { name } = (req.body ?? {}) as any;
    if (!name) return reply.code(400).send({ error: 'name required' });
    const { rows } = await query(
      `insert into deploy.projects (name) values ($1)
       on conflict (name) do update set name = excluded.name returning *`,
      [name],
    );
    return reply.code(201).send(rows[0]);
  });

  app.delete('/deploy/v1/projects/:id', async (req, reply) => {
    await query(`delete from deploy.projects where id = $1`, [(req.params as any).id]);
    return reply.code(204).send();
  });

  // Provision a dedicated Postgres database for a project (Coolify-style managed DB).
  app.post('/deploy/v1/projects/:id/database', async (req, reply) => {
    const { rows } = await query<{ name: string }>(`select name from deploy.projects where id = $1`, [
      (req.params as any).id,
    ]);
    if (!rows.length) return reply.code(404).send({ error: 'project not found' });
    const dbName = `app_${rows[0].name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
    ident(dbName); // validate before interpolating into DDL
    const exists = await query(`select 1 from pg_database where datname = $1`, [dbName]);
    if (!exists.rowCount) {
      // CREATE DATABASE cannot run inside a transaction block; pool.query runs it standalone.
      await query(`create database ${ident(dbName)}`);
    }
    return reply.code(201).send({ database: dbName, connection_url: connectionUrlFor(dbName) });
  });

  // ── Apps ─────────────────────────────────────────────────────────────────────
  app.get('/deploy/v1/apps', async (req) => {
    const { project_id } = req.query as any;
    const { rows } = await query<App>(
      project_id
        ? `select * from deploy.apps where project_id = $1 order by created_at`
        : `select * from deploy.apps order by created_at`,
      project_id ? [project_id] : [],
    );
    // Reflect real container state.
    for (const a of rows) a.status = await refreshStatus(a);
    return rows;
  });

  app.post('/deploy/v1/apps', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    if (!b.project_id || !b.name || !b.source)
      return reply.code(400).send({ error: 'project_id, name and source are required' });
    if (b.source_type && !['image', 'git'].includes(b.source_type))
      return reply.code(400).send({ error: 'source_type must be image or git' });
    const { rows } = await query(
      `insert into deploy.apps
         (project_id, name, source_type, source, git_ref, dockerfile, container_port, env, domain,
          volumes, health_check_path, health_check_expected_status, health_check_retries,
          limits_memory, limits_cpus)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
      [
        b.project_id,
        b.name,
        b.source_type ?? 'image',
        b.source,
        b.git_ref ?? 'main',
        b.dockerfile ?? 'Dockerfile',
        b.container_port ?? 8080,
        b.env ?? {},
        b.domain ?? null,
        JSON.stringify(Array.isArray(b.volumes) ? b.volumes : []),
        b.health_check_path ?? null,
        b.health_check_expected_status ?? 200,
        b.health_check_retries ?? 10,
        b.limits_memory ?? null,
        b.limits_cpus ?? null,
      ],
    );
    return reply.code(201).send(rows[0]);
  });

  app.get('/deploy/v1/apps/:id', async (req, reply) => {
    const { rows } = await query<App>(`select * from deploy.apps where id = $1`, [(req.params as any).id]);
    if (!rows.length) return reply.code(404).send({ error: 'app not found' });
    rows[0].status = await refreshStatus(rows[0]);
    return rows[0];
  });

  // Update env vars / domain / source.
  app.patch('/deploy/v1/apps/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const b = (req.body ?? {}) as any;
    const allowed = ['env', 'domain', 'source', 'source_type', 'git_ref', 'dockerfile', 'container_port',
      'volumes', 'health_check_path', 'health_check_expected_status', 'health_check_retries',
      'limits_memory', 'limits_cpus'];
    const keys = Object.keys(b).filter((k) => allowed.includes(k));
    if (!keys.length) return reply.code(400).send({ error: 'no updatable fields' });
    const jsonCols = new Set(['env', 'volumes']);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await query(
      `update deploy.apps set ${set}, updated_at = now() where id = $1 returning *`,
      [id, ...keys.map((k) => (jsonCols.has(k) ? JSON.stringify(b[k]) : b[k]))],
    );
    if (!rows.length) return reply.code(404).send({ error: 'app not found' });
    return rows[0];
  });

  // ── Actions ──────────────────────────────────────────────────────────────────
  app.post('/deploy/v1/apps/:id/deploy', async (req, reply) => {
    const deploymentId = await deployApp((req.params as any).id);
    return reply.code(202).send({ deployment_id: deploymentId, status: 'building' });
  });

  app.post('/deploy/v1/apps/:id/stop', async (req, reply) => {
    await stopApp((req.params as any).id);
    return reply.send({ status: 'stopped' });
  });

  app.post('/deploy/v1/apps/:id/restart', async (req, reply) => {
    const deploymentId = await startApp((req.params as any).id);
    return reply.code(202).send({ deployment_id: deploymentId, status: 'building' });
  });

  app.delete('/deploy/v1/apps/:id', async (req, reply) => {
    await destroyApp((req.params as any).id);
    return reply.code(204).send();
  });

  app.get('/deploy/v1/apps/:id/logs', async (req, reply) => {
    reply.header('content-type', 'text/plain');
    return reply.send(await appLogs((req.params as any).id));
  });

  // ── Deployments (build/run history) ──────────────────────────────────────────
  app.get('/deploy/v1/apps/:id/deployments', async (req) => {
    const { rows } = await query(
      `select id, status, image_tag, created_at, finished_at
         from deploy.deployments where app_id = $1 order by created_at desc limit 50`,
      [(req.params as any).id],
    );
    return rows;
  });

  app.get('/deploy/v1/deployments/:id', async (req, reply) => {
    const { rows } = await query(`select * from deploy.deployments where id = $1`, [(req.params as any).id]);
    if (!rows.length) return reply.code(404).send({ error: 'deployment not found' });
    return rows[0];
  });
}
