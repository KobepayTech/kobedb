-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║ KobeDB row-level security (RLS-style) policy engine                    ║
-- ╚══════════════════════════════════════════════════════════════════════╝
-- Policies are evaluated in the API layer (not Postgres RLS) so they apply
-- uniformly to the REST API regardless of the DB connection role.

create schema if not exists kobedb;

-- Which tables have RLS enforced. If a table is NOT listed here, the default
-- behaviour applies (open reads, authenticated writes). Once listed, ONLY the
-- operations permitted by a matching policy are allowed.
create table if not exists kobedb.rls (
  table_name text primary key,
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

-- Individual allow-rules. A request is permitted if at least one policy matches
-- its (table, action) and the caller's role is in `roles`.
create table if not exists kobedb.policies (
  id           bigint generated always as identity primary key,
  table_name   text not null,
  action       text not null check (action in ('select','insert','update','delete')),
  roles        text[] not null default '{authenticated}',  -- e.g. {anon,authenticated}
  -- When set, rows are scoped to the caller: reads/updates/deletes are filtered
  -- to `owner_column = <auth uid>`, and inserts force that column to the uid.
  owner_column text,
  name         text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_policies_lookup on kobedb.policies(table_name, action);

-- Convenience: enable RLS on the sample todos table and add owner-scoped policies
-- so each user only sees and edits their own rows.
insert into kobedb.rls (table_name, enabled) values ('todos', true)
  on conflict (table_name) do nothing;

insert into kobedb.policies (table_name, action, roles, owner_column, name) values
  ('todos', 'select', '{authenticated}', 'user_id', 'todos are private to owner'),
  ('todos', 'insert', '{authenticated}', 'user_id', 'owner set from auth uid'),
  ('todos', 'update', '{authenticated}', 'user_id', 'owner can update'),
  ('todos', 'delete', '{authenticated}', 'user_id', 'owner can delete')
  on conflict do nothing;
