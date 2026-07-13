import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { query } from '../db.js';
import { resolveAuth } from '../auth/middleware.js';
import { config } from '../config.js';

// Resolve the on-disk path for an object, guarding against path traversal.
function objectPath(bucket: string, name: string): string {
  const safeName = name.replace(/\\/g, '/').replace(/\.\.(\/|$)/g, '');
  const full = path.resolve(config.storagePath, bucket, safeName);
  const root = path.resolve(config.storagePath, bucket);
  if (!full.startsWith(root)) {
    throw Object.assign(new Error('invalid object path'), { statusCode: 400 });
  }
  return full;
}

export async function storageRoutes(app: FastifyInstance) {
  // ── Buckets ──────────────────────────────────────────────────────────────
  app.get('/storage/v1/bucket', async () => {
    const { rows } = await query(`select * from storage.buckets order by created_at`);
    return rows;
  });

  app.post('/storage/v1/bucket', async (req, reply) => {
    const ctx = resolveAuth(req);
    if (ctx.role === 'anon') return reply.code(401).send({ error: 'authentication required' });
    const { id, public: isPublic } = (req.body ?? {}) as any;
    if (!id) return reply.code(400).send({ error: 'bucket id required' });
    await query(
      `insert into storage.buckets (id, public) values ($1, $2)
       on conflict (id) do update set public = excluded.public`,
      [id, !!isPublic],
    );
    await fs.mkdir(path.resolve(config.storagePath, id), { recursive: true });
    return reply.code(201).send({ id, public: !!isPublic });
  });

  app.delete('/storage/v1/bucket/:bucket', async (req, reply) => {
    const ctx = resolveAuth(req);
    if (ctx.role !== 'service_role') return reply.code(403).send({ error: 'service role required' });
    const { bucket } = req.params as any;
    await query(`delete from storage.buckets where id = $1`, [bucket]);
    await fs.rm(path.resolve(config.storagePath, bucket), { recursive: true, force: true });
    return reply.code(204).send();
  });

  // ── Objects ──────────────────────────────────────────────────────────────
  // List objects in a bucket
  app.get('/storage/v1/object/list/:bucket', async (req, reply) => {
    const { bucket } = req.params as any;
    const { rows } = await query(
      `select id, name, size, mime_type, created_at, updated_at
         from storage.objects where bucket_id = $1 order by name`,
      [bucket],
    );
    return reply.send(rows);
  });

  // Upload (raw body). Path: /storage/v1/object/:bucket/*  where * is the object name.
  app.put('/storage/v1/object/:bucket/*', async (req, reply) => {
    const ctx = resolveAuth(req);
    if (ctx.role === 'anon') return reply.code(401).send({ error: 'authentication required' });
    const { bucket } = req.params as any;
    const name = (req.params as any)['*'];

    const b = await query(`select 1 from storage.buckets where id = $1`, [bucket]);
    if (!b.rowCount) return reply.code(404).send({ error: 'bucket not found' });

    const dest = objectPath(bucket, name);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const buf = req.body as Buffer;
    await fs.writeFile(dest, buf);
    const mime = (req.headers['content-type'] as string) ?? 'application/octet-stream';

    await query(
      `insert into storage.objects (bucket_id, name, size, mime_type, owner)
       values ($1, $2, $3, $4, $5)
       on conflict (bucket_id, name)
       do update set size = excluded.size, mime_type = excluded.mime_type, updated_at = now()`,
      [bucket, name, buf.length, mime, ctx.userId],
    );
    return reply.code(201).send({ bucket, name, size: buf.length, mime_type: mime });
  });

  // Download
  app.get('/storage/v1/object/:bucket/*', async (req, reply) => {
    const { bucket } = req.params as any;
    const name = (req.params as any)['*'];

    const { rows } = await query(
      `select o.*, b.public from storage.objects o
         join storage.buckets b on b.id = o.bucket_id
        where o.bucket_id = $1 and o.name = $2`,
      [bucket, name],
    );
    if (!rows.length) return reply.code(404).send({ error: 'object not found' });
    const obj = rows[0];

    if (!obj.public) {
      const ctx = resolveAuth(req);
      if (ctx.role === 'anon') return reply.code(401).send({ error: 'authentication required' });
    }

    const filePath = objectPath(bucket, name);
    try {
      await fs.access(filePath);
    } catch {
      return reply.code(404).send({ error: 'object data missing' });
    }
    reply.header('content-type', obj.mime_type ?? 'application/octet-stream');
    return reply.send(createReadStream(filePath));
  });

  // Delete
  app.delete('/storage/v1/object/:bucket/*', async (req, reply) => {
    const ctx = resolveAuth(req);
    if (ctx.role === 'anon') return reply.code(401).send({ error: 'authentication required' });
    const { bucket } = req.params as any;
    const name = (req.params as any)['*'];
    await query(`delete from storage.objects where bucket_id = $1 and name = $2`, [bucket, name]);
    await fs.rm(objectPath(bucket, name), { force: true });
    return reply.code(204).send();
  });
}
