import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { config, moduleDir } from './config.js';
import { pool } from './db.js';
import { authRoutes } from './auth/routes.js';
import { authExtraRoutes } from './auth/extra-routes.js';
import { restRoutes } from './rest/routes.js';
import { policyAdminRoutes } from './rest/admin.js';
import { storageRoutes } from './storage/routes.js';
import { realtimePlugin } from './realtime/index.js';
import { functionRoutes } from './functions/routes.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  bodyLimit: 50 * 1024 * 1024, // 50MB for uploads
});

// Buffer raw bodies for binary uploads (storage). JSON/text keep default parsers.
app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
  done(null, body);
});

async function main() {
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // Centralised error shape.
  app.setErrorHandler((err: any, _req, reply) => {
    const status = err?.statusCode ?? 500;
    if (status >= 500) app.log.error({ err }, 'unhandled error');
    reply.code(status).send({ error: err?.message ?? 'internal error' });
  });

  // Health + service metadata.
  app.get('/health', async () => {
    await pool.query('select 1');
    return { status: 'ok', service: 'kobedb', ts: Date.now() };
  });
  app.get('/', async () => ({
    name: 'KobeDB',
    version: '0.1.0',
    endpoints: {
      auth: '/auth/v1',
      rest: '/rest/v1',
      storage: '/storage/v1',
      realtime: 'ws://<host>/realtime/v1',
      functions: '/functions/v1',
      studio: config.studioEnabled ? '/studio' : null,
      health: '/health',
    },
  }));

  await app.register(authRoutes);
  await app.register(authExtraRoutes);
  await app.register(restRoutes);
  await app.register(policyAdminRoutes);
  await app.register(storageRoutes);
  await app.register(realtimePlugin);
  await app.register(functionRoutes);

  // Studio dashboard (static, zero-build).
  if (config.studioEnabled) {
    const studioDir = path.join(moduleDir, 'studio');
    if (fs.existsSync(studioDir)) {
      await app.register(fastifyStatic, { root: studioDir, prefix: '/studio/' });
      app.get('/studio', (_req, reply) => reply.redirect('/studio/'));
    } else {
      app.log.warn(`studio assets not found at ${studioDir}`);
    }
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`KobeDB ready at ${config.publicUrl}`);
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
