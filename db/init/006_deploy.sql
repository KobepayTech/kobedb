-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║ KobeDeploy — a Coolify-style app platform on top of KobeDB             ║
-- ║ Projects group apps; apps deploy from a Docker image or a git repo;    ║
-- ║ deployments capture each build/run with status + logs.                 ║
-- ╚══════════════════════════════════════════════════════════════════════╝

create schema if not exists deploy;

create table if not exists deploy.projects (
  id         uuid primary key default gen_random_uuid(),
  name       text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists deploy.apps (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references deploy.projects(id) on delete cascade,
  name          text not null,
  -- 'image' → run a prebuilt image; 'git' → clone + docker build the Dockerfile
  source_type   text not null default 'image' check (source_type in ('image','git')),
  source        text not null,              -- image ref, or git URL
  git_ref       text default 'main',
  dockerfile    text default 'Dockerfile',
  container_port integer not null default 8080,   -- port the app listens on inside the container
  env           jsonb not null default '{}'::jsonb,
  domain        text unique,                -- hostname routed to this app by the proxy
  -- persistent volumes: array of { "host": "...", "container": "..." } (Coolify-style)
  volumes       jsonb not null default '[]'::jsonb,
  -- health check (Coolify-style): after start, poll this path until it returns the
  -- expected status before marking the app healthy/running.
  health_check_path            text,
  health_check_expected_status integer not null default 200,
  health_check_retries         integer not null default 10,
  -- runtime state
  status        text not null default 'created'
                  check (status in ('created','building','running','unhealthy','stopped','failed')),
  host_port     integer,                    -- published host port the proxy forwards to
  container_id  text,
  image_tag     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (project_id, name)
);

create index if not exists idx_apps_project on deploy.apps(project_id);
create index if not exists idx_apps_domain on deploy.apps(domain);

create table if not exists deploy.deployments (
  id          uuid primary key default gen_random_uuid(),
  app_id      uuid not null references deploy.apps(id) on delete cascade,
  status      text not null default 'pending'
                check (status in ('pending','building','running','failed','stopped')),
  image_tag   text,
  logs        text not null default '',
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists idx_deployments_app on deploy.deployments(app_id);
