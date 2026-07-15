-- ── KobeDeploy: per-app resource limits (Coolify-style) ───────────────────
-- Idempotent migration for databases created before resource limits existed.
alter table deploy.apps add column if not exists limits_memory text;  -- e.g. '512m'
alter table deploy.apps add column if not exists limits_cpus   text;  -- e.g. '0.5'
