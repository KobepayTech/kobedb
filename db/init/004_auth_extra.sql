-- ── Extra auth tables: passwordless magic links + OAuth identities ────────

-- One-time tokens for magic-link / passwordless sign-in.
create table if not exists auth.one_time_tokens (
  token      text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  type       text not null default 'magiclink',
  used       boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ott_user on auth.one_time_tokens(user_id);

-- Linked OAuth identities (a user may sign in with multiple providers).
create table if not exists auth.identities (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  provider     text not null,                 -- 'google' | 'github' | ...
  provider_uid text not null,                 -- the id at the provider
  identity_data jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  unique (provider, provider_uid)
);

-- Password may be null for users who only use OAuth / magic links.
alter table auth.users alter column password_hash drop not null;
