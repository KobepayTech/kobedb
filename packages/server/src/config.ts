import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Load .env from the repo root if present.
dotenv.config();

const num = (v: string | undefined, d: number) => (v ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 8000),
  host: process.env.HOST ?? '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:8000',

  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://kobedb:kobedb@localhost:5432/kobedb',

  jwtSecret: process.env.JWT_SECRET ?? 'super-secret-change-me-please-32-chars-min',
  jwtAccessTtl: num(process.env.JWT_ACCESS_TTL, 3600),
  jwtRefreshTtl: num(process.env.JWT_REFRESH_TTL, 60 * 60 * 24 * 30),

  serviceRoleKey: process.env.SERVICE_ROLE_KEY ?? 'service-role-change-me',

  storagePath: process.env.STORAGE_PATH ?? './storage-data',

  functionsPath: process.env.FUNCTIONS_PATH ?? './functions',
  functionTimeoutMs: num(process.env.FUNCTION_TIMEOUT_MS, 10000),

  studioEnabled: (process.env.STUDIO_ENABLED ?? 'true') !== 'false',
};

// Directory of the server package's source/dist, for serving static studio assets.
export const moduleDir = path.dirname(fileURLToPath(import.meta.url));
