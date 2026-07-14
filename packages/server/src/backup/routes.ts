import type { FastifyInstance } from 'fastify';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

// Backups use PostgreSQL's own tools (pg_dump custom format + pg_restore), so
// restores are transactional and portable. The client tools must be installed
// (the server Docker image adds `postgresql-client`).

const FILE_RE = /^[a-zA-Z0-9._-]+\.dump$/;

function toolAvailable(bin: string): boolean {
  try {
    return spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

function safeBackupPath(file: string): string {
  const base = path.basename(file);
  if (!FILE_RE.test(base)) throw Object.assign(new Error('invalid backup filename'), { statusCode: 400 });
  return path.join(path.resolve(config.backupDir), base);
}

// Run a command, capturing stderr; resolve on exit 0, reject otherwise.
function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(Object.assign(e, { statusCode: 500 })));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(Object.assign(new Error(err || `${bin} exited ${code}`), { statusCode: 500 })),
    );
  });
}

export function registerBackupRoutes(app: FastifyInstance) {
  // Create a backup (pg_dump, custom format).
  app.post('/admin/backups', async (req, reply) => {
    if (!toolAvailable('pg_dump'))
      return reply.code(501).send({ error: 'pg_dump not available on the server (install postgresql-client)' });
    await fs.mkdir(path.resolve(config.backupDir), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `kobedb-${stamp}.dump`;
    const full = safeBackupPath(file);
    await run('pg_dump', ['-d', config.databaseUrl, '-Fc', '-f', full]);
    const stat = await fs.stat(full);
    return reply.code(201).send({ file, size: stat.size, created_at: stat.mtime });
  });

  // List backups.
  app.get('/admin/backups', async () => {
    try {
      const names = await fs.readdir(path.resolve(config.backupDir));
      const files = await Promise.all(
        names
          .filter((n) => FILE_RE.test(n))
          .map(async (n) => {
            const st = await fs.stat(path.join(path.resolve(config.backupDir), n));
            return { file: n, size: st.size, created_at: st.mtime };
          }),
      );
      files.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
      return { backups: files, pg_dump: toolAvailable('pg_dump') };
    } catch {
      return { backups: [], pg_dump: toolAvailable('pg_dump') };
    }
  });

  // Download a backup file.
  app.get('/admin/backups/:file/download', async (req, reply) => {
    const full = safeBackupPath((req.params as any).file);
    try {
      await fs.access(full);
    } catch {
      return reply.code(404).send({ error: 'backup not found' });
    }
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${path.basename(full)}"`);
    return reply.send(createReadStream(full));
  });

  // Restore from a backup (pg_restore --clean). Destructive — service-role only (guarded upstream).
  app.post('/admin/backups/:file/restore', async (req, reply) => {
    if (!toolAvailable('pg_restore'))
      return reply.code(501).send({ error: 'pg_restore not available on the server (install postgresql-client)' });
    const full = safeBackupPath((req.params as any).file);
    try {
      await fs.access(full);
    } catch {
      return reply.code(404).send({ error: 'backup not found' });
    }
    await run('pg_restore', ['-d', config.databaseUrl, '--clean', '--if-exists', '--no-owner', full]);
    return reply.send({ restored: path.basename(full) });
  });

  // Delete a backup.
  app.delete('/admin/backups/:file', async (req, reply) => {
    const full = safeBackupPath((req.params as any).file);
    await fs.rm(full, { force: true });
    return reply.code(204).send();
  });
}
