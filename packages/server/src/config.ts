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

  // Storage backend: 'local' (filesystem) or 's3' (S3-compatible).
  storageBackend: (process.env.STORAGE_BACKEND ?? 'local') as 'local' | 's3',
  s3Bucket: process.env.S3_BUCKET ?? '',
  s3Region: process.env.S3_REGION ?? 'us-east-1',
  s3Endpoint: process.env.S3_ENDPOINT ?? '',
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
  s3Prefix: process.env.S3_PREFIX ?? '',
  s3ForcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') !== 'false',

  backupDir: process.env.BACKUP_DIR ?? './backups',

  // KobeDeploy (Coolify-style app platform)
  deployRuntime: (process.env.DEPLOY_RUNTIME ?? 'auto') as 'auto' | 'docker' | 'mock',
  deployProxyEnabled: (process.env.DEPLOY_PROXY_ENABLED ?? 'true') !== 'false',
  deployProxyPort: num(process.env.DEPLOY_PROXY_PORT, 8090),

  functionsPath: process.env.FUNCTIONS_PATH ?? './functions',
  functionTimeoutMs: num(process.env.FUNCTION_TIMEOUT_MS, 10000),
  // 'auto' uses Deno if the binary is present, else worker threads. Force with 'deno' | 'worker'.
  functionsRuntime: (process.env.FUNCTIONS_RUNTIME ?? 'auto') as 'auto' | 'deno' | 'worker',

  // Email delivery for magic links: 'log' (default, prints to console), 'smtp', or 'resend'.
  emailProvider: (process.env.EMAIL_PROVIDER ?? 'log') as 'log' | 'smtp' | 'resend',
  emailFrom: process.env.EMAIL_FROM ?? 'KobeDB <no-reply@kobedb.local>',
  smtpHost: process.env.SMTP_HOST ?? 'localhost',
  smtpPort: num(process.env.SMTP_PORT, 587),
  smtpSecure: (process.env.SMTP_SECURE ?? 'false') === 'true',
  smtpUser: process.env.SMTP_USER ?? '',
  smtpPass: process.env.SMTP_PASS ?? '',
  resendApiKey: process.env.RESEND_API_KEY ?? '',

  studioEnabled: (process.env.STUDIO_ENABLED ?? 'true') !== 'false',
};

// Directory of the server package's source/dist, for serving static studio assets.
export const moduleDir = path.dirname(fileURLToPath(import.meta.url));
