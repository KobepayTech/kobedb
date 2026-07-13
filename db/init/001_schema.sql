-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║ KobeDB core schema                                                    ║
-- ║ Runs automatically on first container start (docker-entrypoint-initdb)║
-- ╚══════════════════════════════════════════════════════════════════════╝

create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ── auth schema ──────────────────────────────────────────────────────────
create schema if not exists auth;

create table if not exists auth.users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  password_hash text not null,
  role          text not null default 'authenticated',
  metadata      jsonb not null default '{}'::jsonb,
  email_confirmed_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists auth.refresh_tokens (
  token      text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  revoked    boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_refresh_tokens_user on auth.refresh_tokens(user_id);

-- ── storage schema ───────────────────────────────────────────────────────
create schema if not exists storage;

create table if not exists storage.buckets (
  id         text primary key,
  public     boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text not null references storage.buckets(id) on delete cascade,
  name       text not null,
  size       bigint not null default 0,
  mime_type  text,
  owner      uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket_id, name)
);

create index if not exists idx_objects_bucket on storage.objects(bucket_id);

-- ── realtime: broadcast row changes via NOTIFY ───────────────────────────
-- Any table with this trigger emits JSON change events on the 'kobedb_realtime'
-- channel. The server LISTENs and fans out to subscribed WebSocket clients.
create or replace function public.kobedb_notify_change()
returns trigger language plpgsql as $$
declare
  payload json;
  rec      record;
begin
  if (tg_op = 'DELETE') then
    rec := old;
  else
    rec := new;
  end if;
  payload := json_build_object(
    'schema', tg_table_schema,
    'table',  tg_table_name,
    'type',   tg_op,
    'record', case when tg_op = 'DELETE' then null else row_to_json(new) end,
    'old',    case when tg_op = 'INSERT' then null else row_to_json(old) end,
    'ts',     extract(epoch from now())
  );
  perform pg_notify('kobedb_realtime', payload::text);
  return rec;
end;
$$;

-- Helper to enable realtime on a table: select public.kobedb_enable_realtime('public','todos');
create or replace function public.kobedb_enable_realtime(p_schema text, p_table text)
returns void language plpgsql as $$
declare trig_name text := 'kobedb_realtime_' || p_table;
begin
  execute format('drop trigger if exists %I on %I.%I', trig_name, p_schema, p_table);
  execute format(
    'create trigger %I after insert or update or delete on %I.%I
       for each row execute function public.kobedb_notify_change()',
    trig_name, p_schema, p_table
  );
end;
$$;
