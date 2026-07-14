-- ── Per-column RLS: add a column allow-list to policies ───────────────────
-- Idempotent migration for databases created before per-column policies existed.
alter table kobedb.policies add column if not exists columns text[];
